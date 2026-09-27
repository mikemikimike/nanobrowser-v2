/**
 * The review found no test anywhere proving `createWorker`'s panel-message
 * handling survives malformed input from a peer: `src/messaging/contract.ts`
 * is compile-time-only (no runtime schema), `asPanelMessage` casts the payload
 * with `as PanelToWorkerMessage` after only checking `envelope.type` is a known
 * string, and `connect()`'s own message handler reads `envelope.type` before
 * any shape check at all. This file drives the raw port directly (bypassing
 * the typed `Panel.send` helper other worker tests use, which cannot express
 * a malformed envelope) and proves what actually happens.
 *
 * Note: an earlier draft of this file also covered `checkModelPolicy`'s
 * dev-trigger call site, found missing coverage during the review. Concurrent
 * work elsewhere in the repo removed that mechanism entirely between the
 * review and this file being written ("Revert the free-models block; make it
 * agent guidance instead" — see CLAUDE.md's "Models and money" section, which
 * now states the restriction as agent behaviour, not a runtime check). Those
 * tests were dropped rather than asserting on code that no longer exists; see
 * docs/test-review.md for the note.
 */
import { describe, expect, it } from 'vitest';
import { createChannel, createFakePortPair, HUB_MESSAGE, type Envelope, type ModelInfo, type Readiness } from '@/src/messaging';
import type { Config } from '@/src/storage';
import type { StartOptions, StartResult } from './runManager';
import { createWorker, type DevRunStart, type HostPort, type RunManagerPort, type Worker } from './worker';

const config: Config = {
  leaderModel: 'fake/leader',
  followerModel: 'fake/follower',
  observe: 'dom',
  planningInterval: 5,
  maxSteps: 10,
  inputFidelity: 'in-page',
};

function fakeHost(overrides: Partial<HostPort> = {}): HostPort & { runStartHandler?: (msg: DevRunStart) => void } {
  const state: HostPort & { runStartHandler?: (msg: DevRunStart) => void } = {
    keyStatus: async () => ({ hostConnected: true, keyReady: true }) as Readiness,
    listModels: async () => [] as ModelInfo[],
    appendRunLog: () => {},
    onRunStart(handler) {
      state.runStartHandler = handler;
      return () => {
        state.runStartHandler = undefined;
      };
    },
    onRunAbort: () => () => {},
    appendLog: () => {},
    onExtReload: () => () => {},
    ...overrides,
  };
  return state;
}

/**
 * A `RunManagerPort` fake that throws on a plainly-invalid `StartOptions` --
 * mirroring the shape of validation the real `RunManager` does (it needs a
 * usable `config` before it can pick a model or a tab) -- so that a test
 * sending a malformed `run.start` payload through `createWorker` exercises the
 * same "something downstream throws" scenario the real thing would produce,
 * rather than silently accepting garbage because the fake happens not to look
 * at its input.
 */
function fakeRunManager(overrides: Partial<RunManagerPort> = {}): RunManagerPort & { starts: StartOptions[] } {
  const starts: StartOptions[] = [];
  return {
    starts,
    onEvent: () => () => {},
    async start(options: StartOptions): Promise<StartResult> {
      if (!options.config || typeof options.config !== 'object') {
        throw new TypeError('start() requires a config');
      }
      starts.push(options);
      return {
        runId: options.runId ?? 'r1',
        ok: true,
        done: Promise.resolve({ kind: 'run.ended', status: 'done', message: 'ok', steps: 0, at: 0 }),
      };
    },
    pause: () => true,
    resume: () => true,
    abort: () => true,
    replay: () => [],
    restoreReplay: async () => {},
    navigateActiveTab: async () => {},
    resolveTabId: async () => 1,
    activeRunId: undefined,
    ...overrides,
  };
}

function connectRaw(worker: Worker): { received: Envelope<unknown>[]; post: (message: unknown) => void } {
  const [workerSide, testSide] = createFakePortPair();
  const received: Envelope<unknown>[] = [];
  // Register the receiver's listener before worker.connect() fires its
  // synchronous `hello`, matching how a real panel attaches before the worker
  // side of the port exists (see worker.test.ts's `connect()` for the same
  // ordering requirement).
  const channel = createChannel<unknown, unknown>(testSide);
  channel.onMessage((e) => received.push(e));
  worker.connect(workerSide);
  return { received, post: (message) => testSide.postMessage(message as Envelope) };
}

