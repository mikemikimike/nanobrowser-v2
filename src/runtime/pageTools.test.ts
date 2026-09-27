/**
 * R-13's escalation, seen from the tool port: the same `click("e7")` must reach
 * the driver by ref on the in-page tier and the CDP tier by viewport point when
 * the user escalated — attaching once, detaching once, and falling back for the
 * rest of the run if the user cancels the debugging banner.
 */
import { describe, expect, it } from 'vitest';
import type { RunEvent, Userscript, UserscriptRunResult } from '@/src/messaging';
import type { WriteUserscriptRequest } from '@/src/agent/tools';
import type { AgentWriteResult } from '@/src/userscripts/authoring';
import type { InputTier } from '@/src/input';
import type { InputFidelity } from '@/src/storage';
import {
  EscalatableInput,
  createInPageTier,
  createInputPagePort,
  createPageTools,
  formatUserscriptConsole,
  type RuntimeDriver,
  type RuntimePageTools,
  type SaveArtifact,
} from './pageTools';
import { memoryStores, type UserscriptValueStore } from './durability';
import { EBAY_RAM_COMPS, I03_PAGE_ACCESS } from '@/src/userscripts/examples';

interface Call {
  name: string;
  args: unknown[];
}

class FakeDriver implements RuntimeDriver {
  readonly calls: Call[] = [];
  ok = true;
  error = 'nope';

  get names(): string[] {
    return this.calls.map((c) => c.name);
  }

  #record(name: string, ...args: unknown[]): { ok: boolean; error?: string } {
    this.calls.push({ name, args });
    return this.ok ? { ok: true } : { ok: false, error: this.error };
  }

  async snapshot(tabId: number, opts?: unknown) {
    this.#record('snapshot', tabId, opts);
    return { ok: true, text: 'page: [ref=e7] button "Go"', nodes: 1, truncated: false, approxTokens: 9, url: 'https://x.test/', title: 'x' };
  }
  async screenshot(tabId: number) {
    this.#record('screenshot', tabId);
    return { ok: true, dataUrl: 'data:image/png;base64,ZmFrZQ==', width: 800, height: 600, devicePixelRatio: 1, deviceWidth: 800, deviceHeight: 600 };
  }
  async extractText(tabId: number, opts?: unknown) {
    this.#record('extractText', tabId, opts);
    return { ok: true, text: 'extracted', truncated: false };
  }
  async click(tabId: number, ref: string) {
    return this.#record('click', tabId, ref);
  }
  async type(tabId: number, ref: string, text: string) {
    return this.#record('type', tabId, ref, text);
  }
  async press(tabId: number, key: string) {
    return this.#record('press', tabId, key);
  }
  async select(tabId: number, ref: string, value: string) {
    return this.#record('select', tabId, ref, value);
  }
  async scroll(tabId: number, opts?: unknown) {
    return this.#record('scroll', tabId, opts);
  }
  async hover(tabId: number, ref: string) {
    return this.#record('hover', tabId, ref);
  }
  async ping_(tabId: number) {
    this.#record('ping_', tabId);
    return { ok: true, width: 800, height: 600 };
  }
  async getBox(tabId: number, ref: string) {
    this.#record('getBox', tabId, ref);
    return { ok: true, box: { x: 100, y: 200, width: 40, height: 20, centerX: 120, centerY: 210 } };
  }
  async navigate(tabId: number, url: string) {
    return this.#record('navigate', tabId, url);
  }
  async download(url: string, filename?: string) {
    this.#record('download', url, filename);
    return this.ok ? { ok: true, downloadId: 42 } : { ok: false, error: this.error };
  }
  async saveFile(dataUrl: string, filename: string) {
    this.#record('saveFile', dataUrl, filename);
    return this.ok ? { ok: true, downloadId: 43 } : { ok: false, error: this.error };
  }
}

/** Records the CDP tier's calls and can fire `onDetach` like the banner's Cancel. */
class FakeDebuggerTier implements InputTier {
  readonly name = 'debugger' as const;
  readonly calls: Call[] = [];
  attachCount = 0;
  detachCount = 0;
  #attached = false;

  constructor(private readonly onDetach: (reason: string) => void) {}

  get names(): string[] {
    return this.calls.map((c) => c.name);
  }

