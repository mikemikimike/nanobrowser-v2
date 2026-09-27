/**
 * Run durability across service-worker restarts (M6).
 *
 * The worker is ephemeral: Chrome may kill it at any time, taking
 * `RunManager`'s in-memory replay ring and `createPageTools`' last-userscript
 * closure with it. Both are persisted here in `chrome.storage.session` — the
 * same scope as the panel's `session:lastRunId` — so a reopened panel replays
 * the partial log instead of showing nothing. Session scope is deliberate: the
 * log names tabs whose state does not outlive the browser session anyway.
 *
 * SW-death policy: resume-from-checkpoint would re-drive a graph against a tab
 * whose page may have navigated away while we were dead — a silent wrong
 * continuation. Instead a restored run whose log has no terminal event gets
 * one clean `run.ended{error}` naming the restart, with the partial log
 * intact. No silent death, no invented continuation.
 */
import type { RunEvent, RunId } from '@/src/messaging';

/** Persisted replay ring for one run: the events `runlog.replay` serves. */
export interface ReplayStore {
  load(runId: RunId): Promise<RunEvent[] | undefined>;
  /**
   * Save a run's events. Runs named in `opts.protect` are never chosen for
   * eviction: refused starts each persist a terminal event, so without this a
   * burst of refusals behind an active run would evict the active run's keys
   * and leave `session:lastRunId` pointing at unrestorable state.
   */
  save(runId: RunId, events: RunEvent[], opts?: { protect?: RunId[] }): Promise<void>;
}

/**
 * The full untruncated value of the most recent successful `run_userscript`
 * call — what `save_file(fromLastUserscript:true)` writes. The closure in
 * `createPageTools` is the fast path; this is where it survives a restart.
 */
export interface UserscriptValueStore {
  load(): Promise<{ found: boolean; value?: unknown }>;
  save(value: unknown): Promise<void>;
}

function replayKey(runId: RunId): string {
  return `session:runlog:${runId}`;
}

function valueKey(runId: RunId): string {
  return `session:lastUserscriptValue:${runId}`;
}

type SessionArea = {
  get(keys: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
};

/** Runs kept in session storage. Mirrors `DEFAULT_RING_RUNS`: the durable log keeps what memory keeps. */
export const DURABLE_RUN_CAP = 5;

/** Most-recently-saved-first run ids with durable state. */
const INDEX_KEY = 'session:runlog:index';

function sessionArea(): SessionArea | undefined {
  try {
    const area = (globalThis as { chrome?: { storage?: { session?: SessionArea } } }).chrome?.storage?.session;
    return area ?? undefined;
  } catch {
    return undefined;
  }
}

/** The durable replay ring over `chrome.storage.session`. Undefined outside the extension. */
export function sessionReplayStore(): ReplayStore | undefined {
  const area = sessionArea();
  if (!area) return undefined;
  return {
    async load(id) {
      const found = (await area.get(replayKey(id)))[replayKey(id)];
      return Array.isArray(found) ? (found as RunEvent[]) : undefined;
    },
    async save(id, events, opts) {
      await area.set({ [replayKey(id)]: events });
      // Bounded index: without eviction every run's keys would accumulate until
      // the 10 MB session quota silently stops durability for the whole session.
      const raw = (await area.get(INDEX_KEY))[INDEX_KEY];
      const index = (Array.isArray(raw) ? raw.filter((v): v is RunId => typeof v === 'string') : []).filter(
        (v) => v !== id,
      );
      index.push(id);
      const protectedIds = new Set(opts?.protect ?? []);
      const victims = index.filter((v) => !protectedIds.has(v));
      const evicted = victims.splice(0, Math.min(victims.length, Math.max(0, index.length - DURABLE_RUN_CAP)));
      await area.set({ [INDEX_KEY]: index.filter((v) => !evicted.includes(v)) });
      for (const runId of evicted) {
        await area.remove([replayKey(runId), valueKey(runId)]).catch(() => {});
      }
    },
  };
}

/** The durable last-userscript value for one run. Undefined outside the extension. */
export function sessionUserscriptValueStore(runId: RunId): UserscriptValueStore | undefined {
  const area = sessionArea();
  if (!area) return undefined;
  return {
    async load() {
      // A presence wrapper, not the bare value: chrome.storage drops undefined, so
      // a script that returned undefined would otherwise load back as absent.
      const found = (await area.get(valueKey(runId)))[valueKey(runId)] as
        | { present?: unknown; value?: unknown }
        | undefined;
      return found?.present === true ? { found: true, value: found.value } : { found: false };
    },
    async save(value) {
      await area.set({ [valueKey(runId)]: { present: true, value } });
    },
  };
}

/** In-memory backs for tests (and any host without session storage). */
export function memoryStores(): {
  replay: ReplayStore;
  values: UserscriptValueStore;
  saved: { replays: Map<RunId, RunEvent[]>; value: unknown; hasValue: boolean };
} {
  const saved = { replays: new Map<RunId, RunEvent[]>(), value: undefined as unknown, hasValue: false };
  return {
    saved,
    replay: {
      async load(id) {
        return saved.replays.get(id);
      },
      async save(id, events) {
        saved.replays.set(id, [...events]);
      },
    },
    values: {
      async load() {
        return saved.hasValue ? { found: true, value: saved.value } : { found: false };
      },
      async save(value) {
        saved.value = value;
        saved.hasValue = true;
      },
    },
  };
}

/** Highest `step` number in a restored log, for the synthetic terminal event. */
export function stepsIn(events: RunEvent[]): number {
  let steps = 0;
  for (const event of events) {
    if (event.kind === 'step' && event.n > steps) steps = event.n;
  }
  return steps;
}
