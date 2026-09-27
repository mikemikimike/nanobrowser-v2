/**
 * `debugger` input tier (R-13 escalated): CDP `Input.*` over `chrome.debugger`.
 * `isTrusted: true`. Raises Chrome's global debugging infobar — see
 * docs/research/trusted-input-and-stealth.md. Hygiene, verbatim from that doc:
 *
 * - Attach once per run segment; hold the session; detach once. Never per-action.
 * - `attach()` itself issues no CDP command — never call `Runtime.enable`,
 *   `Page.enable`, `DOM.enable`, `Emulation.*`, or anything outside `Input`.
 * - `onDetach` (e.g. the user pressed Cancel on the infobar) is a real user
 *   stop signal: mark detached, never silently re-attach, and hand the reason
 *   to the caller (via the `onDetach` option) so the run can report it through
 *   the `input.fidelity` RunEvent.
 * - `force: 0.5` on `mousePressed`/`mouseReleased` — CDP dispatches raw
 *   `pressure: 0` otherwise, a documented fingerprint (bot-detection-research.md
 *   row 6).
 */
import type { ClickOptions, InputTier, KeyModifiers, MouseButton, PressOptions } from './types';
import { planPath, sampleHold, sampleInterKey, type Point, type Rng } from './humanize';

/** CDP protocol version pinned per docs/research/trusted-input-and-stealth.md. */
export const DEBUGGER_PROTOCOL_VERSION = '1.3';

export interface DebuggerTarget {
  tabId: number;
}

/**
 * Seam over `chrome.debugger`. Production code uses `createChromeDebuggerApi()`;
 * tests use a fake that records the exact command sequence and asserts no
 * command outside the `Input` domain is ever sent.
 */
export interface DebuggerApi {
  attach(target: DebuggerTarget, requiredVersion: string): Promise<void>;
  detach(target: DebuggerTarget): Promise<void>;
  sendCommand(target: DebuggerTarget, method: string, params?: Record<string, unknown>): Promise<unknown>;
  onDetach: {
    addListener(cb: (source: DebuggerTarget, reason: string) => void): void;
    removeListener(cb: (source: DebuggerTarget, reason: string) => void): void;
  };
}

/** Wraps the real `chrome.debugger` API behind {@link DebuggerApi}. */
export function createChromeDebuggerApi(): DebuggerApi {
  const dbg = chrome.debugger;
  return {
    attach(target, requiredVersion) {
      return new Promise<void>((resolve, reject) => {
        dbg.attach(target, requiredVersion, () => {
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message));
          else resolve();
        });
      });
    },
    detach(target) {
      return new Promise<void>((resolve, reject) => {
        dbg.detach(target, () => {
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message));
          else resolve();
        });
      });
    },
    sendCommand(target, method, params) {
      return new Promise<unknown>((resolve, reject) => {
        dbg.sendCommand(target, method, params, result => {
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message));
          else resolve(result);
        });
      });
    },
    onDetach: {
      addListener(cb) {
        dbg.onDetach.addListener((source, reason) => cb({ tabId: source.tabId ?? -1 }, reason));
      },
      removeListener() {
        // chrome.debugger.onDetach wraps callbacks by identity per addListener call above;
        // production code detaches via DebuggerInputTier.detach(), which does not need to
        // remove this browser-level listener (it is a no-op past the tab's lifetime).
      },
    },
  };
}

interface NamedKey {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  text?: string;
}

/** Named keys for `press()`. Extend here, not by hand-rolling codes at call sites. */
export const NAMED_KEYS: Record<string, NamedKey> = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
};

/** Physical-key info for punctuation/digits, keyed by the *unshifted* character
 * a US keyboard produces at that key. `windowsVirtualKeyCode` names the physical
 * key, so shifted variants (e.g. `!` on the `1` key) reuse the same entry. */