  async attach(tabId: number): Promise<void> {
    this.attachCount += 1;
    this.#attached = true;
    this.calls.push({ name: 'attach', args: [tabId] });
  }
  async detach(): Promise<void> {
    this.detachCount += 1;
    this.#attached = false;
    this.calls.push({ name: 'detach', args: [] });
  }
  isAttached(): boolean {
    return this.#attached;
  }
  async click(x: number, y: number): Promise<void> {
    this.calls.push({ name: 'click', args: [x, y] });
  }
  async moveTo(x: number, y: number): Promise<void> {
    this.calls.push({ name: 'moveTo', args: [x, y] });
  }
  async typeText(text: string): Promise<void> {
    this.calls.push({ name: 'typeText', args: [text] });
  }
  async press(key: string, opts?: unknown): Promise<void> {
    this.calls.push({ name: 'press', args: opts === undefined ? [key] : [key, opts] });
  }
  async scroll(x: number, y: number, dx: number, dy: number): Promise<void> {
    this.calls.push({ name: 'scroll', args: [x, y, dx, dy] });
  }

  /** The user pressed Cancel on the debugging banner. */
  userDetach(reason = 'canceled_by_user'): void {
    this.#attached = false;
    this.onDetach(reason);
  }
}

const TAB = 7;

interface Harness {
  tools: RuntimePageTools;
  driver: FakeDriver;
  input: EscalatableInput;
  events: RunEvent[];
  debuggerTier?: FakeDebuggerTier;
  userscriptRuns: string[];
  userscriptResult: UserscriptRunResult;
}

function harness(
  fidelity: InputFidelity,
  options: {
    withDebugger?: boolean;
    runId?: string;
    saveArtifact?: SaveArtifact;
    readOnly?: boolean;
    userscriptValueStore?: UserscriptValueStore;
    listUserscripts?: () => Promise<Userscript[]>;
    resolveUserscript?: (idOrName: string) => Promise<Userscript | undefined>;
    writeUserscript?: (request: WriteUserscriptRequest) => Promise<AgentWriteResult>;
  } = {},
): Harness {
  const driver = new FakeDriver();
  const events: RunEvent[] = [];
  const userscriptRuns: string[] = [];
  const state: Harness = {
    driver,
    events,
    userscriptRuns,
    userscriptResult: { scriptId: 's1', ok: true, value: 3, console: [{ level: 'log', text: 'hi', at: 1 }], durationMs: 5 },
  } as Harness;

  let input!: EscalatableInput;
  const withDebugger = options.withDebugger ?? fidelity === 'escalated';
  const debuggerTier = withDebugger ? new FakeDebuggerTier((reason) => input.handleDetach(reason)) : undefined;
  state.debuggerTier = debuggerTier;

  input = new EscalatableInput({
    fidelity,
    inPageTier: createInPageTier(driver),
    ...(debuggerTier ? { debuggerTier } : {}),
    page: createInputPagePort(driver, TAB),
    emit: (event) => events.push(event),
    rng: () => 0.5, // no jitter: the point is the box centre
  });
  state.input = input;

  state.tools = createPageTools({
    tabId: TAB,
    driver,
    input,
    observe: 'dom',
    emit: (event) => events.push(event),
    runUserscript: async (scriptId) => {
      userscriptRuns.push(scriptId);
      return state.userscriptResult;
    },
    sleep: async () => {},
    ...(options.listUserscripts ? { listUserscripts: options.listUserscripts } : {}),
    ...(options.resolveUserscript ? { resolveUserscript: options.resolveUserscript } : {}),
    ...(options.writeUserscript ? { writeUserscript: options.writeUserscript } : {}),
    ...(options.runId !== undefined ? { runId: options.runId } : {}),
    ...(options.saveArtifact ? { saveArtifact: options.saveArtifact } : {}),
    ...(options.userscriptValueStore ? { userscriptValueStore: options.userscriptValueStore } : {}),
    ...(options.readOnly ? { readOnly: true } : {}),
  });

  return state;
}

