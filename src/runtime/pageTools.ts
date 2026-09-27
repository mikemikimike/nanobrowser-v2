/**
 * `PageTools` over a real tab (R-01: the tab the user already has open).
 *
 * This is the join between three finished subsystems that never import each
 * other: the agent's `PageTools` port (`src/agent/tools.ts`), the page tier
 * (`src/page/driver.ts`), and the input tiers (`src/input/*`). Nothing here
 * decides policy — the user's `inputFidelity` (R-13) and `observe` (R-08) come
 * from the side panel's `Config` and are handed in.
 *
 * Two shape mismatches are absorbed here rather than by editing a subsystem:
 *
 * 1. `PageDriver` reports failure as `{ ok:false, error }`; `InputTier` /
 *    `RefInputTier` are `Promise<void>` and signal failure by throwing. The
 *    adapter below throws on `ok:false`, so a failed click reaches the graph as
 *    a `tool.result { ok:false }` instead of being silently swallowed.
 * 2. The in-page tier addresses elements by ref, the debugger tier by viewport
 *    point. `RunInput` (src/input/select.ts) already erases that difference via
 *    `getBox` + `refToPoint`; {@link EscalatableInput} adds what a *run* needs on
 *    top: attach once at the start, detach once at the end, and a one-way
 *    fallback to the in-page tier if the user cancels the debugging banner.
 */
import type {
  PageTools,
  ScreenshotResult as ToolScreenshot,
  ScrollTarget,
  SnapshotResult as ToolSnapshot,
  WriteUserscriptRequest,
} from '@/src/agent/tools';
import type { ScreenshotResult, SnapshotResponse } from '@/src/page/driver';
import type { ExtractTextOptions } from '@/src/page/extractText';
import { DEFAULT_MAX_NODES } from '@/src/page/snapshot';
import type { SnapshotOptions } from '@/src/page/snapshot';
import type { ActionResult, ScrollOptions } from '@/src/page/actions';
import {
  InPageInputTier,
  RunInput,
  selectTier,
  type Box,
  type ElementRef,
  type GetBox,
  type InputTier,
  type PageDriverLike,
  type PressOptions,
  type RefInputTier,
} from '@/src/input';
import type { RunEvent, Userscript, UserscriptRunResult } from '@/src/messaging';
import type { InputFidelity, ObserveMode } from '@/src/storage';
import { toRunEvents } from '@/src/userscripts/debug';
import type { AgentWriteResult } from '@/src/userscripts/authoring';
import type { UserscriptValueStore } from './durability';
import { isReadOnlyScript } from '@/src/agent/policy';
import { BUNDLED_USERSCRIPTS } from '@/src/userscripts/examples';

/** The slice of {@link PageDriver} the runtime uses. `PageDriver` satisfies it structurally. */
export interface RuntimeDriver {
  snapshot(tabId: number, opts?: SnapshotOptions): Promise<SnapshotResponse>;
  screenshot(tabId: number): Promise<ScreenshotResult>;
  extractText(tabId: number, opts?: ExtractTextOptions): Promise<ActionResult & Partial<{ text: string; truncated: boolean; totalChars: number; nextStart: number }>>;
  click(tabId: number, ref: string): Promise<ActionResult>;
  type(tabId: number, ref: string, text: string): Promise<ActionResult>;
  press(tabId: number, key: string): Promise<ActionResult>;
  select(tabId: number, ref: string, value: string): Promise<ActionResult>;
  scroll(tabId: number, opts?: ScrollOptions): Promise<ActionResult>;
  hover(tabId: number, ref: string): Promise<ActionResult>;
  /** Page metrics from the injected side; also the injection health check. */
  ping_(tabId: number): Promise<ActionResult & { width?: number; height?: number }>;
  getBox(tabId: number, ref: string): Promise<{ ok: boolean; error?: string; box?: Box & { centerX: number; centerY: number } }>;
  navigate(tabId: number, url: string): Promise<ActionResult>;
  download(url: string, filename?: string): Promise<ActionResult & { downloadId?: number }>;
  /** `save_file`'s Downloads-folder half (see `PageDriver.saveFile`). */
  saveFile(dataUrl: string, filename: string): Promise<ActionResult & { downloadId?: number }>;
}