const BASE_KEY_MAP: Record<string, { code: string; vk: number }> = {
  '1': { code: 'Digit1', vk: 49 }, '!': { code: 'Digit1', vk: 49 },
  '2': { code: 'Digit2', vk: 50 }, '@': { code: 'Digit2', vk: 50 },
  '3': { code: 'Digit3', vk: 51 }, '#': { code: 'Digit3', vk: 51 },
  '4': { code: 'Digit4', vk: 52 }, '$': { code: 'Digit4', vk: 52 },
  '5': { code: 'Digit5', vk: 53 }, '%': { code: 'Digit5', vk: 53 },
  '6': { code: 'Digit6', vk: 54 }, '^': { code: 'Digit6', vk: 54 },
  '7': { code: 'Digit7', vk: 55 }, '&': { code: 'Digit7', vk: 55 },
  '8': { code: 'Digit8', vk: 56 }, '*': { code: 'Digit8', vk: 56 },
  '9': { code: 'Digit9', vk: 57 }, '(': { code: 'Digit9', vk: 57 },
  '0': { code: 'Digit0', vk: 48 }, ')': { code: 'Digit0', vk: 48 },
  ' ': { code: 'Space', vk: 32 },
  ';': { code: 'Semicolon', vk: 186 }, ':': { code: 'Semicolon', vk: 186 },
  '=': { code: 'Equal', vk: 187 }, '+': { code: 'Equal', vk: 187 },
  ',': { code: 'Comma', vk: 188 }, '<': { code: 'Comma', vk: 188 },
  '-': { code: 'Minus', vk: 189 }, '_': { code: 'Minus', vk: 189 },
  '.': { code: 'Period', vk: 190 }, '>': { code: 'Period', vk: 190 },
  '/': { code: 'Slash', vk: 191 }, '?': { code: 'Slash', vk: 191 },
  '`': { code: 'Backquote', vk: 192 }, '~': { code: 'Backquote', vk: 192 },
  '[': { code: 'BracketLeft', vk: 219 }, '{': { code: 'BracketLeft', vk: 219 },
  '\\': { code: 'Backslash', vk: 220 }, '|': { code: 'Backslash', vk: 220 },
  ']': { code: 'BracketRight', vk: 221 }, '}': { code: 'BracketRight', vk: 221 },
  "'": { code: 'Quote', vk: 222 }, '"': { code: 'Quote', vk: 222 },
};

interface DerivedKeyInfo {
  key: string;
  code?: string;
  windowsVirtualKeyCode?: number;
}

/** Best-effort physical-key derivation for `typeText`. Falls back to `text`-only
 * (no `code`/`windowsVirtualKeyCode`) for characters with no US-layout key, per
 * "where derivable" in the build spec. */
function deriveKeyInfo(ch: string): DerivedKeyInfo {
  if (/^[a-zA-Z]$/.test(ch)) {
    return { key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) };
  }
  const base = BASE_KEY_MAP[ch];
  if (base) return { key: ch, code: base.code, windowsVirtualKeyCode: base.vk };
  return { key: ch };
}

function modifiersBitmask(m?: KeyModifiers): number {
  if (!m) return 0;
  let bits = 0;
  if (m.alt) bits |= 1;
  if (m.ctrl) bits |= 2;
  if (m.meta) bits |= 4;
  if (m.shift) bits |= 8;
  return bits;
}

const MOUSE_BUTTONS_MASK: Record<MouseButton, number> = { left: 1, right: 2, middle: 4 };

export interface DebuggerInputTierOptions {
  /** Random source for humanized timing/paths. Default `Math.random`. Inject a
   * seeded one in tests for deterministic assertions. */
  rng?: Rng;
  /** Pacing seam. Default real `setTimeout`. Inject a no-op in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Fired when the browser detaches the session out from under us — most
   * notably the user pressing Cancel on the debugging infobar
   * (`reason === 'canceled_by_user'`). The caller should report this via the
   * `input.fidelity` RunEvent (`{ fidelity: 'escalated', attached: false }`)
   * and must not have this tier silently re-attach. */
  onDetach?: (reason: string) => void;
}

const realSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Trusted-input tier over CDP `Input.*`. One attach per run segment: call
 * `attach()` once, drive any number of `click`/`moveTo`/`typeText`/`press`/
 * `scroll` calls, then `detach()` once at the end of the run.
 */
export class DebuggerInputTier implements InputTier {
  readonly name = 'debugger' as const;

  private readonly api: DebuggerApi;
  private readonly rng: Rng;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onDetachCb?: (reason: string) => void;

  private attached = false;
  private tabId: number | null = null;
  private detachReason: string | undefined;
  private pointer: Point = { x: 0, y: 0 };
  private detachListener?: (source: DebuggerTarget, reason: string) => void;

  constructor(api: DebuggerApi, opts: DebuggerInputTierOptions = {}) {
    this.api = api;
    this.rng = opts.rng ?? Math.random;
    this.sleep = opts.sleep ?? realSleep;
    this.onDetachCb = opts.onDetach;
  }

  isAttached(): boolean {
    return this.attached;
  }

