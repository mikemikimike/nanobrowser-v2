/**
 * Live userscript execution (R-09) on `chrome.userScripts.execute()`, Chrome 135+.
 *
 * Why this API and not `chrome.scripting.executeScript`: `execute()` is the only
 * Chrome-native primitive that takes an arbitrary code *string*, runs it in a world
 * that is exempt from the page's CSP, and returns a structured per-frame result —
 * including the settled value when the script evaluates to a promise. See
 * `docs/research/userscripts-api.md` §1-2.
 *
 * We run in the `USER_SCRIPT` world, never the page's own world. The USER_SCRIPT
 * world is a separate, extension-owned world with its own CSP: the page cannot see
 * our objects, so nothing we inject becomes a detection signal (R-02), and
 * `scripts/check-invariants.sh` enforces that no source file asks for the page world.
 *
 * Everything that touches `chrome.*` goes through the {@link UserScriptsApi} and
 * {@link TabsApi} seams so the whole path is testable without a browser.
 */
import type { Userscript, UserscriptRunResult } from '@/src/messaging';
import { matchesAny } from './match-pattern';

/** Captured console cap: enough to debug with, small enough to always ship. */
export const MAX_CONSOLE_LINES = 200;
export const MAX_CONSOLE_BYTES = 64 * 1024;

export type ConsoleLevel = 'log' | 'warn' | 'error';
export type ConsoleLine = UserscriptRunResult['console'][number];

/** The slice of `chrome.userScripts` we use. Faked in tests. */
export interface UserScriptsApi {
  execute<T = unknown>(
    injection: chrome.userScripts.UserScriptInjection,
  ): Promise<chrome.userScripts.InjectionResult<T>[]>;
  configureWorld?(properties: chrome.userScripts.WorldProperties): Promise<void>;
}

/** The slice of `chrome.tabs` we use, to resolve the tab URL for the allow-list check. */
export interface TabsApi {
  get(tabId: number): Promise<{ url?: string }>;
}

export type UnavailableReason = 'toggle-off' | 'unsupported';

export type Availability =
  | { available: true }
  | { available: false; reason: UnavailableReason; message: string };

/** Ambient probes, injectable so availability logic is testable. */
export interface AvailabilityEnv {
  /** Returns the live `chrome.userScripts` namespace. May be `undefined`, may throw. */
  getNamespace(): unknown;
  /** Chrome's major version, or `null` when it cannot be determined. */
  majorVersion(): number | null;
}

/** `execute()` shipped in Chrome 135. Below that there is no live-exec primitive. */
export const MIN_CHROME_VERSION = 135;

export function detectChromeMajorVersion(userAgent?: string): number | null {
  const ua = userAgent ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent);
  const found = /Chrom(?:e|ium)\/(\d+)/.exec(ua ?? '');
  return found ? Number(found[1]) : null;
}

export const defaultAvailabilityEnv: AvailabilityEnv = {
  getNamespace() {
    // Pre-138 this throws when Developer Mode is off; 138+ it is simply undefined
    // when the per-extension "Allow User Scripts" toggle is off.
    return (globalThis as { chrome?: { userScripts?: unknown } }).chrome?.userScripts;
  },
  majorVersion() {
    return detectChromeMajorVersion();
  },
};

/**
 * Why the two reasons differ: an old Chrome cannot run userscripts at all and the
 * user can do nothing but upgrade, whereas `toggle-off` is one switch away — the
 * panel shows different copy for each, so they must be distinguishable.
 */
