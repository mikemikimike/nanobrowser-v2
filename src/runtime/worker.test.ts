/**
 * Every message in `src/messaging/contract.ts`, driven over `FakeBrowserPort`
 * exactly as the side panel drives it, plus the host-pushed dev trigger.
 *
 * The run manager here is the real one with a scripted `startRun` seam, so
 * "fanned out to two panels and to the host run log" is asserted end to end
 * rather than against a stub.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createChannel,
  createFakePortPair,
  HUB_MESSAGE,
  type Envelope,
  type ModelInfo,
  type PanelToWorker,
  type Readiness,
  type RunEvent,
} from '@/src/messaging';
import type { Config } from '@/src/storage';
import { FakeChatModel } from '@/src/agent/models';
import type { RunEndedEvent, RunHandle, StartRunOptions } from '@/src/agent/run';
import type { ExtLogEntry } from './errorLog';
import { RunManager } from './runManager';
import type { RuntimeDriver } from './pageTools';
import { memoryStores, type ReplayStore } from './durability';
import {
  applyRunOptions,
  createWorker,
  HOST_UNREACHABLE_REASON,
  type DevRunStart,
  type HostPort,
  type Worker,
} from './worker';

const config: Config = {
  leaderModel: 'fake/leader',
  followerModel: 'fake/follower',
  observe: 'dom',
  planningInterval: 5,
  maxSteps: 10,
  inputFidelity: 'in-page',
};

const ok = { ok: true as const };

function fakeDriver(navigated: string[] = []): RuntimeDriver {
  return {
    snapshot: async () => ({ ok: true, text: '', nodes: 0, truncated: false, approxTokens: 0, url: '', title: '' }),
    screenshot: async () => ({ ok: true, dataUrl: 'data:image/png;base64,x', width: 1, height: 1 }),
    extractText: async () => ({ ok: true, text: '', truncated: false }),
    click: async () => ok,
    type: async () => ok,
    press: async () => ok,
    select: async () => ok,
    scroll: async () => ok,
    hover: async () => ok,
    ping_: async () => ({ ok: true, width: 800, height: 600 }),
    getBox: async () => ({ ok: true, box: { x: 0, y: 0, width: 10, height: 10, centerX: 5, centerY: 5 } }),
    navigate: async (_tabId, url) => {
      navigated.push(url);
      return ok;
    },
    download: async () => ({ ok: true, downloadId: 1 }),
    saveFile: async () => ({ ok: true, downloadId: 2 }),
  };
}

const endedOk: RunEndedEvent = { kind: 'run.ended', status: 'done', message: 'objective complete', steps: 1, at: 9 };

/** `startRun` seam: emits one `step`, then ends when `finish()` is called. */
function scriptedStart() {
  const seen: StartRunOptions[] = [];
  let release: (() => void) | undefined;
  const start = (options: StartRunOptions): RunHandle => {
    seen.push(options);
    const runId = options.runId ?? 'generated';
    options.onEvent({
      kind: 'run.started',
      runId,
      prompt: options.prompt,
      config: options.config,
      tabId: options.tabId ?? -1,
      url: options.url ?? '',
      at: 1,
    });
    options.onEvent({ kind: 'step', n: 1, role: 'follower', at: 2 });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      runId,
      pause: vi.fn(),
      resume: vi.fn(),
      abort: vi.fn(),
      done: gate.then(() => {
        options.onEvent(endedOk);
        return endedOk;
      }),
    };
  };
  return { start, seen, finish: () => release?.() };
}

class FakeHost implements HostPort {
  readonly log: Array<{ runId: string; event: unknown }> = [];
  readonly listCalls: number[] = [];
  models: ModelInfo[] = [
    { id: 'a/one:free', name: 'One', free: true, vision: false, tools: true, contextLength: 8000 },
  ];
  modelsError: Error | undefined;
  readiness: Readiness = { hostConnected: true, keyReady: true };
  devTrigger: ((msg: DevRunStart) => void) | undefined;
  abortTrigger: ((msg: { runId: string }) => void) | undefined;
  reloadTrigger: (() => void) | undefined;
  readonly logs: ExtLogEntry[] = [];
  readonly artifacts: Array<{ runId: string; filename: string; content: string }> = [];

