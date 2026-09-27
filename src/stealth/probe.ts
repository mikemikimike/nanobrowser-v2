/**
 * The project's own stealth probe (M7).
 *
 * Public suites return green for unpatched Puppeteer since Chrome 138 and prove
 * nothing (docs/research/bot-detection-research.md), so the signals that matter
 * for *this* extension are collected here, against the page scope the extension
 * actually drives. Each check reports an observation; only the signals with an
 * absolute clean-room answer (`webdriver` true, coalesced events present on a secure
 * page, no extension leak into page scope, no automation globals, no throwing
 * property reads or key enumeration) raise `anomalous`. The structural checks
 * (`error-stack-accessor` data-or-inherited readings, `proxy-ownkeys` counts) are
 * differential evidence — run early vs late, or clean profile vs driven run — and
 * say so in their detail rather than crying wolf on a single sample.
 *
 * `ProbeScope` is deliberately structural, not `Window`: production passes the
 * page scope, tests pass fakes with planted signals, and the detection logic is
 * what gets proven — not the browser it ran in.
 */
export interface ProbeNavigator {
  [key: string]: unknown;
}

export interface ProbeScope {
  /** The page's `navigator`. */
  navigator?: ProbeNavigator;
  /** `Object.getOwnPropertyDescriptor(new Error(), 'stack')` from the page scope. */
  errorInstanceStackDescriptor?: PropertyDescriptor;
  /** Whether `PointerEvent.prototype.getCoalescedEvents` exists in the page scope. */
  pointerEventHasCoalesced?: boolean;
  /** The page's `window.isSecureContext`. Coalesced events are a secure-context API,
   * so absence outside one is expected, not anomalous. */
  isSecureContext?: boolean;
  /** `window.chrome?.runtime` as seen from page scope. Must be absent: the
   * extension lives in the ISOLATED world and must not leak into the page. */
  pageChromeRuntime?: unknown;
  /** Own property names of the page global (for the automation-globals scan). */
  globalNames?: string[];
}

export interface ProbeFinding {
  /** One of {@link PROBE_CHECKS}. */
  check: string;
  /** What was seen, in one short line for the run log. */
  observed: string;
  /** True only for signals with an absolute clean-room answer (see above). */
  anomalous: boolean;
  /** Why this reading means what it means. */
  detail: string;
}

/** Every signal this probe covers. A test pins the list so none rots away silently. */
export const PROBE_CHECKS = [
  'webdriver',
  'error-stack-accessor',
  'proxy-ownkeys',
  'main-world-execution',
  'playwright-init-globals',
  'coalesced-events',
] as const;

/** Globals no clean page defines but automation harnesses have left behind. */
export const SUSPECT_GLOBALS = [
  '__playwright',
  '__playwright_builtins__',
  '__playwright__binding__',
  '__playwright__binding__controller__',
  '__pwInitScripts',
  '__pw_fn_',
  '__pwClock',
  '__pwWebAuthnBinding',
  '__puppeteer',
  '__nightmare',
  '_selenium',
  'callPhantom',
];

const NAVIGATOR_PROBE_PROPS = ['userAgent', 'plugins', 'languages', 'hardwareConcurrency', 'deviceMemory'];

