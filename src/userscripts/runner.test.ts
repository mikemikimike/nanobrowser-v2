// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { Userscript } from '@/src/messaging';
import {
  MAX_CONSOLE_LINES,
  WRAPPER_LINE_OFFSET,
  detectChromeMajorVersion,
  isAvailable,
  parseErrorLocation,
  notifyUserscriptProgress,
  resetWorldConfiguration,
  runUserscript,
  setUserscriptProgressListener,
  wrapUserscript,
} from './runner';
import { availableEnv, vmUserScriptsApi } from './testing';

function script(code: string, matches = ['*://hyperagent.com/*']): Userscript {
  return { id: 'script-1', name: 'probe', matches, code, updatedAt: 0 };
}

const URL_IN_SCOPE = 'https://hyperagent.com/threads';

describe('runUserscript', () => {
  beforeEach(() => {
    resetWorldConfiguration();
  });

  it('injects into the USER_SCRIPT world, immediately, in the named tab', async () => {
    const api = vmUserScriptsApi();
    await runUserscript({ tabId: 7, script: script('return 1;'), url: URL_IN_SCOPE, api });

    expect(api.injections).toHaveLength(1);
    const injection = api.injections[0]!;
    expect(injection.world).toBe('USER_SCRIPT');
    expect(injection.injectImmediately).toBe(true);
    expect(injection.target).toEqual({ tabId: 7 });
    expect(injection.js[0].code).toContain('return 1;');
  });

  it('configures the world once, with messaging off and the default CSP', async () => {
    const api = vmUserScriptsApi();
    await runUserscript({ tabId: 1, script: script('return 1;'), url: URL_IN_SCOPE, api });
    await runUserscript({ tabId: 1, script: script('return 2;'), url: URL_IN_SCOPE, api });

    expect(api.worldConfigs).toEqual([
      { messaging: false, csp: undefined },
      { worldId: 'nanobrowser', messaging: true, csp: undefined },
    ]);
  });

  it('returns the script value and the captured console lines', async () => {
    const api = vmUserScriptsApi();
    const result = await runUserscript({
      tabId: 1,
      url: URL_IN_SCOPE,
      api,
      script: script(
        [
          "console.log('hello', 1, { a: 2 });",
          "console.info('info becomes log');",
          "console.warn('careful');",
          "console.error('bad');",
          'return { answer: 42 };',
        ].join('\n'),
      ),
    });

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({ answer: 42 });
    expect(result.console.map((line) => [line.level, line.text])).toEqual([
      ['log', 'hello 1 {"a":2}'],
      ['log', 'info becomes log'],
      ['warn', 'careful'],
      ['error', 'bad'],
    ]);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('awaits a promise the script returns', async () => {
    const api = vmUserScriptsApi();
    const result = await runUserscript({
      tabId: 1,
      url: URL_IN_SCOPE,
      api,
      script: script('await new Promise((resolve) => setTimeout(resolve, 1));\nreturn "settled";'),
    });

    expect(result.ok).toBe(true);
    expect(result.value).toBe('settled');
  });

  it('reports a thrown error at the user’s own line and column', async () => {
    const api = vmUserScriptsApi();
    const result = await runUserscript({
      tabId: 1,
      url: URL_IN_SCOPE,
      api,
      script: script(["const a = 1;", "throw new Error('boom');"].join('\n')),
    });

    expect(result.ok).toBe(false);
    // Line 2 of the user's source, not line 2 + the wrapper's prefix.
    expect(result.error).toMatch(/^Error: boom \(line 2, column \d+\)$/);
    expect(WRAPPER_LINE_OFFSET).toBeGreaterThan(10);
  });

  it('captures an uncaught error event raised while the script runs', async () => {
    const api = vmUserScriptsApi();
    const result = await runUserscript({
      tabId: 1,
      url: URL_IN_SCOPE,
      api,
      script: script("window.dispatchEvent(new ErrorEvent('error', { message: 'late boom' }));\nreturn 'done';"),
    });

    expect(result.ok).toBe(true);
    expect(result.console).toEqual([
      expect.objectContaining({ level: 'error', text: 'Uncaught late boom' }),
    ]);
  });

  it('leaves no patched console and no listener behind', async () => {
    const api = vmUserScriptsApi();
    const before = { log: console.log, warn: console.warn, error: console.error };

    const captured: string[] = [];
    const listener = (event: Event) => captured.push(event.type);
    await runUserscript({ tabId: 1, script: script("console.log('x'); return 1;"), url: URL_IN_SCOPE, api });

    expect(console.log).toBe(before.log);
    expect(console.warn).toBe(before.warn);
    expect(console.error).toBe(before.error);

    // Nothing the wrapper installed is still listening after the run.
    window.addEventListener('error', listener, true);
    window.dispatchEvent(new ErrorEvent('error', { message: 'after' }));
    window.removeEventListener('error', listener, true);
    expect(captured).toEqual(['error']);
  });

  it('caps the captured console at 200 lines and flags the truncation', async () => {
    const api = vmUserScriptsApi();
    const result = await runUserscript({
      tabId: 1,
      url: URL_IN_SCOPE,
      api,
      script: script('for (let i = 0; i < 300; i += 1) console.log("line " + i);\nreturn 300;'),
    });

    expect(result.ok).toBe(true);
    expect(result.console).toHaveLength(MAX_CONSOLE_LINES + 1);
    expect(result.console[MAX_CONSOLE_LINES]!).toMatchObject({ level: 'warn', text: '[output truncated]' });
    expect(result.console[0]!.text).toBe('line 0');
  });

  it('caps a single huge line at 64 KiB', async () => {
    const api = vmUserScriptsApi();
    const result = await runUserscript({
      tabId: 1,
      url: URL_IN_SCOPE,
      api,
      script: script('console.log("x".repeat(70000));\nreturn "ok";'),
    });

    expect(result.console[0]!.text).toHaveLength(64 * 1024);
    expect(result.console.at(-1)).toMatchObject({ text: '[output truncated]' });
  });

  it('refuses to inject into a URL outside the allow-list', async () => {
    const api = vmUserScriptsApi();
    const result = await runUserscript({
      tabId: 1,
      script: script('return 1;'),
      url: 'https://example.com/threads',
      api,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/refused: https:\/\/example\.com\/threads is not in this script's allow-list/);
    expect(api.injections).toHaveLength(0);
  });

  it('resolves the tab URL through the tabs seam when the caller has not', async () => {
    const api = vmUserScriptsApi();
    const tabs = { get: async (tabId: number) => ({ url: tabId === 5 ? URL_IN_SCOPE : 'https://example.com/' }) };

    await expect(runUserscript({ tabId: 5, script: script('return 1;'), api, tabs })).resolves.toMatchObject({ ok: true });
    await expect(runUserscript({ tabId: 6, script: script('return 1;'), api, tabs })).resolves.toMatchObject({
      ok: false,
    });
  });

  it('refuses with toggle-off when chrome.userScripts is missing or throws', async () => {
    const missing = await runUserscript({
      tabId: 1,
      script: script('return 1;'),
      url: URL_IN_SCOPE,
      env: { getNamespace: () => undefined, majorVersion: () => 140 },
    });
    expect(missing.error).toMatch(/^toggle-off: .*Allow User Scripts/);

    const throwing = await runUserscript({
      tabId: 1,
      script: script('return 1;'),
      url: URL_IN_SCOPE,
      env: {
        getNamespace: () => {
          throw new Error('User Scripts API is not available');
        },
        majorVersion: () => 137,
      },
    });
    expect(throwing.error).toMatch(/^toggle-off: /);
  });

  it('refuses with unsupported below Chrome 135', async () => {
    const api = vmUserScriptsApi();
    const result = await runUserscript({
      tabId: 1,
      script: script('return 1;'),
      url: URL_IN_SCOPE,
      api,
      env: { getNamespace: () => api, majorVersion: () => 134 },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^unsupported: .*Chrome 135\+/);
    expect(api.injections).toHaveLength(0);
  });

  it('surfaces a per-frame injection error unchanged', async () => {
    const result = await runUserscript({
      tabId: 1,
      script: script('return 1;'),
      url: URL_IN_SCOPE,
      api: {
        execute: async () => [{ documentId: 'd', frameId: 0, error: 'Frame with ID 0 was removed.' }] as never,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Frame with ID 0 was removed.');
  });
});

describe('availability helpers', () => {
  it('reads the Chrome major version out of a user agent', () => {
    expect(detectChromeMajorVersion('Mozilla/5.0 ... Chrome/141.0.0.0 Safari/537.36')).toBe(141);
    expect(detectChromeMajorVersion('Mozilla/5.0 ... Firefox/130.0')).toBeNull();
  });

  it('reports unsupported when the namespace exists but execute() does not', () => {
    expect(isAvailable({ getNamespace: () => ({ register: () => {} }), majorVersion: () => 140 })).toEqual({
      available: false,
      reason: 'unsupported',
      message: expect.stringContaining('Chrome 135+'),
    });
  });

  it('reports available for a healthy namespace', () => {
    expect(isAvailable(availableEnv({ execute: () => {} }))).toEqual({ available: true });
  });
});

describe('wrapper mechanics', () => {
  it('puts the user’s first line at column 1 of a known offset', () => {
    const wrapped = wrapUserscript('return 1;');
    const lines = wrapped.split('\n');
    expect(lines[WRAPPER_LINE_OFFSET]!).toBe('return 1;');
  });

  it('drops stack frames that fall inside the wrapper', () => {
    expect(parseErrorLocation(`Error: x\n    at userscript.js:${WRAPPER_LINE_OFFSET + 3}:9`)).toEqual({
      line: 3,
      column: 9,
    });
    expect(parseErrorLocation('Error: x\n    at userscript.js:2:9')).toBeNull();
    expect(parseErrorLocation(null)).toBeNull();
  });
});

describe('runUserscript progress, stop, and bad returns', () => {
  beforeEach(() => {
    resetWorldConfiguration();
  });

  it('sends a console line before the script returns', async () => {
    const seen: string[] = [];
    const previous = (globalThis as { chrome?: unknown }).chrome;
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { sendMessage: (message: { text?: string }) => seen.push(String(message.text)) },
    };
    try {
      const result = await runUserscript({
        tabId: 1,
        script: script("console.log('before'); await Promise.resolve(); return seenLength;".replace('seenLength', String(0))),
        url: URL_IN_SCOPE,
        reportProgress: true,
        api: vmUserScriptsApi(),
      });
      expect(seen).toContain('before');
      expect(result.ok).toBe(true);
    } finally {
      (globalThis as { chrome?: unknown }).chrome = previous;
    }
  });

  it('stops between two fetches and does not start the second', async () => {
    const urls: string[] = [];
    const previous = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith('/a')) {
        const g = globalThis as { __nbUserscriptStopEpoch?: number };
        g.__nbUserscriptStopEpoch = (g.__nbUserscriptStopEpoch ?? 0) + 1;
      }
      return new Response('ok');
    }) as typeof fetch;
    try {
      const result = await runUserscript({
        tabId: 1,
        script: script(`
          await fetch('/a');
          if (nb.stopped) return { stopped_early: true };
          await fetch('/b');
          return { stopped_early: false };
        `),
        url: URL_IN_SCOPE,
        api: vmUserScriptsApi(),
      });
      expect(result.ok).toBe(true);
      expect(result.value).toEqual({ stopped_early: true });
      expect(urls).toEqual(['/a']);
    } finally {
      globalThis.fetch = previous;
    }
  });

  it('returns the partial when the deadline passes and leaves the fetch pending', async () => {
    let finished = false;
    let finish: (() => void) | undefined;
    const previous = globalThis.fetch;
    globalThis.fetch = (() =>
      new Promise((resolve) => {
        finish = () => {
          finished = true;
          resolve(new Response('late'));
        };
      })) as typeof fetch;
    try {
      const result = await runUserscript({
        tabId: 1,
        script: script(`
          nb.partial = { summary: [], meta: { stopped_early: true, reason: 'timeout' }, log: [], rows: [] };
          await fetch('/slow');
          return { late: true };
        `),
        url: URL_IN_SCOPE,
        deadlineMs: 30,
        api: vmUserScriptsApi(),
      });
      expect(finished).toBe(false);
      expect(result.ok).toBe(true);
      expect(result.value).toMatchObject({ meta: { stopped_early: true, reason: 'timeout' } });
      finish?.();
      expect(finished).toBe(true);
    } finally {
      globalThis.fetch = previous;
    }
  });

  it('streams nothing from a run that did not ask to report progress, such as a panel run', async () => {
    const seen: string[] = [];
    const previous = (globalThis as { chrome?: unknown }).chrome;
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { sendMessage: (message: { text?: string }) => seen.push(String(message.text)) },
    };
    try {
      const result = await runUserscript({
        tabId: 1,
        script: script("console.log('panel line'); return 1;"),
        url: URL_IN_SCOPE,
        api: vmUserScriptsApi(),
      });
      expect(result.ok).toBe(true);
      expect(seen).toEqual([]);
    } finally {
      (globalThis as { chrome?: unknown }).chrome = previous;
    }
  });

  it('attributes progress to the execution that sent it and ignores unknown tokens', async () => {
    const heard: Array<[string, string]> = [];
    setUserscriptProgressListener((scriptId, line) => heard.push([scriptId, line.text]));
    const previous = (globalThis as { chrome?: unknown }).chrome;
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { sendMessage: (message: { token?: unknown; text?: unknown }) => notifyUserscriptProgress(message) },
    };
    try {
      await runUserscript({
        tabId: 1,
        script: { ...script("console.log('from agent'); return 1;"), id: 'agent-script' },
        url: URL_IN_SCOPE,
        reportProgress: true,
        api: vmUserScriptsApi(),
      });
      notifyUserscriptProgress({ token: 'agent-script:999', text: 'stale' });
      expect(heard).toEqual([['agent-script', 'from agent']]);
    } finally {
      setUserscriptProgressListener(undefined);
      (globalThis as { chrome?: unknown }).chrome = previous;
    }
  });

  it('keeps a stop for the running script when another script starts before it checks', async () => {
    const previous = globalThis.fetch;
    const other: Array<Promise<unknown>> = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/a')) {
        const g = globalThis as { __nbUserscriptStopEpoch?: number };
        g.__nbUserscriptStopEpoch = (g.__nbUserscriptStopEpoch ?? 0) + 1;
        other.push(runUserscript({ tabId: 1, script: script('return nb.stopped;'), url: URL_IN_SCOPE, api: vmUserScriptsApi() }));
      }
      return new Response('ok');
    }) as typeof fetch;
    try {
      const first = await runUserscript({
        tabId: 1,
        script: script(`await fetch('/a'); return nb.stopped;`),
        url: URL_IN_SCOPE,
        api: vmUserScriptsApi(),
      });
      const second = (await other[0]) as { value: unknown };
      expect(first.value).toBe(true);
      expect(second.value).toBe(false);
    } finally {
      globalThis.fetch = previous;
    }
  });

  it('does not hand one run\'s partial to the next run that fails', async () => {
    await runUserscript({
      tabId: 1,
      script: script("nb.partial = { rows: ['old'] }; return 1;"),
      url: URL_IN_SCOPE,
      api: vmUserScriptsApi(),
    });
    const result = await runUserscript({
      tabId: 1,
      script: script("throw new Error('boom');"),
      url: URL_IN_SCOPE,
      api: vmUserScriptsApi(),
    });
    expect(result.ok).toBe(false);
    expect(result.value).toBeUndefined();
  });

  it('keeps the console when a return value is rejected after the run', async () => {
    const result = await runUserscript({
      tabId: 1,
      script: script("console.log('got here'); return document.createElement('div');"),
      url: URL_IN_SCOPE,
      api: vmUserScriptsApi(),
    });
    expect(result.ok).toBe(false);
    expect(result.console.map((line) => line.text)).toContain('got here');
  });

  it('reports an IIFE that returns nothing', async () => {
    const result = await runUserscript({
      tabId: 1,
      script: script('(function () { return { rows: [] }; })();'),
      url: URL_IN_SCOPE,
      api: vmUserScriptsApi(),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Return the JSON');
  });

  it('names the type when the script returns a DOM node', async () => {
    const result = await runUserscript({
      tabId: 1,
      script: script("return document.createElement('div');"),
      url: URL_IN_SCOPE,
      api: vmUserScriptsApi(),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('DIV');
  });

  it('reports a syntax error on the user line, not the wrapper line', async () => {
    const api = vmUserScriptsApi();
    api.execute = async () =>
      [{ documentId: 'doc-1', frameId: 0, error: `userscript.js:${WRAPPER_LINE_OFFSET + 12}:1 SyntaxError: Unexpected token` }] as never;
    const result = await runUserscript({
      tabId: 1,
      script: script('return 1;'),
      url: URL_IN_SCOPE,
      api,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('line 12');
    expect(result.error).not.toContain(`line ${WRAPPER_LINE_OFFSET + 12}`);
  });
});