  async saveArtifact(runId: string, filename: string, content: string): Promise<{ path: string; bytes: number }> {
    this.artifacts.push({ runId, filename, content });
    return { path: `/artifacts/${runId}/${filename}`, bytes: content.length };
  }

  async keyStatus(): Promise<Readiness> {
    return this.readiness;
  }
  async listModels(): Promise<ModelInfo[]> {
    this.listCalls.push(Date.now());
    if (this.modelsError) throw this.modelsError;
    return this.models;
  }
  appendRunLog(runId: string, event: unknown): void {
    this.log.push({ runId, event });
  }
  onRunStart(handler: (msg: DevRunStart) => void): () => void {
    this.devTrigger = handler;
    return () => {
      this.devTrigger = undefined;
    };
  }
  onRunAbort(handler: (msg: { runId: string }) => void): () => void {
    this.abortTrigger = handler;
    return () => {
      this.abortTrigger = undefined;
    };
  }
  appendLog(entry: ExtLogEntry): void {
    this.logs.push(entry);
  }
  onExtReload(handler: () => void): () => void {
    this.reloadTrigger = handler;
    return () => {
      this.reloadTrigger = undefined;
    };
  }
}

interface Panel {
  sent: Envelope<unknown>[];
  send<K extends keyof PanelToWorker>(type: K, payload: PanelToWorker[K]): void;
  ping(): void;
  received(type: string): unknown[];
}

interface Harness {
  worker: Worker;
  host: FakeHost;
  runManager: RunManager;
  scripted: ReturnType<typeof scriptedStart>;
  navigated: string[];
  connect(): Panel;
  now: { value: number };
}