export function runStealthProbe(scope: ProbeScope): ProbeFinding[] {
  const findings: ProbeFinding[] = [];

  // 1. webdriver: the VALUE is the tell. Clean Chrome/Firefox inherit
  // `navigator.webdriver === false` from the prototype, so presence alone flags
  // every clean browser. Only `true` — or a throwing `has`/`get` trap, which
  // would otherwise abort the probe before the proxy check runs — is anomalous.
  if (!scope.navigator) {
    findings.push({
      check: 'webdriver',
      observed: 'no navigator in scope',
      anomalous: false,
      detail: 'nothing to read; the live probe always runs with a real navigator',
    });
  } else {
    let trap: string | undefined;
    let present = false;
    let value: unknown;
    try {
      present = 'webdriver' in scope.navigator;
    } catch {
      trap = 'has';
    }
    if (trap === undefined) {
      try {
        value = scope.navigator.webdriver;
      } catch {
        trap = 'get';
      }
    }
    const automated = value === true;
    findings.push({
      check: 'webdriver',
      observed:
        trap !== undefined
          ? `webdriver ${trap} trap threw`
          : `webdriver ${present ? `present, value ${String(value)}` : 'absent'}`,
      anomalous: trap !== undefined || automated,
      detail: 'clean browsers inherit webdriver === false; true means driven, a throw means interposed',
    });
  }

  // 2. Error.stack accessor on the instance: stock V8 exposes it as an own NATIVE
  // accessor pair, so accessor-ness alone flags every clean browser. The tell is a
  // CUSTOM getter — JavaScript watching stack reads (a known instrumentation hook).
  const descriptor = scope.errorInstanceStackDescriptor;
  const get = descriptor?.get;
  let native = false;
  if (typeof get === 'function') {
    try {
      native = /\[native code\]/.test(Function.prototype.toString.call(get));
    } catch {
      native = false;
    }
  }
  const hooked = typeof get === 'function' && !native;
  const isAccessor = !!descriptor && (typeof get === 'function' || typeof descriptor.set === 'function');
  findings.push({
    check: 'error-stack-accessor',
    observed: !descriptor
      ? 'no own stack property on a fresh error'
      : hooked
        ? 'own stack CUSTOM ACCESSOR on a fresh error (injected hook)'
        : isAccessor
          ? 'own stack native accessor on a fresh error (stock V8)'
          : 'own stack data property on a fresh error',
    anomalous: hooked,
    detail: 'only a custom getter is conclusive; native-or-data readings are differential evidence against a clean baseline',
  });

  // 3. Proxy traps around navigator: reading ordinary properties must never
  // throw, and neither must enumerating them. A throw means something interposes
  // on access — the shape a `Proxy` around `navigator` takes when its traps are
  // incomplete. The key count is differential evidence (compare runs), not a verdict.
  if (!scope.navigator) {
    findings.push({
      check: 'proxy-ownkeys',
      observed: 'no navigator in scope',
      anomalous: false,
      detail: 'nothing to read; the live probe always runs with a real navigator',
    });
  } else {
    let threw: string | undefined;
    let read = 0;
    for (const prop of NAVIGATOR_PROBE_PROPS) {
      try {
        void (scope.navigator as Record<string, unknown>)[prop];
        read += 1;
      } catch {
        threw = prop;
        break;
      }
    }
    let keys: string[] | undefined;
    if (threw === undefined) {
      try {
        keys = Object.keys(scope.navigator);
      } catch {
        threw = '[[ownKeys]]';
      }
    }
    findings.push({
      check: 'proxy-ownkeys',
      observed: threw
        ? `navigator.${threw} threw`
        : `read ${read}/${NAVIGATOR_PROBE_PROPS.length} cleanly; enumerated ${keys?.length ?? 0} keys`,
      anomalous: threw !== undefined,
      detail: 'ordinary navigator reads and enumeration never throw on a clean browser; a throw is an interposed trap',
    });
  }

  // 4. MAIN-world execution leak: this probe runs in page scope. `chrome.runtime`
  // visible here means extension context is bleeding into the page (or the probe
  // is running in the wrong world, which is itself worth knowing).
  const leaked = scope.pageChromeRuntime !== undefined;
  findings.push({
    check: 'main-world-execution',
    observed: leaked ? 'chrome.runtime visible in page scope' : 'chrome.runtime not visible in page scope',
    anomalous: leaked,
    detail: 'the extension injects into the ISOLATED world only; the page must never see chrome.runtime',
  });

  // 5. Playwright/puppeteer init leftovers: best-effort name scan. Documented as
  // advisory — exotic harnesses use other names — but a hit is conclusive.
  const names = scope.globalNames ?? [];
  const hits = SUSPECT_GLOBALS.filter((g) => names.includes(g));
  findings.push({
    check: 'playwright-init-globals',
    observed: hits.length > 0 ? `automation globals present: ${hits.join(', ')}` : 'no known automation globals',
    anomalous: hits.length > 0,
    detail: 'absence proves nothing (renamed harnesses exist); presence proves automation',
  });

  // 6. getCoalescedEvents: real Chrome ships it on PointerEvent; stripped and
  // headless-mangled builds drop it. But it is a secure-context API, and this
  // extension drives plain HTTP pages too — where absence is expected, not a tell.
  if (scope.pointerEventHasCoalesced === undefined) {
    findings.push({
      check: 'coalesced-events',
      observed: 'unknown (not provided)',
      anomalous: false,
      detail: 'the live probe always provides this; unknown only happens in a partial scope',
    });
  } else if (scope.pointerEventHasCoalesced) {
    findings.push({
      check: 'coalesced-events',
      observed: 'PointerEvent.getCoalescedEvents present',
      anomalous: false,
      detail: 'genuine desktop Chrome has coalesced events; stripped builds do not',
    });
  } else if (scope.isSecureContext === false) {
    findings.push({
      check: 'coalesced-events',
      observed: 'PointerEvent.getCoalescedEvents missing on an insecure page (expected)',
      anomalous: false,
      detail: 'secure-context APIs may be absent over plain HTTP; absence there proves nothing',
    });
  } else {
    findings.push({
      check: 'coalesced-events',
      observed: 'PointerEvent.getCoalescedEvents MISSING',
      anomalous: true,
      detail:
        scope.isSecureContext === undefined
          ? 'genuine desktop Chrome has coalesced events; provide isSecureContext to rule out plain HTTP'
          : 'genuine desktop Chrome has coalesced events; stripped builds do not',
    });
  }

  return findings;
}

/** The check names that came back anomalous. Empty means a clean page. */
export function probeAnomalies(findings: ProbeFinding[]): string[] {
  return findings.filter((f) => f.anomalous).map((f) => f.check);
}