/** Every reply after the initial `hub`/`hello` handshake message `connect()` always sends first. */
function repliesAfterHello(received: Envelope<unknown>[]): Envelope<unknown>[] {
  return received.filter((e) => e.type !== HUB_MESSAGE);
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('createWorker: malformed panel envelopes', () => {
  it('ignores a null or non-object envelope rather than throwing on envelope.type', async () => {
    // `tests/port.edge.test.ts` shows the port layer itself has no shape
    // validation and will deliver `null` verbatim. This is the one place that
    // reads `envelope.type` before any other check, so it is the seam that
    // must not assume a well-shaped envelope.
    const worker = createWorker({ host: fakeHost(), runManager: fakeRunManager(), getConfig: async () => config });
    const { post } = connectRaw(worker);

    expect(() => post(null)).not.toThrow();
    expect(() => post(42)).not.toThrow();
    expect(() => post('a string')).not.toThrow();
  });

  it('ignores an envelope with an unrecognised type, silently and without crashing', async () => {
    const worker = createWorker({ host: fakeHost(), runManager: fakeRunManager(), getConfig: async () => config });
    const { received, post } = connectRaw(worker);

    expect(() => post({ type: 'totally.bogus.type', id: 'x', payload: {} })).not.toThrow();
    await settle();

    expect(repliesAfterHello(received)).toEqual([]); // no reply at all -- not even an error
  });

  it('does not throw on a hub envelope with a garbage (non-object) payload', async () => {
    const worker = createWorker({ host: fakeHost(), runManager: fakeRunManager(), getConfig: async () => config });
    const { post } = connectRaw(worker);

    expect(() => post({ type: HUB_MESSAGE, id: 'x', payload: 'not-an-object' })).not.toThrow();
    expect(() => post({ type: HUB_MESSAGE, id: 'x', payload: null })).not.toThrow();
    await settle();
  });

  it('replies with an error rather than crashing when run.start arrives with a missing config', async () => {
    const worker = createWorker({ host: fakeHost(), runManager: fakeRunManager(), getConfig: async () => config });
    const { received, post } = connectRaw(worker);

    post({ type: 'run.start', id: 'x', payload: { prompt: 'go' } }); // no `config`
    await settle();

    const errors = repliesAfterHello(received).filter((e) => e.type === 'error');
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect((errors[0]?.payload as { message: string }).message).toContain('config');
  });

  it('replies with an error rather than crashing when run.start payload is entirely missing', async () => {
    const worker = createWorker({ host: fakeHost(), runManager: fakeRunManager(), getConfig: async () => config });
    const { received, post } = connectRaw(worker);

    post({ type: 'run.start', id: 'x', payload: undefined });
    await settle();

    const errors = repliesAfterHello(received).filter((e) => e.type === 'error');
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it('replies with an error rather than crashing when run.start payload is a string, not an object', async () => {
    const worker = createWorker({ host: fakeHost(), runManager: fakeRunManager(), getConfig: async () => config });
    const { received, post } = connectRaw(worker);

    post({ type: 'run.start', id: 'x', payload: 'not-an-object' });
    await settle();

    const errors = repliesAfterHello(received).filter((e) => e.type === 'error');
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it('a well-formed run.start still works after a preceding malformed message on the same channel', async () => {
    // Proves the worker's per-message error handling does not leave the
    // channel or the worker in a broken state for the next, valid message.
    const worker = createWorker({ host: fakeHost(), runManager: fakeRunManager(), getConfig: async () => config });
    const { received, post } = connectRaw(worker);

    post({ type: 'run.start', id: 'bad', payload: undefined });
    await settle();
    post({ type: 'run.start', id: 'good', payload: { prompt: 'go', config } });
    await settle();

    expect(repliesAfterHello(received).some((e) => e.type === 'error')).toBe(true);
  });
});