/** `save_file`'s native-messaging half: the host's `artifact.save` (docs/host-protocol.md). */
export type SaveArtifact = (filename: string, content: string) => Promise<{ path: string; bytes: number }>;

/** Runs a userscript by id against a tab (R-09). Wired to the userscripts subsystem. */
export type RunUserscript = (
  scriptId: string,
  tabId: number,
  args?: Record<string, unknown>,
) => Promise<UserscriptRunResult>;

function must<T extends ActionResult>(result: T, what: string): T {
  if (!result.ok) throw new Error(result.error ?? `${what} failed`);
  return result;
}

/**
 * `PageDriverLike` (what `InPageInputTier` drives) over the real `PageDriver`.
 *
 * `press` drops the ref: the driver's `press` targets whatever has focus, which
 * is what the in-page tier means by "press a key". `scroll` turns a delta back
 * into the driver's direction/amount vocabulary.
 */
export function createInPageDriverAdapter(driver: RuntimeDriver): PageDriverLike {
  return {
    async click(tabId, ref) {
      must(await driver.click(tabId, ref), 'click');
    },
    async moveTo(tabId, ref) {
      must(await driver.hover(tabId, ref), 'hover');
    },
    async type(tabId, ref, text) {
      must(await driver.type(tabId, ref, text), 'type');
    },
    async press(tabId, _ref, key) {
      must(await driver.press(tabId, key), 'press');
    },
    async scroll(tabId, ref, deltaX, deltaY) {
      const opts: ScrollOptions = deltaY !== 0
        ? { ref, direction: deltaY > 0 ? 'down' : 'up', amount: Math.abs(deltaY) }
        : deltaX !== 0
          ? { ref, direction: deltaX > 0 ? 'right' : 'left', amount: Math.abs(deltaX) }
          : { ref };
      must(await driver.scroll(tabId, opts), 'scroll');
    },
  };
}

/** What {@link EscalatableInput} needs from the page beyond ref-addressed input. */
export interface InputPagePort {
  getBox: GetBox;
  /** In-page viewport scroll (no ref): the driver's own `window.scrollBy`. */
  scrollViewport(opts: ScrollOptions): Promise<void>;
  /** Viewport centre in CSS pixels — where a coordinate tier aims a wheel event. */
  viewportCentre(): Promise<{ x: number; y: number }>;
}

export interface EscalatableInputOptions {
  /** The user's choice (R-13). `escalated` needs `debuggerTier`. */
  fidelity: InputFidelity;
  inPageTier: RefInputTier;
  /** Absent means escalation is impossible; the run stays in-page. */
  debuggerTier?: InputTier;
  page: InputPagePort;
  emit: (event: RunEvent) => void;
  rng?: () => number;
  now?: () => number;
}

/**
 * The run's input, with R-13's escalation and its one-way fallback.
 *
 * Hygiene from docs/research/trusted-input-and-stealth.md: attach once per run
 * segment, never per action, and treat `onDetach` as a real user stop — the
 * banner's Cancel button is the user saying no. We do not re-attach; the rest of
 * the run continues on the in-page tier, and `input.fidelity { attached:false }`
 * puts that in the run log (R-07).
 */
export class EscalatableInput {
  #fidelity: InputFidelity;
  readonly #requested: InputFidelity;
  readonly #inPage: RunInput;
  readonly #escalated?: RunInput;
  readonly #debuggerTier?: InputTier;
  readonly #inPageTier: RefInputTier;
  readonly #page: InputPagePort;
  readonly #emit: (event: RunEvent) => void;
  readonly #now: () => number;
  #tabId: number | null = null;

  constructor(opts: EscalatableInputOptions) {
    this.#requested = opts.fidelity;
    this.#inPageTier = opts.inPageTier;
    this.#debuggerTier = opts.debuggerTier;
    this.#page = opts.page;
    this.#emit = opts.emit;
    this.#now = opts.now ?? Date.now;

    const chosen = selectTier(opts.fidelity, {
      inPageTier: opts.inPageTier,
      // selectTier only ever reads this when the fidelity is `escalated`.
      debuggerTier: (opts.debuggerTier ?? opts.inPageTier) as InputTier,
    });
    this.#fidelity = chosen.name === 'in-page' || !opts.debuggerTier ? 'in-page' : 'escalated';

    this.#inPage = new RunInput({ tier: opts.inPageTier, getBox: opts.page.getBox, rng: opts.rng });
    this.#escalated = opts.debuggerTier
      ? new RunInput({ tier: opts.debuggerTier, getBox: opts.page.getBox, rng: opts.rng })
      : undefined;
  }