  async attach(tabId: number): Promise<void> {
    if (this.attached && this.tabId === tabId) return; // idempotent: one attach per run segment
    if (this.attached && this.tabId !== tabId) {
      await this.detach();
    }
    await this.api.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION);
    this.attached = true;
    this.tabId = tabId;
    this.detachReason = undefined;
    this.pointer = { x: 0, y: 0 };
    this.detachListener = (source, reason) => {
      if (source.tabId !== tabId) return;
      this.attached = false;
      this.detachReason = reason;
      this.onDetachCb?.(reason);
    };
    this.api.onDetach.addListener(this.detachListener);
  }

  async detach(): Promise<void> {
    if (!this.attached || this.tabId === null) return;
    const target: DebuggerTarget = { tabId: this.tabId };
    if (this.detachListener) this.api.onDetach.removeListener(this.detachListener);
    this.detachListener = undefined;
    await this.api.detach(target);
    this.attached = false;
    this.tabId = null;
  }

  private assertAttached(): number {
    if (!this.attached || this.tabId === null) {
      const reason = this.detachReason ? ` (last detach reason: ${this.detachReason})` : '';
      throw new Error(`DebuggerInputTier: not attached${reason}`);
    }
    return this.tabId;
  }

  private async sendInput(method: string, params: Record<string, unknown>): Promise<void> {
    if (!method.startsWith('Input.')) {
      throw new Error(`DebuggerInputTier: refusing non-Input CDP command "${method}"`);
    }
    const tabId = this.assertAttached();
    await this.api.sendCommand({ tabId }, method, params);
  }

  async click(x: number, y: number, opts: ClickOptions = {}): Promise<void> {
    this.assertAttached();
    const button = opts.button ?? 'left';
    const clickCount = opts.clickCount ?? 1;

    // Arrive along the humanized path rather than teleporting: `moveTo` from the
    // current position is a no-op when already there, so routing every click through
    // it costs nothing for callers (like `RunInput`) that moved first.
    await this.moveTo(x, y);
    await this.sendInput('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button,
      buttons: MOUSE_BUTTONS_MASK[button],
      clickCount,
      force: 0.5,
    });
    await this.sleep(sampleHold({ minMs: 40, maxMs: 120, rng: this.rng }));
    await this.sendInput('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button,
      buttons: 0,
      clickCount,
    });
    this.pointer = { x, y };
  }

  async moveTo(x: number, y: number): Promise<void> {
    this.assertAttached();
    const path = planPath(this.pointer, { x, y }, { rng: this.rng });
    let prevT = 0;
    // path[0] is the current position (t=0); nothing to dispatch for it.
    for (const p of path.slice(1)) {
      const wait = p.t - prevT;
      if (wait > 0) await this.sleep(wait);
      prevT = p.t;
      await this.sendInput('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none', buttons: 0 });
    }
    this.pointer = { x, y };
  }

  async typeText(text: string): Promise<void> {
    this.assertAttached();
    for (const ch of text) {
      if (ch === '\n') {
        await this.press('Enter');
        continue;
      }
      const info = deriveKeyInfo(ch);
      const base: Record<string, unknown> = { key: info.key };
      if (info.code) base.code = info.code;
      if (info.windowsVirtualKeyCode !== undefined) base.windowsVirtualKeyCode = info.windowsVirtualKeyCode;

      await this.sendInput('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, ...base });
      await this.sleep(sampleHold({ minMs: 40, maxMs: 80, rng: this.rng }));
      await this.sendInput('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      await this.sleep(sampleInterKey({ meanMs: 90, sigmaMs: 30, rng: this.rng }));
    }
  }

  async press(key: string, opts: PressOptions = {}): Promise<void> {
    this.assertAttached();
    const named = NAMED_KEYS[key];
    const info: DerivedKeyInfo = named ?? { key };
    const modifiers = modifiersBitmask(opts.modifiers);
    const base: Record<string, unknown> = { key: info.key, modifiers };
    if (info.code) base.code = info.code;
    if (info.windowsVirtualKeyCode !== undefined) base.windowsVirtualKeyCode = info.windowsVirtualKeyCode;
    const text = named?.text;

    await this.sendInput('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(text ? { text } : {}) });
    await this.sleep(sampleHold({ minMs: 40, maxMs: 80, rng: this.rng }));
    await this.sendInput('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  async scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    this.assertAttached();
    const chunks = 3 + Math.floor(this.rng() * 2); // 3-4 chunks
    for (let i = 0; i < chunks; i++) {
      const fracStart = i / chunks;
      const fracEnd = (i + 1) / chunks;
      const dx = deltaX * (fracEnd - fracStart);
      const dy = deltaY * (fracEnd - fracStart);
      await this.sendInput('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy });
      await this.sleep(10 + Math.round(this.rng() * 20));
    }
  }
}