export function isAvailable(env: AvailabilityEnv = defaultAvailabilityEnv): Availability {
  const version = env.majorVersion();
  if (version !== null && version < MIN_CHROME_VERSION) {
    return {
      available: false,
      reason: 'unsupported',
      message: `chrome.userScripts.execute() needs Chrome ${MIN_CHROME_VERSION}+ (this is Chrome ${version})`,
    };
  }

  let namespace: unknown;
  try {
    namespace = env.getNamespace();
  } catch {
    return { available: false, reason: 'toggle-off', message: TOGGLE_MESSAGE };
  }
  if (namespace === undefined || namespace === null) {
    return { available: false, reason: 'toggle-off', message: TOGGLE_MESSAGE };
  }

  const execute = (namespace as { execute?: unknown }).execute;
  if (typeof execute !== 'function') {
    return {
      available: false,
      reason: 'unsupported',
      message: `chrome.userScripts.execute() is missing; it needs Chrome ${MIN_CHROME_VERSION}+`,
    };
  }

  return { available: true };
}

const TOGGLE_MESSAGE =
  'chrome.userScripts is unavailable: turn on "Allow User Scripts" for this extension at ' +
  'chrome://extensions (Chrome 138+), or Developer Mode on older Chrome, then reload the extension';

/** The real `chrome.userScripts`, or `undefined` when the toggle is off. */
export function chromeUserScriptsApi(): UserScriptsApi | undefined {
  try {
    const namespace = (globalThis as { chrome?: { userScripts?: UserScriptsApi } }).chrome?.userScripts;
    return typeof namespace?.execute === 'function' ? namespace : undefined;
  } catch {
    return undefined;
  }
}

export function chromeTabsApi(): TabsApi | undefined {
  const tabs = (globalThis as { chrome?: { tabs?: { get(id: number): Promise<{ url?: string }> } } }).chrome?.tabs;
  return typeof tabs?.get === 'function' ? { get: (tabId) => tabs.get(tabId) } : undefined;
}

// --- world configuration ----------------------------------------------------

let worldConfigured = false;

/** Test hook: forget that `configureWorld` has already run. */
export function resetWorldConfiguration(): void {
  worldConfigured = false;
}

/**
 * Configures the default USER_SCRIPT world once per service-worker lifetime.
 *
 * `messaging: false` (Chrome's default, stated explicitly here so it cannot drift):
 * with messaging off the world has no `chrome.*` surface at all. We do not need one —
 * `execute()` already returns the script's value through `InjectionResult`, so there
 * is no reason to expose a message channel that a hostile page could probe for, and
 * N-02 rules out outside control of a run anyway.
 *
 * `csp: undefined` keeps the world's default (ISOLATED-equivalent) CSP. Userscript
 * managers widen this to `'unsafe-eval' 'unsafe-inline' *` so hosted scripts can
 * `eval()`; we deliberately do not — our scripts arrive as source and are injected as
 * source, so widening the CSP would only buy an attack surface.
 *
 * Feature-detected: `configureWorld` is Chrome 120+, and absent on the fake APIs used
 * in tests. A failure here is not fatal — the defaults are already what we want.
 */
export async function ensureWorldConfigured(api: UserScriptsApi): Promise<void> {
  if (worldConfigured) return;
  worldConfigured = true;
  if (typeof api.configureWorld !== 'function') return;
  try {
    await api.configureWorld({ messaging: false, csp: undefined });
    await api.configureWorld({ worldId: USERSCRIPT_WORLD_ID, messaging: true, csp: undefined });
  } catch {
    // Older Chrome rejects some property combinations; the defaults still apply.
  }
}

// --- the wrapper ------------------------------------------------------------

/**
 * The payload the wrapper returns through `InjectionResult.result`.
 * Everything in it is JSON-safe: Chrome JSON-serializes the return value.
 */
export interface WrappedOutcome {
  __nanobrowserUserscript: 1;
  ok: boolean;
  value?: unknown;
  error: { name: string; message: string; stack: string | null } | null;
  console: ConsoleLine[];
  truncated: boolean;
  durationMs: number;
}

/**
 * Prefix installed ahead of the user's code. It patches console, listens for
 * uncaught errors and rejections, and restores both in `finally` — no globals are
 * left behind, no listener outlives the run, and the wrapper itself never touches
 * the DOM. What the user's own script does inside its allow-list is its business.
 *
 * The user's code becomes the body of an async function, so it may use `await` and
 * returns its result with a top-level `return`.
 */