function harness(
  options: {
    handleUserscript?: Parameters<typeof createWorker>[0]['handleUserscript'];
    tabUrl?: string;
    reloadExtension?: () => void;
    getLastRunId?: () => Promise<string | null>;
    replayStore?: ReplayStore;
  } = {},
): Harness {
  const host = new FakeHost();
  const scripted = scriptedStart();
  const navigated: string[] = [];
  const now = { value: 1_000 };
  const url = options.tabUrl ?? 'https://example.test/';

  const runManager = new RunManager({
    driver: fakeDriver(navigated),
    tabs: { activeTab: async () => ({ id: 3, url }), get: async () => ({ id: 3, url }) },
    host,
    createModel: (model) => new FakeChatModel({ label: model }),
    runUserscript: async (scriptId) => ({ scriptId, ok: true, console: [], durationMs: 0 }),
    start: scripted.start,
    newRunId: () => 'run-1',
    ...(options.replayStore ? { replayStore: options.replayStore } : {}),
  });

  const worker = createWorker({
    host,
    runManager,
    getConfig: async () => config,
    extensionVersion: '9.9.9',
    now: () => now.value,
    ...(options.handleUserscript ? { handleUserscript: options.handleUserscript } : {}),
    ...(options.reloadExtension ? { reloadExtension: options.reloadExtension } : {}),
    ...(options.getLastRunId ? { getLastRunId: options.getLastRunId } : {}),
  });

  return {
    worker,
    host,
    runManager,
    scripted,
    navigated,
    now,
    connect(): Panel {
      const [workerSide, panelSide] = createFakePortPair();
      // The panel end listens first, as it does in the browser: the side panel
      // calls `chrome.runtime.connect` and attaches its handler before the
      // worker's `onConnect` fires.
      const channel = createChannel<unknown, unknown>(panelSide);
      const sent: Envelope<unknown>[] = [];
      channel.onMessage((envelope) => sent.push(envelope));
      worker.connect(workerSide);
      return {
        sent,
        send(type, payload) {
          channel.send(type, payload);
        },
        ping() {
          channel.send(HUB_MESSAGE, { kind: 'ping', at: 1 });
        },
        received(type) {
          return sent.filter((e) => e.type === type).map((e) => e.payload);
        },
      };
    },
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('createWorker: hub', () => {
  it('greets a panel on connect and answers its heartbeat', async () => {
    const h = harness();
    const panel = h.connect();
    expect(panel.received(HUB_MESSAGE)).toEqual([{ kind: 'hello', extensionVersion: '9.9.9' }]);

    panel.ping();
    await settle();
    expect(panel.received(HUB_MESSAGE).at(-1)).toEqual({ kind: 'pong', at: 1_000 });
    expect(h.worker.panelCount).toBe(1);
  });
});

describe('createWorker: models.list', () => {
  it('answers from the host and then from the cache for ten minutes', async () => {
    const h = harness();
    const panel = h.connect();

    panel.send('models.list', {});
    await settle();
    expect(panel.received('models.list')).toEqual([{ models: h.host.models }]);

    panel.send('models.list', {});
    await settle();
    expect(h.host.listCalls).toHaveLength(1);

    h.now.value += 10 * 60 * 1000 + 1;
    panel.send('models.list', {});
    await settle();
    expect(h.host.listCalls).toHaveLength(2);
  });

  it('replies with an error, not a throw, when the host cannot list models', async () => {
    const h = harness();
    h.host.modelsError = new Error('host disconnected');
    const panel = h.connect();
    panel.send('models.list', {});
    await settle();
    expect(panel.received('models.list')).toEqual([{ error: 'host disconnected' }]);
  });
});

describe('createWorker: readiness.get', () => {
  it('passes a validated readiness through unchanged (R-11)', async () => {
    const h = harness();
    h.host.readiness = { hostConnected: true, keyReady: false, reason: 'no key in the store' };
    const panel = h.connect();
    panel.send('readiness.get', {});
    await settle();
    expect(panel.received('readiness')).toEqual([{ hostConnected: true, keyReady: false, reason: 'no key in the store' }]);
  });

  it('maps a host-connection failure to an actionable reason', async () => {
    const h = harness();
    h.host.readiness = { hostConnected: false, keyReady: false, reason: 'host disconnected' };
    const panel = h.connect();
    panel.send('readiness.get', {});
    await settle();
    const readiness = panel.received('readiness')[0] as Readiness;
    expect(readiness.hostConnected).toBe(false);
    expect(readiness.reason).toContain(HOST_UNREACHABLE_REASON);
    expect(readiness.reason).toContain('host/install.sh');
    expect(readiness.reason).toContain('host disconnected');
  });
});

describe('createWorker: runs', () => {
  it('fans every run event out to every panel and to the host run log (R-07)', async () => {
    const h = harness();
    const one = h.connect();
    const two = h.connect();

    one.send('run.start', { prompt: 'find the price', config });
    await settle();
    h.scripted.finish();
    await settle();

    const kinds = (panel: Panel): string[] =>
      panel.received('run.event').map((p) => (p as { event: RunEvent }).event.kind);
    expect(kinds(one)).toEqual(['run.started', 'input.fidelity', 'step', 'run.ended']);
    expect(kinds(two)).toEqual(kinds(one));
    expect(h.host.log.map((entry) => (entry.event as RunEvent).kind)).toEqual(kinds(one));
    expect(h.host.log.every((entry) => entry.runId === 'run-1')).toBe(true);
  });

  it('refuses pixels for a known text-only follower named by the panel, instead of running blind', async () => {
    const h = harness();
    const panel = h.connect();
    panel.send('run.start', {
      prompt: 'go',
      config: { ...config, observe: 'pixels' },
      followerVision: false,
    });
    await settle();

    const ended = panel
      .received('run.event')
      .map((p) => (p as { event: RunEvent }).event)
      .find((e) => e.kind === 'run.ended');
    expect(ended).toMatchObject({ kind: 'run.ended', status: 'error', steps: 0 });
    expect((ended as { message: string }).message).toContain('cannot see images');
  });

  it('restores the last run at startup so an unattended run terminates without a panel', async () => {
    const stores = memoryStores();
    await stores.replay.save('run-9', [
      { kind: 'run.started', runId: 'run-9', prompt: 'go', config, tabId: 3, url: 'https://example.test/', at: 1 },
      { kind: 'step', n: 1, role: 'follower', at: 2 },
    ]);
    const h = harness({ getLastRunId: async () => 'run-9', replayStore: stores.replay });
    await settle();
    await settle();

    // The interrupted run got its clean terminal event plus the run.end frame
    // nb-run exits on — no panel ever connected.
    const kinds = h.host.log.map((entry) => {
      const event = entry.event as { kind?: string; type?: string };
      return event.kind ?? event.type;
    });
    expect(kinds).toEqual(['run.ended', 'run.end']);
    expect(h.host.log[0]?.event).toMatchObject({ status: 'error' });
    expect(h.host.log[1]?.event).toMatchObject({ type: 'run.end', status: 'error' });
    expect(h.runManager.replay('run-9').map((e) => e.kind)).toEqual(['run.started', 'step', 'run.ended']);
  });

  it('replays the buffered log for a reopened panel', async () => {
    const h = harness();
    const first = h.connect();
    first.send('run.start', { prompt: 'go', config });
    await settle();
    h.scripted.finish();
    await settle();

    const reopened = h.connect();
    reopened.send('runlog.replay', { runId: 'run-1' });
    await settle();
    const replay = reopened.received('runlog.replay')[0] as { runId: string; events: RunEvent[] };
    expect(replay.runId).toBe('run-1');
    expect(replay.events.map((e) => e.kind)).toEqual(['run.started', 'input.fidelity', 'step', 'run.ended']);
  });

  it('replays the durable log after a worker restart, ending the interrupted run cleanly (M6)', async () => {
    const stores = memoryStores();
    await stores.replay.save('run-9', [
      {
        kind: 'run.started',
        runId: 'run-9',
        prompt: 'go',
        config,
        tabId: 3,
        url: 'https://example.test/',
        at: 1,
      },
      { kind: 'step', n: 1, role: 'follower', at: 2 },
    ]);

    // A brand-new manager with an empty ring: everything it knows comes from the store.
    const host = new FakeHost();
    const restarted = new RunManager({
      driver: fakeDriver(),
      tabs: { activeTab: async () => ({ id: 3, url: 'https://example.test/' }), get: async () => ({ id: 3, url: 'https://example.test/' }) },
      host,
      createModel: (model) => new FakeChatModel({ label: model }),
      runUserscript: async (scriptId) => ({ scriptId, ok: true, console: [], durationMs: 0 }),
      replayStore: stores.replay,
    });
    const worker = createWorker({ host, runManager: restarted, getConfig: async () => config });

    const [workerSide, panelSide] = createFakePortPair();
    const channel = createChannel<unknown, unknown>(panelSide);
    const sent: Envelope<unknown>[] = [];
    channel.onMessage((envelope) => sent.push(envelope));
    worker.connect(workerSide);
    channel.send('runlog.replay', { runId: 'run-9' });
    await settle();

    const replay = sent.filter((e) => e.type === 'runlog.replay').map((e) => e.payload)[0] as {
      runId: string;
      events: RunEvent[];
    };
    expect(replay.runId).toBe('run-9');
    expect(replay.events.map((e) => e.kind)).toEqual(['run.started', 'step', 'run.ended']);
    expect(replay.events.at(-1)).toMatchObject({ status: 'error' });
    expect((replay.events.at(-1) as { message: string }).message).toContain('restarted');
  });

  it('delegates pause, resume and abort to the live run', async () => {
    const h = harness();
    const panel = h.connect();
    panel.send('run.start', { prompt: 'go', config });
    await settle();

    const pause = vi.spyOn(h.runManager, 'pause');
    const abort = vi.spyOn(h.runManager, 'abort');
    panel.send('run.pause', { runId: 'run-1' });
    panel.send('run.abort', { runId: 'run-1' });
    await settle();
    expect(pause).toHaveBeenCalledWith('run-1');
    expect(abort).toHaveBeenCalledWith('run-1');
    h.scripted.finish();
    await settle();
  });

  // Regression: killing the CLI client that started a dev-triggered run left it running
  // forever -- there was no path from the dev socket to `runManager.abort`. `cancel` now
  // pushes a host `run.abort`, which the worker must forward the same way a panel's does.
  it('forwards a host-pushed run.abort to the live run, same as a panel-initiated one', async () => {
    const h = harness();
    h.host.devTrigger?.({ runId: 'run-dev', prompt: 'go', url: 'https://x.test/' });
    await settle();

    const abort = vi.spyOn(h.runManager, 'abort');
    h.host.abortTrigger?.({ runId: 'run-dev' });
    expect(abort).toHaveBeenCalledWith('run-dev');
    expect(h.host.logs.at(-1)).toMatchObject({ level: 'info', message: expect.stringContaining('matched active run run-dev') });
    h.scripted.finish();
    await settle();
  });

  // A live test on real Chrome found the failure mode this covers: a `cancel` for a runId
  // that is not (or no longer) active silently did nothing, with no way to tell the
  // difference from the fix actually working. Logging the miss makes that diagnosable.
  it('logs, rather than silently doing nothing, when a host-pushed run.abort matches no active run', async () => {
    const h = harness();
    h.host.abortTrigger?.({ runId: 'not-a-real-run' });
    expect(h.host.logs.at(-1)).toMatchObject({
      level: 'warn',
      message: expect.stringContaining('not-a-real-run'),
    });
  });
});

describe('createWorker: userscripts', () => {
  it('routes a userscript.run to the subsystem and returns its result on the port', async () => {
    const seen: unknown[] = [];
    const h = harness({
      handleUserscript: async (message, context) => {
        seen.push({ message, tabId: await context?.resolveTabId?.() });
        if (message.type !== 'userscript.run') return undefined;
        return {
          type: 'userscript.result',
          payload: { scriptId: message.payload.scriptId, ok: true, value: 2, console: [], durationMs: 3 },
        };
      },
    });
    const panel = h.connect();

    panel.send('userscript.run', { scriptId: 's1', code: 'return 2;' });
    await settle();

    expect(seen).toEqual([
      { message: { type: 'userscript.run', payload: { scriptId: 's1', code: 'return 2;' } }, tabId: 3 },
    ]);
    expect(panel.received('userscript.result')).toEqual([
      { scriptId: 's1', ok: true, value: 2, console: [], durationMs: 3 },
    ]);
  });

  it('routes list, save and delete and replies with the refreshed list', async () => {
    const types: string[] = [];
    const h = harness({
      handleUserscript: async (message) => {
        types.push(message.type);
        return { type: 'userscript.list', payload: { scripts: [] } };
      },
    });
    const panel = h.connect();
    panel.send('userscript.list', {});
    panel.send('userscript.save', { id: 'a', name: 'a', matches: ['*://x/*'], code: '1', updatedAt: 0 });
    panel.send('userscript.delete', { id: 'a' });
    await settle();
    expect(types).toEqual(['userscript.list', 'userscript.save', 'userscript.delete']);
    expect(panel.received('userscript.list')).toHaveLength(3);
  });

  it('saves each panel\'s own last result, not whichever panel ran last', async () => {
    const h = harness({
      handleUserscript: async (message) => {
        if (message.type !== 'userscript.run') return undefined;
        return {
          type: 'userscript.result',
          payload: { scriptId: message.payload.scriptId, ok: true, value: { from: message.payload.scriptId }, console: [], durationMs: 1 },
        };
      },
    });
    const first = h.connect();
    const second = h.connect();

    first.send('userscript.run', { scriptId: 'first', code: '' });
    await settle();
    second.send('userscript.run', { scriptId: 'second', code: '' });
    await settle();
    first.send('userscript.saveResult', {});
    await settle();

    expect(h.host.artifacts).toHaveLength(1);
    expect(JSON.parse(h.host.artifacts[0]!.content)).toEqual({ from: 'first' });
    expect(first.received('userscript.saved')).toEqual([
      { filename: 'userscript.json', path: '/artifacts/panel/userscript.json', bytes: h.host.artifacts[0]!.content.length },
    ]);
  });

  it('refuses to save before the panel has a result', async () => {
    const h = harness();
    const panel = h.connect();
    panel.send('userscript.saveResult', {});
    await settle();
    expect(panel.received('error')).toEqual([{ message: 'no userscript result to save', inReplyTo: 'userscript.saveResult' }]);
    expect(h.host.artifacts).toEqual([]);
  });

  it('reports a handler failure as an error message rather than dropping the reply', async () => {
    const h = harness({
      handleUserscript: async () => {
        throw new Error('catalog is corrupt');
      },
    });
    const panel = h.connect();
    panel.send('userscript.list', {});
    await settle();
    expect(panel.received('error')).toEqual([{ message: 'catalog is corrupt', inReplyTo: 'userscript.list' }]);
  });
});

describe('createWorker: dev trigger', () => {
  it('starts the pushed run and answers with run.end when it finishes', async () => {
    const h = harness();
    const panel = h.connect();

    h.host.devTrigger?.({ runId: 'run-dev', prompt: 'do the thing', url: 'https://x.test/start' });
    await settle();

    expect(h.navigated).toEqual(['https://x.test/start']);
    expect(h.scripted.seen[0]?.runId).toBe('run-dev');
    // The panel sees the dev run too — it is the same run log (R-07).
    expect(panel.received('run.event')).not.toHaveLength(0);

    h.scripted.finish();
    await settle();

    expect(h.host.log.at(-1)).toEqual({
      runId: 'run-dev',
      event: { type: 'run.end', runId: 'run-dev', status: 'done', message: 'objective complete', steps: 1, at: 1_000 },
    });
  });

  it('answers with run.end(error) when the requested url cannot be opened', async () => {
    const h = harness({ tabUrl: 'chrome://settings' });
    h.host.devTrigger?.({ runId: 'run-dev', prompt: 'go', url: 'https://x.test/' });
    await settle();
    expect(h.host.log.at(-1)?.event).toMatchObject({ type: 'run.end', status: 'error' });
    expect(h.navigated).toEqual([]);
  });
});

describe('ext.reload (the dev self-reload)', () => {
  it('calls the reload seam when the host pushes ext.reload', () => {
    const reload = vi.fn();
    const h = harness({ reloadExtension: reload });
    expect(reload).not.toHaveBeenCalled();
    h.host.reloadTrigger?.();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('forwards a reload failure to ext.log instead of throwing at the host', () => {
    const h = harness({
      reloadExtension: () => {
        throw new Error('not allowed here');
      },
    });
    expect(() => h.host.reloadTrigger?.()).not.toThrow();
    expect(h.host.logs).toEqual([
      { level: 'error', source: 'worker', message: 'ext.reload failed: not allowed here', at: 1_000 },
    ]);
  });

  it('drops the subscription on dispose', () => {
    const reload = vi.fn();
    const h = harness({ reloadExtension: reload });
    h.worker.dispose();
    h.host.reloadTrigger?.();
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('log.append relay', () => {
  it('relays a panel diagnostic to the host, unchanged', () => {
    const h = harness();
    const panel = h.connect();
    const entry = { level: 'error' as const, source: 'panel' as const, message: 'panel blew up', stack: 'at x', at: 7 };
    panel.send('log.append', entry);
    expect(h.host.logs).toEqual([entry]);
  });

  it('sends no reply, so a forwarded error cannot start a message ping-pong', () => {
    const h = harness();
    const panel = h.connect();
    const before = panel.sent.length;
    panel.send('log.append', { level: 'warn', source: 'panel', message: 'careful', at: 8 });
    expect(panel.sent.length).toBe(before);
  });
});

describe('applyRunOptions', () => {
  it('carries the model source, so the CLI can reach a model that only works on one gateway', () => {
    // meta/muse-spark-1.3-contributor 404s on OpenRouter and works on Kilo, so the id
    // alone cannot say where a run should go.
    const next = applyRunOptions(config, {
      leaderModel: 'meta/muse-spark-1.3-contributor',
      leaderModelSource: 'kilo',
      followerModelSource: 'openrouter',
    });
    expect(next.leaderModelSource).toBe('kilo');
    expect(next.followerModelSource).toBe('openrouter');
  });

  it('ignores a source that is not a known gateway', () => {
    const next = applyRunOptions(config, { leaderModelSource: 'not-a-gateway' });
    expect(next.leaderModelSource).toBe(config.leaderModelSource);
  });

  it('folds known dev-trigger options over the stored config and ignores the rest', () => {
    expect(
      applyRunOptions(config, { navMode: 'both', maxSteps: 3, inputFidelity: 'escalated', nonsense: true }),
    ).toEqual({ ...config, observe: 'both', maxSteps: 3, inputFidelity: 'escalated' });
    expect(applyRunOptions(config, { observe: 'sideways', maxSteps: -1 })).toEqual(config);
    expect(applyRunOptions(config)).toEqual(config);
  });
});
