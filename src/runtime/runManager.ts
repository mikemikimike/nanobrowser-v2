/**
 * One run at a time, and everything a run needs assembled around it.
 *
 * The manager is the only place that knows how to turn a side-panel `Config`
 * (R-05/R-08/R-11/R-13) plus "the tab the user already has open" (R-01) into the
 * arguments `startRun` wants. It owns the fan-out of the run log (R-07): every
 * event goes to the connected panels, to the host's run-log sink, and to an
 * in-memory ring buffer that backs `runlog.replay` when the panel reopens.
 *
 * Model construction lives here because of C-07: the thing that holds the key
 * (the native host, behind `createHostFetch`) does not choose the model — the
 * panel does, separately for the Leader and the Follower (R-11).
 */
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import { startRun as defaultStartRun, type RunEndedEvent, type RunHandle } from '@/src/agent/run';
import { validateObserveForVision } from '@/src/agent/grounding';
import { stepsIn, type ReplayStore, type UserscriptValueStore } from './durability';
import type { RunEvent, RunId, Userscript } from '@/src/messaging';
import type { WriteUserscriptRequest } from '@/src/agent/tools';
import type { Config, ModelSource } from '@/src/storage';
import type { InputTier } from '@/src/input';
import {
  listUserscripts,
  matchesAny,
  resolveUserscript,
  seedDefaults,
  setUserscriptProgressListener,
  writeAgentUserscript,
} from '@/src/userscripts';
import type { AgentWriteResult } from '@/src/userscripts';
import {
  EscalatableInput,
  createInPageTier,
  createInputPagePort,
  createPageTools,
  type RunUserscript,
  type RuntimeDriver,
} from './pageTools';

/**
 * Default `listAvailableUserscripts` (R-09): seeds the bundled examples into an
 * empty catalog, then filters the catalog by the run's tab URL. This is how a
 * bundled script like `ebay-search-extract` reaches the Follower without the user
 * ever opening the userscripts panel first.
 */
async function defaultListAvailableUserscripts(url: string): Promise<Array<{ id: string; name: string }>> {
  await seedDefaults();
  const scripts = await listUserscripts();
  return scripts.filter((s) => matchesAny(s.matches, url)).map((s) => ({ id: s.id, name: s.name }));
}

/**
 * The scripts `list_userscripts` shows the Follower: the ones it wrote itself, plus
 * the user's that already apply to the tab the run started on.
 *
 * Not the whole catalog. An adversarial review pointed out that handing the model
 * every id — including user-written scripts that the authoring rails never vetted,
 * and which may write the DOM or submit forms — combines with `navigate` into "go to
 * the host this script targets and run it". Filtering by the starting tab is the same
 * basis {@link defaultListAvailableUserscripts} already uses for the Follower's
 * context line, so the two agree, and it errs toward showing fewer.
 */
export async function defaultListUserscriptsForAgent(url: string): Promise<Userscript[]> {
  await seedDefaults();
  const scripts = await listUserscripts();
  return scripts.filter((script) => script.author === 'agent' || matchesAny(script.matches, url));
}

/** The tab a run acts on. */
export interface TargetTab {
  id: number;
  url: string;
}

/** Tab resolution seam (R-01). Production wires this to `chrome.windows`/`chrome.tabs`. */
export interface TabsPort {
  /** The active tab of the last focused normal window. */
  activeTab(): Promise<TargetTab | undefined>;
  get(tabId: number): Promise<TargetTab | undefined>;
}

/**
 * The dev trigger's terminator (docs/host-protocol.md): the host closes a socket
 * subscriber when a run-log event's `type` is `run.end`. Our contract events are
 * keyed by `kind`, so this is a separate, host-only wire shape.
 */
export interface HostRunEndEvent {
  type: 'run.end';
  runId: string;
  status: RunEndedEvent['status'];
  message: string;
  steps: number;
  at: number;
}

/** The host's run-log sink. `HostClient` satisfies it. */
export interface RunLogSink {
  appendRunLog(runId: string, event: RunEvent | HostRunEndEvent): void;
  /**
   * `save_file`'s host half (docs/host-protocol.md's `artifact.save`). Optional so
   * an older or test `RunLogSink` still satisfies this interface; absent means
   * `save_file` only writes to the Downloads folder, not the host.
   */
  saveArtifact?(runId: string, filename: string, content: string): Promise<{ path: string; bytes: number }>;
}