/** World that may message the extension. The default world stays messaging-off. */
export const USERSCRIPT_WORLD_ID = 'nanobrowser';

/** Default ceiling so a hung fetch cannot hold the agent forever. */
export const DEFAULT_DEADLINE_MS = 120_000;

export interface WrapOptions {
  deadlineMs?: number;
  args?: unknown;
  /** Tags this run's progress messages. Without one the script streams nothing. */
  progressToken?: string;
}

const WRAPPER_PREFIX_HEAD = `(async () => {
  const __nbG = typeof window !== 'undefined' ? window : globalThis;
  const __nbMaxLines = ${MAX_CONSOLE_LINES};
  const __nbMaxBytes = ${MAX_CONSOLE_BYTES};
  const __nbDeadline = `;

const WRAPPER_PREFIX_TAIL = `;
  // A stop bumps an epoch rather than setting a flag every run clears on start, so
  // starting a second script cannot cancel a stop meant for the first. The partial
  // is per run: a global would hand one run's partial to the next run's timeout.
  const __nbStopEpoch = __nbG.__nbUserscriptStopEpoch || 0;
  let __nbPartial;
  const args = __nbArgs;
  const nb = {
    get stopped() { return (__nbG.__nbUserscriptStopEpoch || 0) !== __nbStopEpoch; },
    get partial() { return __nbPartial; },
    set partial(value) { __nbPartial = value; },
  };
  const __nbLog = [];
  let __nbBytes = 0;
  let __nbTruncated = false;
  const __nbText = function (value) {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.name + ': ' + value.message;
    try { const s = JSON.stringify(value); return s === undefined ? String(value) : s; }
    catch (e) { return String(value); }
  };
  const __nbPush = function (level, args) {
    if (__nbLog.length >= __nbMaxLines || __nbBytes >= __nbMaxBytes) { __nbTruncated = true; return; }
    let text = Array.prototype.map.call(args, __nbText).join(' ');
    const room = __nbMaxBytes - __nbBytes;
    if (text.length > room) { text = text.slice(0, room); __nbTruncated = true; }
    __nbBytes += text.length;
    const line = { level: level, text: text, at: Date.now() };
    __nbLog.push(line);
    try {
      const rt = __nbG.chrome && __nbG.chrome.runtime;
      if (__nbProgressToken && rt && typeof rt.sendMessage === 'function') {
        const sent = rt.sendMessage({ type: 'nanobrowser.userscript.progress', token: __nbProgressToken, level: line.level, text: line.text, at: line.at });
        if (sent && typeof sent.then === 'function') sent.then(undefined, function () {});
      }
    } catch (e) {}
  };
  const __nbConsole = __nbG.console;
  const __nbLevels = { log: 'log', info: 'log', debug: 'log', warn: 'warn', error: 'error' };
  const __nbSaved = {};
  for (const __nbName of Object.keys(__nbLevels)) {
    const __nbLevel = __nbLevels[__nbName];
    const __nbOrig = __nbConsole[__nbName];
    try {
      Object.defineProperty(__nbConsole, __nbName, {
        value: function () {
          __nbPush(__nbLevel, arguments);
          if (typeof __nbOrig === 'function') { try { __nbOrig.apply(__nbConsole, arguments); } catch (e) {} }
        },
        writable: true, configurable: true,
      });
      __nbSaved[__nbName] = __nbOrig;
    } catch (e) { /* non-configurable console method: leave it alone */ }
  }
  const __nbOnError = function (event) {
    __nbPush('error', ['Uncaught ' + __nbText(event && (event.error || event.message))]);
  };
  const __nbOnRejection = function (event) {
    __nbPush('error', ['Unhandled rejection: ' + __nbText(event && event.reason)]);
  };
  const __nbCanListen = typeof __nbG.addEventListener === 'function';
  if (__nbCanListen) {
    __nbG.addEventListener('error', __nbOnError, true);
    __nbG.addEventListener('unhandledrejection', __nbOnRejection, true);
  }
  const __nbStart = Date.now();
  let __nbOk = true;
  let __nbValue;
  let __nbError = null;
  let __nbTimer;
  const __nbTimeout = new Promise(function (_, reject) {
    __nbTimer = setTimeout(function () {
      const err = new Error('userscript timed out after ' + __nbDeadline + 'ms');
      err.__nbTimeout = true;
      reject(err);
    }, __nbDeadline);
  });
  try {
    __nbValue = await Promise.race([
      (async () => {
`;