  /** The tier actually in force right now — not necessarily the one the user asked for. */
  get fidelity(): InputFidelity {
    return this.#fidelity;
  }

  get escalated(): boolean {
    return this.#fidelity === 'escalated';
  }

  /** True while the debugger tier holds a session. */
  attached(): boolean {
    return this.#debuggerTier?.isAttached() ?? false;
  }

  /** Attach once, at the start of the run. */
  async attach(tabId: number): Promise<void> {
    this.#tabId = tabId;
    await this.#inPageTier.attach(tabId);
    if (this.#fidelity !== 'escalated' || !this.#debuggerTier) {
      this.#emit({ kind: 'input.fidelity', fidelity: 'in-page', attached: false, at: this.#now() });
      return;
    }
    try {
      await this.#debuggerTier.attach(tabId);
      this.#emit({ kind: 'input.fidelity', fidelity: 'escalated', attached: true, at: this.#now() });
    } catch (error) {
      this.#fidelity = 'in-page';
      console.warn('[nanobrowser] debugger attach failed; staying on the in-page tier', error);
      this.#emit({ kind: 'input.fidelity', fidelity: 'in-page', attached: false, at: this.#now() });
    }
  }

  /** Detach once, at the end of the run. Idempotent. */
  async detach(): Promise<void> {
    this.#tabId = null;
    await this.#inPageTier.detach();
    if (!this.#debuggerTier) return;
    try {
      await this.#debuggerTier.detach();
    } catch (error) {
      console.warn('[nanobrowser] debugger detach failed', error);
    }
  }

  /**
   * The user cancelled the debugging banner (or Chrome dropped the session).
   * One way: the rest of the run runs in-page.
   */
  handleDetach(reason: string): void {
    if (this.#fidelity !== 'escalated') return;
    this.#fidelity = 'in-page';
    console.warn(`[nanobrowser] debugger detached (${reason}); falling back to the in-page tier`);
    this.#emit({ kind: 'input.fidelity', fidelity: 'in-page', attached: false, at: this.#now() });
  }

  #active(): RunInput {
    return this.#fidelity === 'escalated' && this.#escalated ? this.#escalated : this.#inPage;
  }

  async click(ref: ElementRef): Promise<void> {
    await this.#active().click(ref);
  }

  async hover(ref: ElementRef): Promise<void> {
    await this.#active().moveTo(ref);
  }

  /**
   * A coordinate tier types into whatever has focus, so it must click the field
   * first (documented on `RunInput.typeText`). The in-page tier addresses the
   * element directly and needs no such click.
   *
   * The `type` tool contract is replace-by-default, and the in-page tier keeps
   * it by clearing first. A coordinate tier has no clear step, so the escalated
   * path selects all before typing — the same contract through trusted keys.
   */
  async typeText(ref: ElementRef, text: string): Promise<void> {
    if (this.#fidelity === 'escalated' && this.#escalated) {
      await this.#escalated.click(ref);
      // Ctrl+A: the Linux select-all (a macOS port would send Meta instead).
      await this.#escalated.press(null, 'a', { modifiers: { ctrl: true } });
      await this.#escalated.typeText(ref, text);
      return;
    }
    await this.#inPage.typeText(ref, text);
  }

  async press(ref: ElementRef | null, key: string, opts?: PressOptions): Promise<void> {
    await this.#active().press(ref, key, opts);
  }

  /** Scroll one element into view. */
  async scrollRef(ref: ElementRef): Promise<void> {
    if (this.#fidelity === 'escalated' && this.#escalated) {
      await this.#escalated.scroll(ref, 0, 0);
      return;
    }
    await this.#page.scrollViewport({ ref });
  }

  /** Scroll the viewport by a delta, with no element in mind. */
  async scrollViewport(direction: 'up' | 'down', amount?: number): Promise<void> {
    if (this.#fidelity === 'escalated' && this.#debuggerTier) {
      const { x, y } = await this.#page.viewportCentre();
      const delta = amount ?? DEFAULT_SCROLL_AMOUNT;
      await this.#debuggerTier.scroll(x, y, 0, direction === 'down' ? delta : -delta);
      return;
    }
    await this.#page.scrollViewport({ direction, ...(amount !== undefined ? { amount } : {}) });
  }

  /** The tab this input is bound to, if any. */
  get tabId(): number | null {
    return this.#tabId;
  }

  /** What the user asked for, regardless of what is in force. */
  get requested(): InputFidelity {
    return this.#requested;
  }
}

/** Default wheel/scroll delta in CSS pixels when the caller names no amount. */
export const DEFAULT_SCROLL_AMOUNT = 600;
/** Enough to reach either end of any realistic page in one call. */
const SCROLL_TO_END_AMOUNT = 10_000_000;

/**
 * Snapshot node budget per observe mode (R-08). Pixels mode leans on the image.
 * The dom/both figure tracks `DEFAULT_MAX_NODES` (src/page/snapshot.ts) so the two
 * defaults never drift apart; see that constant's comment for the measurement.
 */
export function snapshotBudget(observe: ObserveMode): number {
  return observe === 'pixels' ? 200 : DEFAULT_MAX_NODES;
}

export interface CreatePageToolsOptions {
  tabId: number;
  driver: RuntimeDriver;
  input: EscalatableInput;
  observe: ObserveMode;
  runUserscript: RunUserscript;
  /** Reads the catalog for `list_userscripts`. Absent means the run has no catalog. */
  listUserscripts?: () => Promise<Userscript[]>;
  /**
   * The agent's write path for `write_userscript` (O-03). Absent means this run
   * cannot author scripts; the tool says so rather than failing obscurely.
   */
  writeUserscript?: (request: WriteUserscriptRequest) => Promise<AgentWriteResult>;
  emit: (event: RunEvent) => void;
  maxNodes?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Needed for `save_file`'s host half (`artifact.save`'s `runId`). */
  runId?: string;
  /** Absent means `save_file` only writes to the Downloads folder, not the host. */
  saveArtifact?: SaveArtifact;
  /**
   * Durable last-userscript value (M6). The closure below stays the fast path;
   * this is written on every successful run and read when the closure is empty
   * (a service-worker restart). Absent means closure only, as before.
   */
  userscriptValueStore?: UserscriptValueStore;
  /**
   * Read-only run mode (#13). The Follower toolset already drops the acting
   * tools; this refuses them anyway so a shape drift can never silently act.
   */
  readOnly?: boolean;
  /**
   * Whole-catalog userscript resolution for the read-only preflight. Separate
   * from the run's starting-URL-filtered list: a read-only run may navigate
   * and then run a script matching its destination.
   */
  resolveUserscript?: (idOrName: string) => Promise<Userscript | undefined>;
}