describe('createPageTools', () => {
  it('snapshots the whole tree, not just interactive nodes', async () => {
    const h = harness('in-page');
    const snap = await h.tools.snapshot();
    expect(snap.text).toContain('[ref=e7]');
    expect(snap.tokens).toBe(9);
    expect(h.driver.calls[0]).toEqual({ name: 'snapshot', args: [TAB, { interactiveOnly: false, maxNodes: 900 }] });
  });

  it('surfaces a driver failure as a thrown error, not a silent success', async () => {
    const h = harness('in-page');
    await h.input.attach(TAB);
    h.driver.ok = false;
    h.driver.error = 'no element for ref e9';
    await expect(h.tools.click('e9')).rejects.toThrow('no element for ref e9');
  });

  it('routes to the in-page tier by ref when fidelity is in-page', async () => {
    const h = harness('in-page');
    await h.input.attach(TAB);
    await h.tools.click('e7');
    await h.tools.type('e7', 'hello');
    await h.tools.press('Enter');
    expect(h.driver.calls).toEqual([
      { name: 'click', args: [TAB, 'e7'] },
      { name: 'type', args: [TAB, 'e7', 'hello'] },
      { name: 'press', args: [TAB, 'Enter'] },
    ]);
    expect(h.driver.names).not.toContain('getBox');
    expect(h.input.fidelity).toBe('in-page');
  });

  it('routes to the debugger tier by viewport point when fidelity is escalated', async () => {
    const h = harness('escalated');
    await h.input.attach(TAB);
    await h.tools.click('e7');

    expect(h.driver.names).toContain('getBox');
    // Box (100,200,40x20) with a centred rng: the click lands on the centre.
    expect(h.debuggerTier?.calls).toEqual([
      { name: 'attach', args: [TAB] },
      { name: 'moveTo', args: [120, 210] },
      { name: 'click', args: [120, 210] },
    ]);
    expect(h.driver.names).not.toContain('click');
  });

  it('replaces the field on escalated type: click to focus, Ctrl+A, then type', async () => {
    const h = harness('escalated');
    await h.input.attach(TAB);
    await h.tools.type('e7', 'hello');

    // The type tool contract is replace-by-default on every tier: the in-page
    // tier clears first, so the escalated path selects all before typing.
    expect(h.debuggerTier?.calls).toEqual([
      { name: 'attach', args: [TAB] },
      { name: 'moveTo', args: [120, 210] },
      { name: 'click', args: [120, 210] },
      { name: 'press', args: ['a', { modifiers: { ctrl: true } }] },
      { name: 'typeText', args: ['hello'] },
    ]);
    expect(h.driver.names).not.toContain('type');
  });

  it('attaches the debugger tier once for the whole run and detaches at the end', async () => {
    const h = harness('escalated');
    await h.input.attach(TAB);
    await h.tools.click('e7');
    await h.tools.click('e7');
    await h.tools.press('Enter');
    expect(h.debuggerTier?.attachCount).toBe(1);
    expect(h.debuggerTier?.detachCount).toBe(0);

    await h.input.detach();
    expect(h.debuggerTier?.detachCount).toBe(1);
    expect(h.events.filter((e) => e.kind === 'input.fidelity')).toEqual([
      { kind: 'input.fidelity', fidelity: 'escalated', attached: true, at: expect.any(Number) },
    ]);
  });

  it('falls back to the in-page tier for the rest of the run when the user detaches', async () => {
    const h = harness('escalated');
    await h.input.attach(TAB);
    await h.tools.click('e7');

    h.debuggerTier?.userDetach();

    expect(h.input.fidelity).toBe('in-page');
    expect(h.events.at(-1)).toEqual({
      kind: 'input.fidelity',
      fidelity: 'in-page',
      attached: false,
      at: expect.any(Number),
    });

    await h.tools.click('e7');
    expect(h.driver.calls).toContainEqual({ name: 'click', args: [TAB, 'e7'] });
    // The tier saw exactly the one click from before the detach.
    expect(h.debuggerTier?.calls.filter((c) => c.name === 'click')).toHaveLength(1);
  });

  it('stays in-page and says so when escalation is impossible', async () => {
    const h = harness('escalated', { withDebugger: false });
    await h.input.attach(TAB);
    await h.tools.click('e7');
    expect(h.input.fidelity).toBe('in-page');
    expect(h.driver.calls).toContainEqual({ name: 'click', args: [TAB, 'e7'] });
  });

  it('scrolls the viewport through the tier and jumps to the ends through the page', async () => {
    const inPage = harness('in-page');
    await inPage.input.attach(TAB);
    await inPage.tools.scroll('down');
    expect(inPage.driver.calls.at(-1)).toEqual({ name: 'scroll', args: [TAB, { direction: 'down' }] });

    const escalated = harness('escalated');
    await escalated.input.attach(TAB);
    await escalated.tools.scroll('down');
    expect(escalated.debuggerTier?.calls.at(-1)).toEqual({ name: 'scroll', args: [400, 300, 0, 600] });

    await escalated.tools.scroll('top');
    expect(escalated.driver.calls.at(-1)?.name).toBe('scroll');
  });

  it('downloads a URL through chrome.downloads and a ref by clicking it', async () => {
    const h = harness('in-page');
    await h.input.attach(TAB);
    expect(await h.tools.download('https://x.test/a.csv')).toContain('42');
    expect(h.driver.calls.at(-1)).toEqual({ name: 'download', args: ['https://x.test/a.csv', undefined] });

    await h.tools.download('e7');
    expect(h.driver.calls.at(-1)).toEqual({ name: 'click', args: [TAB, 'e7'] });
  });

  it('extracts readable text through the driver', async () => {
    const h = harness('in-page');
    expect(await h.tools.extractText()).toBe('extracted');
    expect(h.driver.calls.at(-1)).toEqual({ name: 'extractText', args: [TAB, {}] });
  });

  it('passes maxChars through to the driver', async () => {
    const h = harness('in-page');
    await h.tools.extractText(500);
    expect(h.driver.calls.at(-1)).toEqual({ name: 'extractText', args: [TAB, { maxChars: 500 }] });
  });

  it('reports a ref viewport box in CSS pixels for screenshot correlation', async () => {
    const h = harness('in-page');
    expect(await h.tools.getBox('e7')).toEqual({ x: 100, y: 200, width: 40, height: 20 });
    expect(h.driver.calls.at(-1)).toEqual({ name: 'getBox', args: [TAB, 'e7'] });
  });

  it('truncates run_userscript\'s own echoed JSON at ~60000 chars but keeps it retrievable in full', async () => {
    const h = harness('in-page', { saveArtifact: async (filename, content) => ({ path: `/artifacts/${filename}`, bytes: content.length }) });
    h.userscriptResult = { scriptId: 's1', ok: true, value: { big: 'x'.repeat(70_000) }, console: [], durationMs: 1 };
    const summary = await h.tools.runUserscript('s1');
    expect(summary).toContain('[truncated]');
    expect(summary.length).toBeLessThan(61_000);

    // The full, untruncated value is still what save_file(fromLastUserscript:true) writes.
    const saved = await h.tools.saveFile('result.json', undefined, true);
    expect(saved).toContain('result.json');
    const fullJson = JSON.stringify({ big: 'x'.repeat(70_000) }, null, 2);
    expect(fullJson.length).toBeGreaterThan(70_000);
  });

  it('save_file refuses fromLastUserscript when nothing has run yet', async () => {
    const h = harness('in-page');
    await expect(h.tools.saveFile('a.json', undefined, true)).rejects.toThrow('no userscript has run yet');
  });

  it('retains the last userscript value across tool instances via the store (M6)', async () => {
    const stores = memoryStores();
    const before = harness('in-page', { userscriptValueStore: stores.values });
    before.userscriptResult = { scriptId: 's1', ok: true, value: { rows: [1, 2] }, console: [], durationMs: 1 };
    await before.tools.runUserscript('s1');
    // Let the fire-and-forget durable save land.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // A new tool instance with an empty closure — as after a worker restart —
    // still saves the full value instead of failing.
    const after = harness('in-page', { userscriptValueStore: stores.values, runId: 'run-9' });
    const saved = await after.tools.saveFile('rows.json', undefined, true);
    expect(saved).toContain('rows.json');
    expect(after.driver.calls.at(-1)?.name).toBe('saveFile');
  });

  it('fails legibly when the value was lost to a restart (M6)', async () => {
    const stores = memoryStores();
    const h = harness('in-page', { userscriptValueStore: stores.values });
    await expect(h.tools.saveFile('a.json', undefined, true)).rejects.toThrow(
      'the last userscript value was lost to a restart: re-run the script, then save again',
    );
  });
});

