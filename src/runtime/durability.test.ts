/**
 * M6 durability stores: memory backs round-trip, and the step counter reads
 * the restored log for the synthetic terminal event.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { memoryStores, sessionReplayStore, sessionUserscriptValueStore, stepsIn } from './durability';
import type { RunEvent } from '@/src/messaging';

const started: RunEvent = {
  kind: 'run.started',
  runId: 'r1',
  prompt: 'go',
  config: {
    leaderModel: 'l',
    followerModel: 'f',
    observe: 'dom',
    planningInterval: 5,
    maxSteps: 10,
    inputFidelity: 'in-page',
  },
  tabId: 3,
  url: 'https://example.test/',
  at: 1,
};

describe('memoryStores replay', () => {
  it('round-trips one run log without touching another', async () => {
    const { replay } = memoryStores();
    await replay.save('r1', [started, { kind: 'step', n: 1, role: 'follower', at: 2 }]);
    expect(await replay.load('r1')).toHaveLength(2);
    expect(await replay.load('r2')).toBeUndefined();
  });

  it('saves a copy: later publishes do not rewrite the stored array', async () => {
    const { replay } = memoryStores();
    const events: RunEvent[] = [started];
    await replay.save('r1', events);
    events.push({ kind: 'step', n: 1, role: 'follower', at: 2 });
    expect(await replay.load('r1')).toHaveLength(1);
  });
});

describe('memoryStores values', () => {
  it('reports missing until the first save, then returns the value', async () => {
    const { values } = memoryStores();
    expect(await values.load()).toEqual({ found: false });
    await values.save({ rows: [1, 2] });
    expect(await values.load()).toEqual({ found: true, value: { rows: [1, 2] } });
  });
});

describe('stepsIn', () => {
  it('returns the highest step number, or 0 for a log with no steps', () => {
    expect(
      stepsIn([started, { kind: 'step', n: 2, role: 'follower', at: 2 }, { kind: 'step', n: 1, role: 'leader', at: 3 }]),
    ).toBe(2);
    expect(stepsIn([started])).toBe(0);
  });
});

describe('session stores over a fake chrome area', () => {
  const globalChrome = globalThis as { chrome?: unknown };
  const realChrome = globalChrome.chrome;
  afterEach(() => {
    globalChrome.chrome = realChrome;
  });

  /** Map-backed session area with chrome's JSON semantics (undefined values drop). */
  function installFake() {
    const data = new Map<string, unknown>();
    const clone = (value: unknown): unknown =>
      value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as unknown);
    globalChrome.chrome = {
      storage: {
        session: {
          async get(key: string) {
            return data.has(key) ? { [key]: clone(data.get(key)) } : {};
          },
          async set(items: Record<string, unknown>) {
            for (const [key, value] of Object.entries(items)) data.set(key, clone(value));
          },
          async remove(keys: string | string[]) {
            for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key);
          },
        },
      },
    };
    return data;
  }

  it('round-trips an undefined userscript value as found, not absent', async () => {
    installFake();
    const store = sessionUserscriptValueStore('r1')!;
    await store.save(undefined);
    expect(await store.load()).toStrictEqual({ found: true, value: undefined });
  });

  it('evicts the oldest durable runs beyond the cap, replay and value keys alike', async () => {
    const data = installFake();
    const replay = sessionReplayStore()!;
    for (let i = 0; i < 7; i++) {
      await sessionUserscriptValueStore(`r${i}`)!.save({ i });
      await replay.save(`r${i}`, [started]);
    }

    expect(await replay.load('r0')).toBeUndefined();
    expect(await replay.load('r1')).toBeUndefined();
    expect(await replay.load('r2')).toHaveLength(1);
    expect(await sessionUserscriptValueStore('r0')!.load()).toEqual({ found: false });
    expect(await sessionUserscriptValueStore('r6')!.load()).toEqual({ found: true, value: { i: 6 } });
    // 5 runs × (replay + value) keys, plus the index itself.
    expect(data.size).toBe(11);
  });

  it('never evicts a protected run, even under a burst of other saves', async () => {
    installFake();
    const replay = sessionReplayStore()!;
    // An active run plus five refused starts: without protection the refusals
    // would push the active run out of the five-entry index and delete its keys,
    // leaving session:lastRunId pointing at unrestorable state.
    await replay.save('active', [started]);
    for (let i = 0; i < 5; i++) {
      await replay.save(`refused-${i}`, [started], { protect: ['active'] });
    }

    expect(await replay.load('active')).toHaveLength(1);
    expect(await replay.load('refused-0')).toBeUndefined();
    expect(await replay.load('refused-4')).toHaveLength(1);
  });
});