const WRAPPER_SUFFIX = `
      })(),
      __nbTimeout,
    ]);
  } catch (__nbCaught) {
    if (__nbCaught && __nbCaught.__nbTimeout && __nbPartial !== undefined) {
      __nbOk = true;
      __nbValue = __nbPartial;
      __nbError = null;
    } else {
      __nbOk = false;
      if (__nbPartial !== undefined) __nbValue = __nbPartial;
      __nbError = {
        name: (__nbCaught && __nbCaught.name) || 'Error',
        message: (__nbCaught && __nbCaught.message) || __nbText(__nbCaught),
        stack: (__nbCaught && __nbCaught.stack) || null,
      };
    }
  } finally {
    clearTimeout(__nbTimer);
    for (const __nbName of Object.keys(__nbSaved)) {
      try {
        Object.defineProperty(__nbConsole, __nbName, {
          value: __nbSaved[__nbName], writable: true, configurable: true,
        });
      } catch (e) {}
    }
    if (__nbCanListen) {
      __nbG.removeEventListener('error', __nbOnError, true);
      __nbG.removeEventListener('unhandledrejection', __nbOnRejection, true);
    }
  }
  return {
    __nanobrowserUserscript: 1,
    ok: __nbOk,
    value: __nbValue,
    error: __nbError,
    console: __nbLog,
    truncated: __nbTruncated,
    durationMs: Date.now() - __nbStart,
  };
})();`;

/**
 * Lines the wrapper adds above the user's first line. Derived from the prefix
 * itself so it can never drift out of step with an edit to the wrapper — the
 * debugger subtracts it to map a stack frame back to the user's source.
 */
export function wrapperPrefix(options: WrapOptions = {}): string {
  const deadline = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const args = JSON.stringify(options.args ?? {});
  const token = JSON.stringify(options.progressToken ?? '');
  return `${WRAPPER_PREFIX_HEAD}${deadline};\n  const __nbArgs = ${args};\n  const __nbProgressToken = ${token}${WRAPPER_PREFIX_TAIL}`;
}

/** Lines the wrapper adds above the user's first line, for the default wrap. */
export const WRAPPER_LINE_OFFSET = wrapperPrefix().split('\n').length - 1;

/** Wraps user code for capture. Column 1 of user line 1 stays column 1: no indent. */
export function wrapUserscript(code: string, options?: WrapOptions): string {
  return wrapperPrefix(options) + code + WRAPPER_SUFFIX;
}

export interface SourceLocation {
  line: number;
  column: number;
}

/**
 * Pulls the first `:line:column` out of a stack and rebases it onto the user's
 * source. Frames above the user's first line (i.e. inside the wrapper) are not
 * reportable as user locations, so they are dropped.
 */
export function parseErrorLocation(
  stack: string | null | undefined,
  lineOffset: number = WRAPPER_LINE_OFFSET,
): SourceLocation | null {
  if (!stack) return null;
  const pattern = /:(\d+):(\d+)/g;
  let found: RegExpExecArray | null;
  while ((found = pattern.exec(stack)) !== null) {
    const line = Number(found[1]) - lineOffset;
    const column = Number(found[2]);
    if (line >= 1) return { line, column };
  }
  return null;
}

/** `"TypeError: x is not a function (line 3, column 9)"` when a location is derivable. */
export function formatWrappedError(error: WrappedOutcome['error']): string {
  if (!error) return 'userscript failed';
  const head = error.message.startsWith(error.name) ? error.message : `${error.name}: ${error.message}`;
  const where = parseErrorLocation(error.stack);
  return where ? `${head} (line ${where.line}, column ${where.column})` : head;
}