export interface RunManagerDeps {
  driver: RuntimeDriver;
  tabs: TabsPort;
  host: RunLogSink;
  /** Builds a chat model for one model id (R-11: leader and follower separately). `source` routes to the right base URL/credential; absent means OpenRouter. */
  createModel: (model: string, source?: ModelSource) => BaseChatModel;
  /** Absent means escalation is impossible on this platform; runs stay in-page. */
  makeDebuggerTier?: (onDetach: (reason: string) => void) => InputTier;
  runUserscript: RunUserscript;
  /**
   * Which stored userscripts apply to the run's tab, by id/name, so the Follower
   * knows what `run_userscript` id it may call (R-09). Defaults to the real
   * catalog (seeded with the bundled examples first), filtered by match pattern.
   */
  listAvailableUserscripts?: (url: string) => Promise<Array<{ id: string; name: string }>>;
  /**
   * What the Follower's `list_userscripts` may see. Defaults to
   * {@link defaultListUserscriptsForAgent}.
   */
  listUserscriptCatalog?: (url: string) => Promise<Userscript[]>;
  /**
   * The agent's own write path (R-10/O-03). Defaults to the real one, whose rails
   * live in `src/userscripts/authoring.ts`.
   */
  writeUserscript?: (request: WriteUserscriptRequest) => Promise<AgentWriteResult>;
  /** Seam for tests. */
  start?: typeof defaultStartRun;
  checkpointer?: BaseCheckpointSaver;
  /** Persists `session:lastRunId` so a reopened panel can replay (R-07). */
  saveLastRunId?: (runId: RunId) => Promise<void>;
  /**
   * Durable replay ring (M6): every published event is also saved here, so a
   * panel reopened after a service-worker restart replays the partial log.
   * Absent means memory only, as before.
   */
  replayStore?: ReplayStore;
  /**
   * Durable last-userscript value per run (M6): `save_file(fromLastUserscript:
   * true)` after a restart reads this instead of failing obscurely. Absent
   * means the value lives only in the run's closure, as before.
   */
  userscriptValueStoreFor?: (runId: RunId) => UserscriptValueStore | undefined;
  newRunId?: () => RunId;
  now?: () => number;
  /** Events kept per run for `runlog.replay`. */
  ringSize?: number;
  /** Runs kept in the ring buffer. */
  ringRuns?: number;
}

export interface StartOptions {
  prompt: string;
  config: Config;
  /** Defaults to the active tab of the last focused normal window (R-01). */
  tabId?: number;
  /** Supplied by the dev trigger, which subscribes by run id. */
  runId?: RunId;
  /**
   * Whether the Follower model can see images. Absent means unknown (runs that
   * predate the flag proceed as today); explicitly false plus `pixels`/`both`
   * is refused rather than run blind (M5 closes O-06).
   */
  followerVision?: boolean;
}

export interface StartResult {
  runId: RunId;
  /** False when the run was refused before it began; `done` still resolves. */
  ok: boolean;
  done: Promise<RunEndedEvent>;
}

export const DEFAULT_RING_SIZE = 2000;
const DEFAULT_RING_RUNS = 5;

/** Schemes a run may never touch: extension pages (the side panel itself) and browser UI. */
const REFUSED_SCHEMES = [
  'chrome://',
  'chrome-untrusted://',
  'chrome-extension://',
  'devtools://',
  'edge://',
  'about:',
  'view-source:',
];

/** Why this URL cannot be driven, or `undefined` when it can. */
export function refuseReason(url: string): string | undefined {
  const lower = url.toLowerCase();
  const scheme = REFUSED_SCHEMES.find((s) => lower.startsWith(s));
  if (!scheme) return undefined;
  if (scheme === 'chrome-extension://') {
    return `refusing to run on an extension page (${url}): open the page you want the agent to work on, then start the run`;
  }
  return `refusing to run on a browser page (${url}): ${scheme} pages cannot be scripted; open a normal web page first`;
}

interface ActiveRun {
  runId: RunId;
  handle: RunHandle;
  input: EscalatableInput;
}

export class RunManager {
  readonly #deps: RunManagerDeps;
  readonly #listeners = new Set<(runId: RunId, event: RunEvent) => void>();
  readonly #ring = new Map<RunId, RunEvent[]>();
  /** The tail of each run's persist chain. Deleted once the terminal event's save lands. */
  readonly #persistTails = new Map<RunId, Promise<void>>();
  #active: ActiveRun | undefined;

  constructor(deps: RunManagerDeps) {
    this.#deps = deps;
  }