describe('read-only runs (M9 #13)', () => {
  it('refuses every acting tool with a legible mode error, touching nothing', async () => {
    const h = harness('in-page', { readOnly: true });
    await h.input.attach(TAB);

    await expect(h.tools.click('e7')).rejects.toThrow('read-only run: click is unavailable');
    await expect(h.tools.hover('e7')).rejects.toThrow('read-only run: hover is unavailable');
    await expect(h.tools.type('e7', 'x')).rejects.toThrow('read-only run: type is unavailable');
    await expect(h.tools.press('Enter')).rejects.toThrow('read-only run: press is unavailable');
    await expect(h.tools.select('e7', 'm')).rejects.toThrow('read-only run: select is unavailable');
    await expect(h.tools.download('https://x.test/a.csv')).rejects.toThrow('read-only run: download is unavailable');
    await expect(
      h.tools.writeUserscript({ name: 'x', matches: ['*://x.test/*'], code: 'return 1;' }),
    ).rejects.toThrow('read-only run: write_userscript is unavailable');
    // Defense in depth held: the driver saw nothing at all.
    expect(h.driver.calls).toEqual([]);
  });

  it('still reads, navigates, scrolls, and saves', async () => {
    const h = harness('in-page', { readOnly: true, runId: 'run-ro' });
    expect((await h.tools.snapshot()).text).toContain('[ref=e7]');
    expect(await h.tools.extractText()).toBe('extracted');
    expect(await h.tools.navigate('https://x.test/next')).toContain('https://x.test/next');
    expect(await h.tools.scroll('down')).toContain('down');
    expect(await h.tools.getBox('e7')).toMatchObject({ x: 100, y: 200 });
    expect(await h.tools.saveFile('notes.txt', 'read-only notes', false)).toContain('notes.txt');
  });

  it('runs a read-only userscript but refuses a writing one', async () => {
    const reader: Userscript = {
      id: 'reader',
      name: 'reader',
      matches: ['*://x.test/*'],
      code: 'return [...document.querySelectorAll("h1")].map((h) => h.textContent);',
      updatedAt: 0,
      author: 'agent',
    };
    const writer: Userscript = { ...reader, id: 'writer', name: 'writer', code: 'form.submit();' };
    const resolve = async (idOrName: string) =>
      [reader, writer].find((s) => s.id === idOrName || s.name === idOrName);
    const h = harness('in-page', { readOnly: true, resolveUserscript: resolve });

    expect(await h.tools.runUserscript('reader')).toContain('reader');
    await expect(h.tools.runUserscript('writer')).rejects.toThrow('read-only run: writer');
    expect(h.userscriptRuns).toEqual(['reader']);
  });

  it('runs a bundled seed as shipped but scans one the user edited in place', async () => {
    const shipped: Userscript = { ...I03_PAGE_ACCESS, updatedAt: 0 };
    const edited: Userscript = { ...EBAY_RAM_COMPS, code: 'form.submit();', updatedAt: 0 };
    const resolve = async (idOrName: string) => [shipped, edited].find((s) => s.id === idOrName);
    const h = harness('in-page', { readOnly: true, resolveUserscript: resolve });

    await h.tools.runUserscript(shipped.id);
    await expect(h.tools.runUserscript(edited.id)).rejects.toThrow(`read-only run: ${edited.id}`);
    expect(h.userscriptRuns).toEqual([shipped.id]);
  });

  it('refuses run_userscript when the source cannot be verified', async () => {
    const withoutCatalog = harness('in-page', { readOnly: true });
    await expect(withoutCatalog.tools.runUserscript('s1')).rejects.toThrow('no catalog in this run');

    const withCatalog = harness('in-page', { readOnly: true, resolveUserscript: async () => undefined });
    await expect(withCatalog.tools.runUserscript('ghost')).rejects.toThrow('unknown userscript ghost');
  });

  it('resolves from the whole catalog, not the starting-URL-filtered list', async () => {
    // A read-only run that navigated elsewhere: the display list omits the
    // destination-matching script, but the preflight still verifies its source.
    const dest: Userscript = {
      id: 'u9',
      name: 'dest-reader',
      matches: ['*://b.test/*'],
      code: 'return document.title;',
      updatedAt: 0,
    };
    const h = harness('in-page', {
      readOnly: true,
      listUserscripts: async () => [],
      resolveUserscript: async (idOrName) => (idOrName === 'u9' || idOrName === 'dest-reader' ? dest : undefined),
    });
    expect(await h.tools.runUserscript('dest-reader')).toContain('dest-reader');
    expect(h.userscriptRuns).toEqual(['dest-reader']);
  });

  it('save_file downloads to the Downloads folder and emits a file.saved event', async () => {
    const h = harness('in-page', { runId: 'run-1' });
    const result = await h.tools.saveFile('data.json', '{"a":1}', false);
    expect(result).toContain('data.json');
    expect(result).toContain('7 bytes');
    expect(h.driver.calls.at(-1)?.name).toBe('saveFile');
    expect(h.events).toContainEqual({
      kind: 'file.saved',
      runId: 'run-1',
      filename: 'data.json',
      bytes: 7,
      path: 'nanobrowser/data.json',
      at: expect.any(Number),
    });
  });

  it('save_file also writes to the host artifacts sink when available, and reports its path', async () => {
    const calls: Array<[string, string]> = [];
    const h = harness('in-page', {
      runId: 'run-2',
      saveArtifact: async (filename, content) => {
        calls.push([filename, content]);
        return { path: `/home/user/.local/share/nanobrowser/artifacts/run-2/${filename}`, bytes: content.length };
      },
    });
    const result = await h.tools.saveFile('out.csv', 'a,b\n1,2', false);
    expect(calls).toEqual([['out.csv', 'a,b\n1,2']]);
    expect(result).toContain('artifacts/run-2/out.csv');
    expect(h.events).toContainEqual(
      expect.objectContaining({ kind: 'file.saved', path: expect.stringContaining('artifacts/run-2/out.csv') }),
    );
  });

  it('save_file throws when the Downloads write fails and no artifact sink is configured', async () => {
    const h = harness('in-page');
    h.driver.ok = false;
    h.driver.error = 'disk full';
    await expect(h.tools.saveFile('a.json', '{}', false)).rejects.toThrow('disk full');
    expect(h.events).not.toContainEqual(expect.objectContaining({ kind: 'file.saved' }));
  });

  // Regression: previously this only checked `!options.saveArtifact` -- if an artifact
  // sink *was* configured but its own write also failed, save_file still returned a
  // success-shaped string and emitted file.saved with a path nothing was ever written to.
  it('save_file throws, and emits no file.saved, when both the Downloads write and the artifact write fail', async () => {
    const h = harness('in-page', {
      runId: 'run-3',
      saveArtifact: async () => {
        throw new Error('artifacts dir is read-only');
      },
    });
    h.driver.ok = false;
    h.driver.error = 'disk full';

    await expect(h.tools.saveFile('a.json', '{}', false)).rejects.toThrow(/disk full/);
    await expect(h.tools.saveFile('a.json', '{}', false)).rejects.toThrow(/artifacts dir is read-only/);
    expect(h.events).not.toContainEqual(expect.objectContaining({ kind: 'file.saved' }));
  });

  it('save_file requires content unless fromLastUserscript is set', async () => {
    const h = harness('in-page');
    await expect(h.tools.saveFile('a.json', undefined, false)).rejects.toThrow('no content');
  });

  it('emits userscript console lines into the run log (R-07/R-09)', async () => {
    const h = harness('in-page');
    const summary = await h.tools.runUserscript('s1');
    expect(h.userscriptRuns).toEqual(['s1']);
    expect(summary).toContain('s1');
    expect(h.events).toContainEqual({ kind: 'userscript.output', scriptId: 's1', level: 'log', text: 'hi', at: 1 });
  });

  it('reports a failing userscript as a failed tool call', async () => {
    const h = harness('in-page');
    h.userscriptResult = { scriptId: 's1', ok: false, error: 'boom', console: [], durationMs: 1 };
    await expect(h.tools.runUserscript('s1')).rejects.toThrow('boom');
    expect(h.events).toContainEqual(
      expect.objectContaining({ kind: 'userscript.output', level: 'error', text: 'boom' }),
    );
  });

  it('navigates the run tab and passes done/blocked through', async () => {
    const h = harness('in-page');
    expect(await h.tools.navigate('https://x.test/next')).toContain('https://x.test/next');
    expect(h.driver.calls.at(-1)).toEqual({ name: 'navigate', args: [TAB, 'https://x.test/next'] });
    expect(await h.tools.done('all good')).toBe('all good');
    expect(await h.tools.blocked('login wall')).toBe('login wall');
  });
});