/** Cap on the JSON echoed in `run_userscript`'s own return string (not what's retained). */
const RUN_USERSCRIPT_RESULT_MAX_CHARS = 60_000;

/**
 * Cap on the console output echoed back to the model from one userscript run.
 *
 * The debug loop is *edit, run, read the console and the error, edit again* (O-03),
 * so the console has to come back or the loop has no observation in it. It is capped
 * separately from the returned value because a script that logs in a loop would
 * otherwise crowd out its own result.
 */
const RUN_USERSCRIPT_CONSOLE_MAX_LINES = 40;
const RUN_USERSCRIPT_CONSOLE_MAX_CHARS = 4_000;

/** Renders captured console lines for the model, or '' when the script logged nothing. */
export function formatUserscriptConsole(
  lines: UserscriptRunResult['console'],
  maxLines = RUN_USERSCRIPT_CONSOLE_MAX_LINES,
  maxChars = RUN_USERSCRIPT_CONSOLE_MAX_CHARS,
): string {
  if (lines.length === 0) return '';

  // Keep the tail. A long scrape's challenge or parse error is the last line,
  // and slicing from the front hid it.
  const lastError = [...lines].reverse().find((line) => line.level === 'error');
  const kept: string[] = [];
  let used = 0;
  let keptError = false;
  for (const line of lines.slice(-maxLines).reverse()) {
    const rendered = `[${line.level}] ${line.text}`;
    if (used + rendered.length > maxChars) break;
    kept.push(rendered);
    if (line === lastError) keptError = true;
    used += rendered.length + 1;
  }
  kept.reverse();
  if (lastError && !keptError) {
    // Make room for the error inside both caps instead of growing past them.
    const rendered = `[${lastError.level}] ${lastError.text}`.slice(0, maxChars);
    while (kept.length > 0 && (kept.length + 1 > maxLines || used + rendered.length > maxChars)) {
      used -= (kept.shift() ?? '').length + 1;
    }
    kept.push(rendered);
  }

  const dropped = lines.length - kept.length;
  const more = dropped > 0 ? `\n… ${dropped} more console line${dropped === 1 ? '' : 's'}` : '';
  return `\nconsole:\n${kept.join('\n')}${more}`;
}