// --- running ----------------------------------------------------------------

export interface RunUserscriptOptions {
  tabId: number;
  script: Userscript;
  /** Overrides `script.code` for this run only — R-10's edit-and-re-run-in-place. */
  code?: string;
  /** The tab's URL. Resolved through {@link TabsApi} when omitted. */
  url?: string;
  /** Bound as `args` inside the script. */
  args?: unknown;
  /** Overrides the 120s ceiling for this run. */
  deadlineMs?: number;
  /**
   * Streams this run's console lines to the progress listener while it runs. Only
   * agent runs set it, so a panel run never lands in an agent run's log.
   */
  reportProgress?: boolean;
  api?: UserScriptsApi;
  tabs?: TabsApi;
  env?: AvailabilityEnv;
  now?: () => number;
}

function failure(
  scriptId: string,
  error: string,
  durationMs = 0,
  consoleLines: UserscriptRunResult['console'] = [],
): UserscriptRunResult {
  return { scriptId, ok: false, error, console: consoleLines, durationMs };
}

/**
 * Runs one userscript in the tab and returns everything the panel and the run log
 * need: the value, the captured console, any error, and how long it took.
 *
 * Refuses before injecting anything if the API is unavailable or the tab's URL is
 * outside the script's allow-list. The allow-list is the only thing standing between
 * a stored script and every page the user has open, so it is checked here and not
 * left to the caller.
 */