  /** The tab's URL now, so a navigate changes which scripts the list and the prompt show. */
  async #liveUrl(tab: TargetTab): Promise<string> {
    try {
      const live = await this.#deps.tabs.get(tab.id);
      if (live?.url) return live.url;
    } catch {
      // The tab closed. The URL from start is the last one we have.
    }
    return tab.url;
  }

  /** Subscribes to every event of every run. Returns an unsubscribe. */
  onEvent(listener: (runId: RunId, event: RunEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  get activeRunId(): RunId | undefined {
    return this.#active?.runId;
  }

  /** Buffered events for a run, oldest first (R-07's replay). */
  replay(runId: RunId): RunEvent[] {
    return [...(this.#ring.get(runId) ?? [])];
  }

  /**
   * Rehydrates one run's replay buffer after a service-worker restart (M6).
   * A no-op when the buffer is already in memory or nothing was persisted.
   *
   * A restored log with no terminal event is a run that died with the old
   * worker: it gets one clean `run.ended{error}` naming the restart, published
   * like any other event so the panel, the host log and the store agree, plus the
   * `run.end` frame nb-run exits on (devRun's `end()` died with the old worker,
   * so without this an unattended run would stream its terminal event and then
   * hang). The alternative — silently resuming a graph against a tab that may
   * have moved on — would be an invented continuation.
   */
  async restoreReplay(runId: RunId): Promise<void> {
    if (this.#ring.has(runId)) return;
    const stored = await this.#deps.replayStore?.load(runId).catch((error: unknown) => {
      console.warn('[nanobrowser] could not load persisted replay', error);
      return undefined;
    });
    if (!stored) return;
    // Recheck after the await: two panels restoring the same run concurrently
    // would otherwise each publish their own synthetic terminal event.
    if (this.#ring.has(runId)) return;
    this.#ring.set(runId, [...stored]);
    const last = stored.at(-1);
    const now = this.#deps.now ?? Date.now;
    if (last?.kind === 'run.ended') {
      // Finished before the restart — but devRun's run.end frame goes out after the
      // terminal snapshot lands, so it may still have died with the old worker while
      // nb-run waits. Re-emit it from the stored terminal: the trigger closes
      // subscribers idempotently, and log readers last-win, so a duplicate only
      // costs a log line while a missing frame hangs the client.
      try {
        this.#deps.host.appendRunLog(runId, {
          type: 'run.end',
          runId,
          status: last.status,
          message: last.message,
          steps: last.steps,
          at: now(),
        });
      } catch (error) {
        console.warn('[nanobrowser] could not publish the restarted run end', error);
      }
      return;
    }
    const message = 'the extension restarted mid-run; showing the partial log up to the restart';
    const steps = stepsIn(stored);
    this.#publish(runId, { kind: 'run.ended', status: 'error', message, steps, at: now() });
    try {
      this.#deps.host.appendRunLog(runId, { type: 'run.end', runId, status: 'error', message, steps, at: now() });
    } catch (error) {
      console.warn('[nanobrowser] could not publish the restarted run end', error);
    }
  }

  async start(options: StartOptions): Promise<StartResult> {
    const now = this.#deps.now ?? Date.now;
    const runId = options.runId ?? (this.#deps.newRunId ?? (() => crypto.randomUUID()))();
    const { config, prompt } = options;

    if (this.#active) {
      return this.#refuse(runId, `a run is already in progress (${this.#active.runId}); abort it first`);
    }

    const tab =
      options.tabId !== undefined
        ? await this.#deps.tabs.get(options.tabId)
        : await this.#deps.tabs.activeTab();
    if (!tab) {
      return this.#refuse(runId, 'no tab to act on: open the page you want the agent to work on');
    }
    const refusal = refuseReason(tab.url);
    if (refusal) return this.#refuse(runId, refusal);

    if (!config.leaderModel || !config.followerModel) {
      return this.#refuse(
        runId,
        'no model selected: choose a Leader model and a Follower model in the side panel',
      );
    }

    const visionRefusal = validateObserveForVision(config.observe, options.followerVision);
    if (visionRefusal) return this.#refuse(runId, visionRefusal);

    // Ordering guarantee: `run.started` is the first event of every run. Anything
    // emitted while the run is being assembled (e.g. `input.fidelity` from the
    // debugger attach) is held until it has gone out.
    let started = false;
    const pending: RunEvent[] = [];
    const publish = (event: RunEvent): void => this.#publish(runId, event);
    const emit = (event: RunEvent): void => {
      if (event.kind === 'run.started') {
        started = true;
        publish(event);
        for (const held of pending.splice(0)) publish(held);
        return;
      }
      if (!started) {
        pending.push(event);
        return;
      }
      publish(event);
    };

    let input!: EscalatableInput;
    const debuggerTier =
      config.inputFidelity === 'escalated'
        ? this.#deps.makeDebuggerTier?.((reason) => input?.handleDetach(reason))
        : undefined;

    input = new EscalatableInput({
      fidelity: config.inputFidelity,
      inPageTier: createInPageTier(this.#deps.driver),
      ...(debuggerTier ? { debuggerTier } : {}),
      page: createInputPagePort(this.#deps.driver, tab.id),
      emit,
      ...(this.#deps.now ? { now: this.#deps.now } : {}),
    });

    const host = this.#deps.host;
    const userscriptValueStore = this.#deps.userscriptValueStoreFor?.(runId);
    const readOnly = config.readOnly ?? false;
    const tools = createPageTools({
      tabId: tab.id,
      driver: this.#deps.driver,
      input,
      observe: config.observe,
      runUserscript: this.#deps.runUserscript,
      listUserscripts: async () =>
        (this.#deps.listUserscriptCatalog ?? defaultListUserscriptsForAgent)(await this.#liveUrl(tab)),
      // Whole-catalog resolution for the read-only preflight: unlike the display
      // list above, it must see scripts matching wherever the run navigated to.
      resolveUserscript,
      writeUserscript: this.#deps.writeUserscript ?? ((request) => writeAgentUserscript(request)),
      emit,
      runId,
      ...(readOnly ? { readOnly } : {}),
      ...(userscriptValueStore ? { userscriptValueStore } : {}),
      ...(host.saveArtifact ? { saveArtifact: (filename: string, content: string) => host.saveArtifact!(runId, filename, content) } : {}),
      ...(this.#deps.now ? { now: this.#deps.now } : {}),
    });

    const listAvailable = this.#deps.listAvailableUserscripts ?? defaultListAvailableUserscripts;
    const availableUserscripts = await listAvailable(await this.#liveUrl(tab)).catch((error: unknown) => {
      console.warn('[nanobrowser] could not list available userscripts', error);
      return [];
    });

    let models: { leader: BaseChatModel; follower: BaseChatModel };
    try {
      // C-07: two independent handles, both proxied through the host's fetch.
      models = {
        leader: this.#deps.createModel(config.leaderModel, config.leaderModelSource),
        follower: this.#deps.createModel(config.followerModel, config.followerModelSource),
      };
    } catch (error) {
      return this.#refuse(runId, `could not build the models: ${describe(error)}`);
    }

    try {
      await input.attach(tab.id);
    } catch (error) {
      return this.#refuse(runId, `could not attach input to the tab: ${describe(error)}`);
    }

    setUserscriptProgressListener((scriptId, line) => {
      publish({ kind: 'userscript.output', scriptId, level: line.level, text: line.text, at: line.at });
    });

    const start = this.#deps.start ?? defaultStartRun;
    const handle = start({
      prompt,
      config,
      tools,
      models,
      onEvent: emit,
      runId,
      tabId: tab.id,
      url: tab.url,
      availableUserscripts,
      refreshUserscripts: async () => listAvailable(await this.#liveUrl(tab)),
      ...(this.#deps.checkpointer ? { checkpointer: this.#deps.checkpointer } : {}),
    });

    this.#active = { runId, handle, input };
    void this.#deps.saveLastRunId?.(runId).catch((error: unknown) => {
      console.warn('[nanobrowser] could not persist session:lastRunId', error);
    });

    const done = handle.done
      .catch(
        (error: unknown): RunEndedEvent => ({
          kind: 'run.ended',
          status: 'error',
          message: describe(error),
          steps: 0,
          at: now(),
        }),
      )
      .then(async (ended) => {
        setUserscriptProgressListener(undefined);
        // R-13 hygiene: the escalated session is held for exactly one run.
        await input.detach().catch((error: unknown) => {
          console.warn('[nanobrowser] input detach failed', error);
        });
        // Durability: done resolves only once the terminal snapshot has landed,
        // so a worker restart right after success cannot restore a stale prefix
        // and falsely mark the run interrupted.
        await (this.#persistTails.get(runId) ?? Promise.resolve());
        if (this.#active?.runId === runId) this.#active = undefined;
        return ended;
      });

    return { runId, ok: true, done };
  }

  pause(runId: RunId): boolean {
    if (this.#active?.runId !== runId) return false;
    this.#active.handle.pause();
    return true;
  }

  resume(runId: RunId): boolean {
    if (this.#active?.runId !== runId) return false;
    this.#active.handle.resume();
    return true;
  }

  abort(runId: RunId): boolean {
    if (this.#active?.runId !== runId) return false;
    this.#active.handle.abort();
    return true;
  }

  /** Navigates the tab the run will act on. Used by the dev trigger's `url`. */
  async navigateActiveTab(url: string): Promise<void> {
    const tab = await this.#deps.tabs.activeTab();
    if (!tab) throw new Error('no tab to navigate');
    const refusal = refuseReason(tab.url);
    if (refusal) throw new Error(refusal);
    const result = await this.#deps.driver.navigate(tab.id, url);
    if (!result.ok) throw new Error(result.error ?? `navigation to ${url} failed`);
  }

  /** The tab a run would target right now, refusal reason included. */
  async resolveTabId(): Promise<number | undefined> {
    const tab = await this.#deps.tabs.activeTab();
    if (!tab || refuseReason(tab.url)) return undefined;
    return tab.id;
  }

  #refuse(runId: RunId, message: string): StartResult {
    const now = this.#deps.now ?? Date.now;
    const ended: RunEndedEvent = {
      kind: 'run.ended',
      status: 'error',
      message,
      steps: 0,
      at: now(),
    };
    this.#publish(runId, ended);
    // Refusals flush like completions: the terminal save must land before done.
    return { runId, ok: false, done: (this.#persistTails.get(runId) ?? Promise.resolve()).then(() => ended) };
  }

  #publish(runId: RunId, event: RunEvent): void {
    this.#remember(runId, event);
    for (const listener of [...this.#listeners]) {
      try {
        listener(runId, event);
      } catch (error) {
        console.warn('[nanobrowser] run-event listener threw', error);
      }
    }
    try {
      this.#deps.host.appendRunLog(runId, event);
    } catch (error) {
      console.warn('[nanobrowser] appendRunLog failed', error);
    }
  }

  #remember(runId: RunId, event: RunEvent): void {
    const size = this.#deps.ringSize ?? DEFAULT_RING_SIZE;
    let buffer = this.#ring.get(runId);
    if (!buffer) {
      buffer = [];
      this.#ring.set(runId, buffer);
      const maxRuns = this.#deps.ringRuns ?? DEFAULT_RING_RUNS;
      while (this.#ring.size > maxRuns) {
        const oldest = this.#ring.keys().next();
        if (oldest.done) break;
        this.#ring.delete(oldest.value);
      }
    }
    buffer.push(event);
    if (buffer.length > size) buffer.splice(0, buffer.length - size);
    // Ordered fire-and-forget: each save waits for the run's previous one, so a slow
    // store cannot land snapshots out of order and hide the tail behind a stale
    // prefix after a restart. The snapshot is frozen here, at queue time — the buffer
    // keeps growing while a gated save waits. The run never waits; a failed save only warns.
    const snapshot = [...buffer];
    const prev = this.#persistTails.get(runId) ?? Promise.resolve();
    // The active run is exempt from durable eviction: refused starts persist
    // terminal events too, so a burst of refusals behind a slow model call must
    // not push the active run's keys out of the ring.
    const protect = this.#active ? [this.#active.runId] : [];
    const save = prev.catch(() => {}).then(() => this.#deps.replayStore?.save(runId, snapshot, { protect }));
    const tail = save.catch((error: unknown) => {
      console.warn('[nanobrowser] could not persist replay event', error);
    });
    this.#persistTails.set(runId, tail);
    if (event.kind === 'run.ended') {
      void tail.finally(() => {
        if (this.#persistTails.get(runId) === tail) this.#persistTails.delete(runId);
      });
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ------------------------------------------------------------------------- */
/* Production wiring helpers                                                  */
/* ------------------------------------------------------------------------- */

/** `TabsPort` over the real `chrome.windows`/`chrome.tabs` (R-01). */
export function chromeTabsPort(): TabsPort {
  return {
    async activeTab() {
      try {
        const window = await chrome.windows.getLastFocused({ populate: true, windowTypes: ['normal'] });
        const active = window.tabs?.find((tab) => tab.active);
        if (active?.id !== undefined) return { id: active.id, url: active.url ?? '' };
      } catch {
        // Fall through to the query below: no focused normal window (all minimised, say).
      }
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tab?.id === undefined) return undefined;
      return { id: tab.id, url: tab.url ?? '' };
    },
    async get(tabId) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.id === undefined) return undefined;
        return { id: tab.id, url: tab.url ?? '' };
      } catch {
        return undefined;
      }
    },
  };
}