/** Host artifact cap. A larger comps object keeps summary and log and drops rows. */
export const MAX_SAVE_BYTES = 8 * 1024 * 1024;

/** JSON for a save. Oversized objects become summary and log, never a data URL of the rows. */
export function userscriptArtifactBody(value: unknown): { body: string; droppedRows: boolean } {
  const full = JSON.stringify(value, null, 2) ?? String(value);
  if (new TextEncoder().encode(full).length <= MAX_SAVE_BYTES || !value || typeof value !== 'object') {
    return { body: full, droppedRows: false };
  }
  const record = value as { summary?: unknown; log?: unknown; meta?: unknown };
  const meta = typeof record.meta === 'object' && record.meta ? record.meta : {};
  const body = JSON.stringify(
    {
      summary: record.summary ?? null,
      log: record.log ?? [],
      meta: { ...meta, rows_dropped: 'exceeded 8 MiB' },
    },
    null,
    2,
  );
  return { body, droppedRows: true };
}

/** What the model sees. A comps object echoes summary, not the row dump. */
export function formatUserscriptValue(value: unknown): string {
  if (value === undefined) return '(no value)';
  if (value && typeof value === 'object' && 'summary' in value) {
    const record = value as { summary?: unknown; meta?: unknown; log?: unknown; rows?: unknown };
    const rowCount = Array.isArray(record.rows) ? record.rows.length : 0;
    const preview = JSON.stringify({ summary: record.summary, meta: record.meta, log: record.log, rowCount });
    return `${preview}\nrows are not in this reply. Save them with save_file fromLastUserscript true.`;
  }
  const full = JSON.stringify(value);
  if (full.length > RUN_USERSCRIPT_RESULT_MAX_CHARS) {
    return `${full.slice(0, RUN_USERSCRIPT_RESULT_MAX_CHARS)} [truncated]`;
  }
  return full;
}

/** One line per script for `list_userscripts`, in the shape the model must echo back. */
export function formatUserscriptList(scripts: Userscript[]): string {
  if (scripts.length === 0) {
    return 'No userscripts are saved. Use write_userscript to create one.';
  }
  const rows = scripts.map(
    (script) =>
      `${script.id} | ${script.name} | ${script.matches.join(' ')} | written by ${script.author === 'agent' ? 'you' : 'the user'}`,
  );
  return [`${scripts.length} saved userscript${scripts.length === 1 ? '' : 's'} (id | name | runs on | author):`, ...rows].join('\n');
}

/** {@link PageTools} as built for one run by {@link createPageTools}. A plain alias:
 * the port already names `hover`, so nothing here redeclares it. */