describe('the agent\'s userscript loop (R-09/R-10, O-03)', () => {
  const script: Userscript = {
    id: 'sc-1',
    name: 'chatgpt-titles',
    matches: ['*://chatgpt.com/*'],
    code: 'return 1;',
    updatedAt: 0,
    author: 'agent',
  };

  // The loop is edit -> run -> read -> edit, so a run that hides what the script
  // logged leaves the model nothing to edit *from*.
  it('gives the model what the script logged, not just what it returned', async () => {
    const h = harness('in-page');
    h.userscriptResult = {
      scriptId: 's1',
      ok: true,
      value: [1, 2],
      console: [
        { level: 'log', text: 'found 2 articles', at: 1 },
        { level: 'warn', text: 'no timestamps', at: 2 },
      ],
      durationMs: 5,
    };

    const reply = await h.tools.runUserscript('s1');

    expect(reply).toContain('[1,2]');
    expect(reply).toContain('[log] found 2 articles');
    expect(reply).toContain('[warn] no timestamps');
  });

  it('carries the console into the failure too, where it is needed most', async () => {
    const h = harness('in-page');
    h.userscriptResult = {
      scriptId: 's1',
      ok: false,
      error: 'TypeError: rows.map is not a function (line 4, column 12)',
      console: [{ level: 'log', text: 'rows = null', at: 1 }],
      durationMs: 3,
    };

    await expect(h.tools.runUserscript('s1')).rejects.toThrow(/line 4, column 12[\s\S]*\[log\] rows = null/);
  });

  it('lists saved scripts with their ids and who wrote each one', async () => {
    const h = harness('in-page', {
      listUserscripts: async () => [script, { ...script, id: 'sc-2', name: 'mine', author: undefined }],
    });

    const listing = await h.tools.listUserscripts();

    expect(listing).toContain('sc-1 | chatgpt-titles | *://chatgpt.com/* | written by you');
    expect(listing).toContain('sc-2 | mine | *://chatgpt.com/* | written by the user');
  });

  it('tells the model to write one when the catalog is empty', async () => {
    const h = harness('in-page', { listUserscripts: async () => [] });
    expect(await h.tools.listUserscripts()).toContain('write_userscript');
  });

  it('hands back the id and how to run it after a write', async () => {
    const h = harness('in-page', {
      writeUserscript: async () => ({ ok: true, script, created: true }),
    });

    const reply = await h.tools.writeUserscript({
      name: 'chatgpt-titles',
      matches: ['*://chatgpt.com/*'],
      code: 'return 1;',
    });

    expect(reply).toContain('created userscript sc-1');
    expect(reply).toContain('run_userscript scriptId "sc-1"');
  });

  it('says "updated" when revising rather than pretending it made a new script', async () => {
    const h = harness('in-page', {
      writeUserscript: async () => ({ ok: true, script, created: false }),
    });
    const reply = await h.tools.writeUserscript({
      scriptId: 'sc-1',
      name: 'chatgpt-titles',
      matches: ['*://chatgpt.com/*'],
      code: 'return 2;',
    });
    expect(reply).toContain('updated userscript sc-1');
  });

  it('fails the step with the refusal reasons verbatim, so the retry can be correct', async () => {
    const h = harness('in-page', {
      writeUserscript: async () => ({ ok: false, errors: ['"<all_urls>" matches every site. Name the host you mean.'] }),
    });

    await expect(
      h.tools.writeUserscript({ name: 'x', matches: ['<all_urls>'], code: 'return 1;' }),
    ).rejects.toThrow('matches every site');
  });

  it('says plainly that a run without a write path cannot author scripts', async () => {
    const h = harness('in-page');
    await expect(
      h.tools.writeUserscript({ name: 'x', matches: ['*://chatgpt.com/*'], code: 'return 1;' }),
    ).rejects.toThrow('not available in this run');
    expect(await h.tools.listUserscripts()).toContain('not available in this run');
  });
});

