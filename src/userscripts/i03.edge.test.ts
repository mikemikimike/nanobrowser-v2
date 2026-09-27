// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://hyperagent.com/threads?tab=all" }
/**
 * Strengthens two tests the review found tautological in `i03.test.ts`:
 *
 * 1. "reports what the world can reach on the page" asserted
 *    `report.extensionApis` with `expect.any(Boolean)` for all four fields, which
 *    passes whichever way each field comes out. This file asserts exact values
 *    instead -- but a straight `{chrome:false,...}` assertion in *this* harness
 *    would itself be misleading: `vmUserScriptsApi()` runs the probe with
 *    `vm.runInThisContext`, which shares this process's real global object, and
 *    WXT's vitest plugin installs a `globalThis.chrome` shim for every test file
 *    regardless of environment (verified directly: a plain `typeof (globalThis
 *    as any).chrome` here is `'object'`, with `runtime`/`tabs`/`userScripts` all
 *    present). So without control, this probe would report `chrome: true` in
 *    every test in this suite -- not because the USER_SCRIPT world leaks
 *    anything, but because the *test harness itself* is not the isolated world
 *    Chrome provides in production. That gap can't be closed here (same class
 *    of limitation as R-02's standing "not proved against a real detector"
 *    caveat) -- so this file controls `globalThis.chrome` directly and proves
 *    the report-construction logic responds correctly to what it actually finds,
 *    which is the part a unit test *can* prove.
 * 2. "gates the one network request behind an explicit opt-in" only checked the
 *    generated source string for `const DO_FETCH = false/true;` -- a
 *    string-containment tautology that never executes the probe. This file runs
 *    the real probe with a spied `fetch` and proves no request is made without
 *    opt-in, and exactly one is made with it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { probePageAccess } from './i03';
import { resetWorldConfiguration } from './runner';
import { vmUserScriptsApi } from './testing';

const URL = 'https://hyperagent.com/threads?tab=all';

let savedChrome: unknown;

beforeEach(() => {
  resetWorldConfiguration();
  document.body.innerHTML = '<main>threads</main>';
  savedChrome = (globalThis as Record<string, unknown>).chrome;
});

afterEach(() => {
  (globalThis as Record<string, unknown>).chrome = savedChrome;
});

describe('I-03 probe: extensionApis reflects what the global namespace actually exposes', () => {
  it('reports all four fields false when there is truly no chrome global', async () => {
    delete (globalThis as Record<string, unknown>).chrome;

    const { report } = await probePageAccess({ tabId: 1, url: URL, api: vmUserScriptsApi(), globals: [] });

    expect(report?.extensionApis).toEqual({ chrome: false, runtime: false, tabs: false, userScripts: false });
  });

  it('reports each field independently based on which sub-objects are present', async () => {
    (globalThis as Record<string, unknown>).chrome = { runtime: {} }; // tabs/userScripts absent

    const { report } = await probePageAccess({ tabId: 1, url: URL, api: vmUserScriptsApi(), globals: [] });

    expect(report?.extensionApis).toEqual({ chrome: true, runtime: true, tabs: false, userScripts: false });
  });

  it('reports true only for the sub-objects actually present, not all-or-nothing', async () => {
    (globalThis as Record<string, unknown>).chrome = { tabs: {}, userScripts: {} }; // no runtime

    const { report } = await probePageAccess({ tabId: 1, url: URL, api: vmUserScriptsApi(), globals: [] });

    expect(report?.extensionApis).toEqual({ chrome: true, runtime: false, tabs: true, userScripts: true });
  });
});

describe('I-03 probe: the sameOriginFetch opt-in gate, executed rather than just read as source', () => {
  it('makes no network request at all when sameOriginFetch is omitted', async () => {
    delete (globalThis as Record<string, unknown>).chrome;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const { report } = await probePageAccess({ tabId: 1, url: URL, api: vmUserScriptsApi(), globals: [] });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(report?.sameOriginFetch).toBeNull();
  });

  it('makes exactly one same-origin GET when sameOriginFetch is true, and reports its outcome', async () => {
    delete (globalThis as Record<string, unknown>).chrome;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

    const { report } = await probePageAccess({
      tabId: 1,
      url: URL,
      api: vmUserScriptsApi(),
      globals: [],
      sameOriginFetch: true,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(URL);
    expect(report?.sameOriginFetch).toEqual({ ok: true, status: 200, error: null });
  });

  it('reports a failed fetch as ok:false with the error message, without throwing', async () => {
    delete (globalThis as Record<string, unknown>).chrome;
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    const { result, report } = await probePageAccess({
      tabId: 1,
      url: URL,
      api: vmUserScriptsApi(),
      globals: [],
      sameOriginFetch: true,
    });

    expect(result.ok).toBe(true); // the probe itself still succeeds; only the fetch failed
    expect(report?.sameOriginFetch).toEqual({ ok: false, status: null, error: 'network down' });
  });
});