export async function runUserscript(options: RunUserscriptOptions): Promise<UserscriptRunResult> {
  const { tabId, script } = options;
  const now = options.now ?? Date.now;
  const scriptId = script.id;

  const api = options.api ?? chromeUserScriptsApi();
  const availability = isAvailable(
    options.env ?? (options.api ? { getNamespace: () => options.api, majorVersion: () => null } : defaultAvailabilityEnv),
  );
  if (!availability.available) return failure(scriptId, `${availability.reason}: ${availability.message}`);
  if (!api) return failure(scriptId, `toggle-off: ${TOGGLE_MESSAGE}`);

  let url = options.url;
  if (url === undefined) {
    const tabs = options.tabs ?? chromeTabsApi();
    if (!tabs) return failure(scriptId, 'cannot resolve the tab URL: chrome.tabs is unavailable');
    try {
      url = (await tabs.get(tabId)).url;
    } catch (error) {
      return failure(scriptId, `cannot resolve the tab URL: ${describe(error)}`);
    }
  }
  if (!url) return failure(scriptId, 'cannot resolve the tab URL');
  if (!matchesAny(script.matches, url)) {
    return failure(scriptId, `refused: ${url} is not in this script's allow-list (${script.matches.join(', ')})`);
  }

  await ensureWorldConfigured(api);

  // Each execution gets its own token, so overlapping runs keep their own script id
  // and one finishing never unregisters another.
  const progressToken = options.reportProgress ? `${scriptId}:${++progressCounter}` : undefined;
  if (progressToken) activeProgress.set(progressToken, scriptId);
  const started = now();
  const source = options.code ?? script.code;
  let results: chrome.userScripts.InjectionResult<WrappedOutcome>[];
  try {
    results = await api.execute<WrappedOutcome>({
      target: { tabId },
      js: [
        {
          code: wrapUserscript(source, {
            args: options.args,
            deadlineMs: options.deadlineMs,
            ...(progressToken ? { progressToken } : {}),
          }),
        },
      ],
      world: 'USER_SCRIPT',
      worldId: USERSCRIPT_WORLD_ID,
      injectImmediately: true,
    });
  } catch (error) {
    return failure(scriptId, describe(error), now() - started);
  } finally {
    if (progressToken) activeProgress.delete(progressToken);
  }

  const elapsed = now() - started;
  const first = results?.[0];
  if (!first) return failure(scriptId, 'no injection result: the tab may have navigated away', elapsed);
  if (first.error) return failure(scriptId, rebaseInjectionError(first.error), elapsed);

  const outcome = first.result;
  if (!outcome || outcome.__nanobrowserUserscript !== 1) {
    return failure(scriptId, 'unrecognised injection result', elapsed);
  }

  const captured = outcome.console ?? [];
  const consoleLines = outcome.truncated
    ? [...captured, { level: 'warn' as const, text: '[output truncated]', at: now() }]
    : captured;

  // These failures come after the script ran, so its console is still the best clue.
  if (outcome.ok && outcome.value === undefined && looksLikeIife(source)) {
    return failure(
      scriptId,
      'this script returns nothing. Return the JSON from the top level instead of wrapping it in a function.',
      elapsed,
      consoleLines,
    );
  }
  const jsonProblem = nonJsonReturn(outcome.value);
  if (jsonProblem) return failure(scriptId, jsonProblem, elapsed, consoleLines);

  return {
    scriptId,
    ok: outcome.ok,
    value: outcome.value,
    error: outcome.ok ? undefined : formatWrappedError(outcome.error),
    console: consoleLines,
    durationMs: outcome.durationMs ?? elapsed,
  };
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function rebaseInjectionError(error: string): string {
  const where = parseErrorLocation(error);
  return where ? `${error} (line ${where.line}, column ${where.column})` : error;
}

function looksLikeIife(code: string): boolean {
  const head = code.trimStart();
  return (
    head.startsWith('(function') ||
    head.startsWith('(async function') ||
    head.startsWith('(()') ||
    head.startsWith('(async ()') ||
    head.startsWith('!function')
  );
}

/** Chrome JSON-serializes the return. A DOM node or a cyclic value must be an error, not `{}`. */
function nonJsonReturn(value: unknown): string | null {
  if (value === undefined || value === null || typeof value !== 'object') return null;
  if (typeof (value as { nodeType?: unknown }).nodeType === 'number') {
    const name = (value as { nodeName?: string }).nodeName || 'DOM node';
    return `return value is a ${name}, which cannot be sent back. Return plain JSON.`;
  }
  try {
    JSON.stringify(value);
  } catch (error) {
    return `return value is not JSON (${describe(error)})`;
  }
  return null;
}

export interface ProgressLine {
  level: ConsoleLevel;
  text: string;
  at: number;
}

/** Progress token -> script id, for executions that stream progress. */
const activeProgress = new Map<string, string>();
let progressCounter = 0;
let progressListener: ((scriptId: string, line: ProgressLine) => void) | undefined;

/** The run manager subscribes so console lines reach the log before the script returns. */
export function setUserscriptProgressListener(
  listener: ((scriptId: string, line: ProgressLine) => void) | undefined,
): void {
  progressListener = listener;
}

/** Called from the extension when a userscript world messages `nanobrowser.userscript.progress`. */
export function notifyUserscriptProgress(message: {
  token?: unknown;
  level?: unknown;
  text?: unknown;
  at?: unknown;
}): void {
  const scriptId = typeof message.token === 'string' ? activeProgress.get(message.token) : undefined;
  if (!progressListener || !scriptId) return;
  const level = message.level === 'warn' || message.level === 'error' ? message.level : 'log';
  progressListener(scriptId, {
    level,
    text: String(message.text ?? ''),
    at: typeof message.at === 'number' ? message.at : Date.now(),
  });
}

/** Sets the stop flag in the userscript world. `execute()` itself cannot be aborted. */
export async function signalUserscriptStop(tabId: number, api?: UserScriptsApi): Promise<void> {
  const userScripts = api ?? chromeUserScriptsApi();
  if (!userScripts) return;
  await userScripts.execute({
    target: { tabId },
    world: 'USER_SCRIPT',
    worldId: USERSCRIPT_WORLD_ID,
    injectImmediately: true,
    js: [{ code: 'globalThis.__nbUserscriptStopEpoch = (globalThis.__nbUserscriptStopEpoch || 0) + 1;' }],
  });
}