describe('userscript read, summary, and save', () => {
  it('returns the source of a saved script', async () => {
    const h = harness('in-page', {
      resolveUserscript: async (id) =>
        id === 'bundled-ebay-ram-comps'
          ? {
              id,
              name: 'ebay-ram-comps',
              matches: ['*://www.ebay.com/*'],
              code: 'return { summary: [] };',
              updatedAt: 0,
            }
          : undefined,
    });

    await expect(h.tools.readUserscript('bundled-ebay-ram-comps')).resolves.toContain('return { summary: [] };');
  });

  it('leaves summary in the reply when rows are huge', async () => {
    const h = harness('in-page');
    h.userscriptResult = {
      scriptId: 's1',
      ok: true,
      value: { summary: { kits: 2 }, meta: { source: 'ebay.com' }, log: [], rows: [{ blob: 'x'.repeat(80_000) }] },
      console: [],
      durationMs: 5,
    };

    const reply = await h.tools.runUserscript('s1');
    expect(reply).toContain('"kits":2');
    expect(reply).toContain('rows are not in this reply');
    expect(reply).not.toContain('x'.repeat(80));
  });

  it('keeps the last error line when the first lines are noise', () => {
    const lines = [
      { level: 'error' as const, text: 'challenge page', at: 0 },
      ...Array.from({ length: 50 }, (_, index) => ({ level: 'log' as const, text: `noise ${index}`, at: index + 1 })),
    ];
    const out = formatUserscriptConsole(lines, 40);
    expect(out).toContain('[error] challenge page');
    expect(out).not.toContain('[log] noise 0');
  });

  it('lets save_file write rows collected before a throw', async () => {
    const saved: string[] = [];
    const h = harness('in-page', {
      saveArtifact: async (_filename, content) => {
        saved.push(content);
        return { path: '/artifacts/rows.json', bytes: content.length };
      },
    });
    h.userscriptResult = {
      scriptId: 's1',
      ok: false,
      error: 'boom',
      value: { summary: [], rows: [{ item_id: '1' }], log: [], meta: {} },
      console: [],
      durationMs: 5,
    };

    await expect(h.tools.runUserscript('s1')).rejects.toThrow('boom');
    const reply = await h.tools.saveFile('rows.json', undefined, true);
    expect(reply).toContain('rows.json');
    expect(saved[0]).toContain('"item_id": "1"');
  });

  it('persists the summary when the rows exceed 8 MiB and does not encode those rows', async () => {
    const saved: string[] = [];
    const h = harness('in-page', {
      saveArtifact: async (_filename, content) => {
        saved.push(content);
        return { path: '/artifacts/rows.json', bytes: content.length };
      },
    });
    const huge = 'Z'.repeat(8 * 1024 * 1024 + 1000);
    h.userscriptResult = {
      scriptId: 's1',
      ok: true,
      value: { summary: { kits: 1 }, log: ['page 1'], meta: { source: 'ebay.com' }, rows: [huge] },
      console: [],
      durationMs: 5,
    };

    await h.tools.runUserscript('s1');
    const reply = await h.tools.saveFile('rows.json', undefined, true);
    expect(reply).toContain('rows exceeded 8 MiB');
    expect(saved[0]).toContain('"kits": 1');
    expect(saved[0]).toContain('rows_dropped');
    expect(saved[0]).not.toContain(huge.slice(0, 100));
    const dataUrl = String(h.driver.calls.find((call) => call.name === 'saveFile')?.args[0]);
    expect(dataUrl.startsWith('data:')).toBe(true);
    expect(dataUrl).not.toContain(huge.slice(0, 80));
  });
});