export type RuntimePageTools = PageTools;

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** UTF-8-safe base64, for `save_file`'s `data:` URL. `btoa` alone only handles latin1. */
function base64Encode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Builds the page port for one run against one tab. */
export function createPageTools(options: CreatePageToolsOptions): RuntimePageTools {
  const { tabId, driver, input, observe, runUserscript, emit } = options;
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;
  const maxNodes = options.maxNodes ?? snapshotBudget(observe);
  const readOnly = options.readOnly ?? false;

  function refuseIfReadOnly(what: string): void {
    if (readOnly) {
      throw new Error(
        `read-only run: ${what} is unavailable; read, navigate, run a read-only userscript, or save instead`,
      );
    }
  }

  /** A userscript may run read-only only when its source passes the advisory scan (#13). */
  async function assertReadOnlyScript(scriptId: string): Promise<void> {
    // Resolved from the whole catalog, deliberately NOT from the run's filtered
    // list: that list is closed over the starting tab's URL, while a read-only run
    // may navigate and then run a script matching its destination. Execution stays
    // URL-gated — the runner refuses scripts whose matches reject the live tab.
    if (!options.resolveUserscript) {
      throw new Error(
        `read-only run: cannot verify userscript ${scriptId} is read-only (no catalog in this run): refusing to run it`,
      );
    }
    const script = await options.resolveUserscript(scriptId);
    if (!script) {
      throw new Error(`read-only run: unknown userscript ${scriptId}: refusing to run what cannot be verified`);
    }
    // A bundled seed exactly as shipped is ours, and the regex also trips on its
    // comments and `.value =`. A seed the user edited in place keeps its bundled id,
    // so the id alone proves nothing: only unmodified seed code skips the scan.
    const seed = BUNDLED_USERSCRIPTS.find((candidate) => candidate.id === script.id);
    if (seed && seed.code === script.code) return;
    const check = isReadOnlyScript(script.code);
    if (!check.ok) throw new Error(`read-only run: ${scriptId} ${check.reason}`);
  }

  // R-09/save_file: the full, untruncated result of the most recent successful
  // run_userscript call. Kept in the closure (not echoed through the tool's own
  // return string, which is capped for the model) so `save_file(fromLastUserscript:
  // true)` can write it losslessly.
  let lastUserscriptValue: unknown;
  let hasLastUserscriptValue = false;

  return {
    async snapshot(): Promise<ToolSnapshot> {
      const res = await driver.snapshot(tabId, { interactiveOnly: false, maxNodes });
      if (!res.ok) throw new Error(res.error ?? 'snapshot failed');
      return { text: res.text ?? '', ...(res.approxTokens !== undefined ? { tokens: res.approxTokens } : {}) };
    },

    async screenshot(): Promise<ToolScreenshot> {
      const res = await driver.screenshot(tabId);
      if (!res.ok || !res.dataUrl) throw new Error(res.error ?? 'screenshot failed');
      return { dataUrl: res.dataUrl, width: res.width ?? 0, height: res.height ?? 0 };
    },

    async extractText(maxChars?: number, startChar?: number) {
      const res = await driver.extractText(tabId, {
        ...(maxChars !== undefined ? { maxChars } : {}),
        ...(startChar !== undefined ? { startChar } : {}),
      });
      if (!res.ok || res.text === undefined) throw new Error(res.error ?? 'extract_text failed');
      // Without this the model cannot tell a short page from a cut-off one, and a live
      // eBay scrape quietly saved 38 of 60 listings.
      if (res.nextStart !== undefined) {
        return `${res.text}\n(read ${res.nextStart} of ${res.totalChars ?? '?'} characters; call extract_text again with startChar ${res.nextStart} for the rest)`;
      }
      return res.text;
    },

    async getBox(ref) {
      const res = await driver.getBox(tabId, ref);
      if (!res.ok || !res.box) throw new Error(res.error ?? `no box for ${ref}`);
      const { x, y, width, height } = res.box;
      return { x, y, width, height };
    },

    async click(ref) {
      refuseIfReadOnly('click');
      await input.click(ref);
      return `clicked ${ref}`;
    },

    async hover(ref) {
      refuseIfReadOnly('hover');
      await input.hover(ref);
      return `hovered ${ref}`;
    },

    async type(ref, text) {
      refuseIfReadOnly('type');
      await input.typeText(ref, text);
      return `typed ${text.length} characters into ${ref}`;
    },

    async press(key) {
      refuseIfReadOnly('press');
      await input.press(null, key);
      return `pressed ${key}`;
    },

    async scroll(target: ScrollTarget) {
      // `ScrollTarget` widens to `string`, so this is an if-chain, not a switch.
      const keyword = String(target);
      if (keyword === 'up' || keyword === 'down') {
        await input.scrollViewport(keyword);
        return `scrolled ${keyword}`;
      }
      if (keyword === 'top' || keyword === 'bottom') {
        // A whole-document jump, not synthesized user input: always the page tier.
        const res = await driver.scroll(tabId, {
          direction: keyword === 'top' ? 'up' : 'down',
          amount: SCROLL_TO_END_AMOUNT,
        });
        if (!res.ok) throw new Error(res.error ?? 'scroll failed');
        return `scrolled to the ${keyword}`;
      }
      await input.scrollRef(keyword);
      return `scrolled ${keyword} into view`;
    },

    async select(ref, value) {
      refuseIfReadOnly('select');
      // No CDP `Input` command sets a <select>'s value, so this is the page tier
      // on both fidelities: the trusted tier has nothing to offer here.
      const res = await driver.select(tabId, ref, value);
      if (!res.ok) throw new Error(res.error ?? 'select failed');
      return `selected "${value}" in ${ref}`;
    },

    async navigate(url) {
      const res = await driver.navigate(tabId, url);
      if (!res.ok) throw new Error(res.error ?? 'navigate failed');
      return `navigated to ${url}`;
    },

    async download(target) {
      refuseIfReadOnly('download');
      if (/^https?:\/\//i.test(target)) {
        const res = await driver.download(target);
        if (!res.ok) throw new Error(res.error ?? 'download failed');
        return `download started (id ${res.downloadId ?? 'unknown'})`;
      }
      // A ref: click it and let the page start its own download.
      await input.click(target);
      return `clicked ${target} to start the download`;
    },

    async runUserscript(scriptId, args) {
      if (readOnly) await assertReadOnlyScript(scriptId);
      const result = await runUserscript(scriptId, tabId, args);
      for (const event of toRunEvents(result, now)) emit(event);
      const logged = formatUserscriptConsole(result.console);
      const preview = formatUserscriptValue(result.value);
      // Keep a partial even when the run failed, so save_file can write the rows
      // collected before the throw.
      if (result.value !== undefined) {
        lastUserscriptValue = result.value;
        hasLastUserscriptValue = true;
        void options.userscriptValueStore?.save(result.value).catch((error: unknown) => {
          console.warn('[nanobrowser] could not persist the last userscript value', error);
        });
      }
      if (!result.ok) {
        throw new Error(
          `userscript ${scriptId} failed after ${result.durationMs}ms: ${result.error ?? 'no error reported'}${logged}\n${preview}`,
        );
      }
      return `userscript ${scriptId} ran in ${result.durationMs}ms: ${preview}${logged}`;
    },

    async readUserscript(idOrName: string) {
      if (!options.resolveUserscript) throw new Error('the userscript catalog is not available in this run');
      const script = await options.resolveUserscript(idOrName);
      if (!script) throw new Error(`unknown userscript: ${idOrName}`);
      return `${script.id} | ${script.name} | ${script.matches.join(' ')}\n${script.code}`;
    },

    async listUserscripts() {
      if (!options.listUserscripts) return 'The userscript catalog is not available in this run.';
      return formatUserscriptList(await options.listUserscripts());
    },

    async writeUserscript(request) {
      refuseIfReadOnly('write_userscript');
      if (!options.writeUserscript) {
        throw new Error('writing userscripts is not available in this run');
      }
      const result = await options.writeUserscript(request);
      if (!result.ok) {
        // Thrown, not returned: a refused write is a failed step, and the model
        // needs the reasons verbatim to produce an acceptable second attempt.
        throw new Error(`write_userscript refused: ${result.errors.join('; ')}`);
      }
      const verb = result.created ? 'created' : 'updated';
      return (
        `${verb} userscript ${result.script.id} ("${result.script.name}") for ` +
        `${result.script.matches.join(' ')}. Run it with run_userscript scriptId "${result.script.id}".`
      );
    },

    async saveFile(filename, content, fromLastUserscript) {
      let body = content;
      let droppedRows = false;
      if (fromLastUserscript) {
        if (!hasLastUserscriptValue && options.userscriptValueStore) {
          // The closure is empty but a store exists: this tool instance was
          // born in a restart. Adopt the durable value when there is one.
          const stored = await options.userscriptValueStore.load().catch((error: unknown) => {
            console.warn('[nanobrowser] could not load the last userscript value', error);
            return { found: false as const };
          });
          if (stored.found) {
            lastUserscriptValue = stored.value;
            hasLastUserscriptValue = true;
          } else {
            throw new Error(
              'the last userscript value was lost to a restart: re-run the script, then save again',
            );
          }
        }
        if (!hasLastUserscriptValue) throw new Error('no userscript has run yet in this session: nothing to save');
        const packed = userscriptArtifactBody(lastUserscriptValue);
        body = packed.body;
        droppedRows = packed.droppedRows;
      }
      if (body === undefined) throw new Error('save_file has no content to save');
      const bytes = new TextEncoder().encode(body).length;
      if (bytes > MAX_SAVE_BYTES) {
        throw new Error(`save_file exceeds the ${MAX_SAVE_BYTES}-byte cap (${bytes} bytes)`);
      }

      const dataUrl = `data:application/octet-stream;base64,${base64Encode(body)}`;
      const downloadRes = await driver.saveFile(dataUrl, filename);

      let artifactNote = '';
      let artifactPath: string | undefined;
      let artifactOk = false;
      let artifactError: string | undefined;
      if (options.saveArtifact) {
        try {
          const artifact = await options.saveArtifact(filename, body);
          artifactPath = artifact.path;
          artifactOk = true;
          artifactNote = `; also saved to the run's artifacts (${artifact.path})`;
        } catch (error) {
          artifactError = error instanceof Error ? error.message : String(error);
          artifactNote = `; could not save to the run's artifacts: ${artifactError}`;
        }
      }
      // Both save paths have to actually fail before this throws -- the caller must not be
      // told a file was saved, complete with a file.saved event and a path, when neither
      // the Downloads write nor a configured artifact write actually landed anywhere.
      if (!downloadRes.ok && !artifactOk) {
        const reasons = [
          downloadRes.error ? `Downloads: ${downloadRes.error}` : undefined,
          artifactError ? `artifacts: ${artifactError}` : undefined,
        ].filter((s): s is string => Boolean(s));
        throw new Error(reasons.length > 0 ? `save_file failed (${reasons.join('; ')})` : 'save_file failed');
      }
      const downloadNote = downloadRes.ok
        ? ''
        : `; could not save to Downloads/nanobrowser: ${downloadRes.error ?? 'unknown error'}`;

      // R-07: one run-log entry the panel renders as a file-saved card, regardless
      // of which of the two save mechanisms actually succeeded.
      emit({
        kind: 'file.saved',
        runId: options.runId ?? '',
        filename,
        bytes,
        path: artifactPath ?? `nanobrowser/${filename}`,
        at: now(),
      });

      const dropNote = droppedRows ? '; rows exceeded 8 MiB and were left out' : '';
      return `saved ${filename} (${bytes} bytes)${downloadNote}${artifactNote}${dropNote}`;
    },

    async wait(ms) {
      await sleep(ms);
      return `waited ${ms}ms`;
    },

    async done(summary) {
      return summary;
    },

    async blocked(reason) {
      return reason;
    },
  };
}

/** The {@link InputPagePort} over a real driver and tab. */
export function createInputPagePort(driver: RuntimeDriver, tabId: number): InputPagePort {
  return {
    async getBox(ref) {
      const res = await driver.getBox(tabId, ref);
      if (!res.ok || !res.box) throw new Error(res.error ?? `no box for ${ref}`);
      const { x, y, width, height } = res.box;
      return { x, y, width, height };
    },
    async scrollViewport(opts) {
      const res = await driver.scroll(tabId, opts);
      if (!res.ok) throw new Error(res.error ?? 'scroll failed');
    },
    async viewportCentre() {
      const metrics = await driver.ping_(tabId);
      if (!metrics.ok) throw new Error(metrics.error ?? 'the page did not report its viewport');
      return { x: Math.round((metrics.width ?? 0) / 2), y: Math.round((metrics.height ?? 0) / 2) };
    },
  };
}

/** Convenience: the in-page tier over a real driver. */
export function createInPageTier(driver: RuntimeDriver): RefInputTier {
  return new InPageInputTier(createInPageDriverAdapter(driver));
}
