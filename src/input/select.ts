/**
 * Ties config (`InputFidelity`, R-13) to a concrete tier, and gives the
 * orchestrator one ref-based façade (`RunInput`) regardless of which kind of
 * tier is active underneath.
 */
import type { InputFidelity } from '@/src/storage';
import { jitterInBox } from './humanize';
import type { ClickOptions, InputTier, PressOptions } from './types';
import type { ElementRef, RefInputTier } from './inpage';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type GetBox = (ref: ElementRef) => Promise<Box>;

export interface SelectTierOptions {
  /** The default tier (R-13). */
  inPageTier: RefInputTier;
  /** The escalated, trusted-input tier `InputFidelity: 'escalated'` maps to.
   * (Routing to the future `os` tier is a later decision — `InputFidelity`
   * only distinguishes in-page vs. escalated today.) */
  debuggerTier: InputTier;
}

/** Maps `config.inputFidelity` to the tier that should handle input (R-13). */
export function selectTier(fidelity: InputFidelity, opts: SelectTierOptions): RefInputTier | InputTier {
  return fidelity === 'escalated' ? opts.debuggerTier : opts.inPageTier;
}

/**
 * Resolves a ref to a viewport point with a small random offset, staying
 * inside the element's box — never dead-center (a bot tell per
 * docs/research/trusted-input-and-stealth.md §4) and never outside the
 * clickable area.
 */
export async function refToPoint(
  getBox: GetBox,
  ref: ElementRef,
  rng: () => number = Math.random,
): Promise<{ x: number; y: number }> {
  return jitterInBox(await getBox(ref), rng);
}

function isRefTier(tier: RefInputTier | InputTier): tier is RefInputTier {
  return tier.name === 'in-page';
}

export interface RunInputOptions {
  tier: RefInputTier | InputTier;
  getBox: GetBox;
  rng?: () => number;
}

/**
 * The façade the orchestrator drives. Every method takes an `ElementRef`;
 * for the `in-page` tier that's forwarded as-is, for a coordinate tier
 * (`debugger`/`os`) it's resolved to a point via `getBox` first.
 */
export class RunInput {
  constructor(private readonly opts: RunInputOptions) {}

  async attach(tabId: number): Promise<void> {
    await this.opts.tier.attach(tabId);
  }

  async detach(): Promise<void> {
    await this.opts.tier.detach();
  }

  isAttached(): boolean {
    return this.opts.tier.isAttached();
  }

  async click(ref: ElementRef, opts?: ClickOptions): Promise<void> {
    const tier = this.opts.tier;
    if (isRefTier(tier)) {
      await tier.click(ref, opts);
      return;
    }
    const p = await refToPoint(this.opts.getBox, ref, this.opts.rng);
    await tier.moveTo(p.x, p.y);
    await tier.click(p.x, p.y, opts);
  }

  async moveTo(ref: ElementRef): Promise<void> {
    const tier = this.opts.tier;
    if (isRefTier(tier)) {
      await tier.moveTo(ref);
      return;
    }
    const p = await refToPoint(this.opts.getBox, ref, this.opts.rng);
    await tier.moveTo(p.x, p.y);
  }

  /** For a coordinate tier, the caller is responsible for having focused
   * `ref` first (e.g. via `click`) — coordinate tiers type into whatever
   * currently has focus, not into a specific element. */
  async typeText(ref: ElementRef, text: string): Promise<void> {
    const tier = this.opts.tier;
    if (isRefTier(tier)) {
      await tier.typeText(ref, text);
      return;
    }
    await tier.typeText(text);
  }

  async press(ref: ElementRef | null, key: string, opts?: PressOptions): Promise<void> {
    const tier = this.opts.tier;
    if (isRefTier(tier)) {
      await tier.press(ref, key, opts);
      return;
    }
    await tier.press(key, opts);
  }

  async scroll(ref: ElementRef, deltaX: number, deltaY: number): Promise<void> {
    const tier = this.opts.tier;
    if (isRefTier(tier)) {
      await tier.scroll(ref, deltaX, deltaY);
      return;
    }
    const p = await refToPoint(this.opts.getBox, ref, this.opts.rng);
    await tier.scroll(p.x, p.y, deltaX, deltaY);
  }
}