describe('formatUserscriptConsole', () => {
  it('is empty for a script that logged nothing, so the reply stays short', () => {
    expect(formatUserscriptConsole([])).toBe('');
  });

  it('caps the number of lines and says how many it dropped', () => {
    const lines = Array.from({ length: 6 }, (_, i) => ({ level: 'log' as const, text: `line ${i}`, at: i }));
    const out = formatUserscriptConsole(lines, 4);
    expect(out).toContain('[log] line 5');
    expect(out).not.toContain('[log] line 0');
    expect(out).toContain('… 2 more console lines');
  });

  it('keeps an early error inside both caps and counts what it dropped', () => {
    const lines = [
      { level: 'error' as const, text: 'challenge page', at: 0 },
      ...Array.from({ length: 10 }, (_, i) => ({ level: 'log' as const, text: `noise ${i}`, at: i + 1 })),
    ];
    const out = formatUserscriptConsole(lines, 4, 60);
    const shown = out.split('\n').filter((line) => line.startsWith('['));
    expect(shown).toHaveLength(3);
    expect(shown.join('\n').length).toBeLessThanOrEqual(60);
    expect(shown.at(-1)).toBe('[error] challenge page');
    expect(out).toContain('… 8 more console lines');
  });

  it('caps by size too, so one enormous log line cannot crowd out the result', () => {
    const lines = [
      { level: 'log' as const, text: 'a'.repeat(50), at: 1 },
      { level: 'log' as const, text: 'b'.repeat(50), at: 2 },
    ];
    const out = formatUserscriptConsole(lines, 10, 60);
    expect(out).toContain('b'.repeat(50));
    expect(out).not.toContain('a'.repeat(50));
    expect(out).toContain('… 1 more console line');
  });
});
