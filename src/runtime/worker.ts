/**
 * The service worker's message hub: one place that owns the connected side
 * panels and answers every message in `src/messaging/contract.ts`.
 *
 * Everything it touches is a seam — `BrowserPort` for the panels, a `HostPort`
 * for the native host, a `RunManagerPort` for runs — so `worker.test.ts` drives
 * the whole surface with `FakeBrowserPort` + fakes and no browser at all.
 *
 * The scaffold's hub heartbeat (`hello`/`ping`/`pong`) rides the same port as
 * the contract, exactly as `entrypoints/sidepanel/usePanel.ts` expects: one
 * connection per panel, so a broadcast run event is never delivered twice.
 */
import {
  createChannel,
  HUB_MESSAGE,
  type BrowserPort,
  type Channel,
  type Envelope,
  type HubInbound,
  type HubOutbound,
  type ModelInfo,
  type PanelToWorker,
  type PanelToWorkerMessage,
  type Readiness,
  type RunEvent,
  type RunId,
  type WorkerToPanel,
  type WorkerToPanelMessage,
} from '@/src/messaging';
import type { Config, InputFidelity, ModelSource, ObserveMode } from '@/src/storage';
import type { ExtLogEntry } from './errorLog';
import { handleUserscriptMessage as defaultHandleUserscript, signalUserscriptStop } from '@/src/userscripts';
import { userscriptArtifactBody } from './pageTools';
import { sessionUserscriptValueStore } from './durability';
import type { HostRunEndEvent, StartOptions, StartResult } from './runManager';

/** Ten minutes: long enough that the panel never waits on the catalog twice, short enough to notice a new model. */
export const MODELS_CACHE_MS = 10 * 60 * 1000;

/** What a readiness failure means when the host itself is unreachable (R-11: validated, never assumed). */
export const HOST_UNREACHABLE_REASON =
  'native host not reachable: run host/install.sh and reload the extension';

/** The host-pushed dev trigger (docs/host-protocol.md). */
export interface DevRunStart {
  runId: string;
  prompt: string;
  url?: string;
  options?: Record<string, unknown>;
}

/** The slice of `HostClient` the worker uses. */
export interface HostPort {
  keyStatus(): Promise<Readiness>;
  listModels(): Promise<ModelInfo[]>;
  appendRunLog(runId: string, event: RunEvent | HostRunEndEvent): void;
  onRunStart(handler: (msg: DevRunStart) => void): () => void;
  /** Host-pushed cancellation (the dev trigger's `cancel` op) -- see docs/host-protocol.md. */
  onRunAbort(handler: (msg: { runId: string }) => void): () => void;
  appendLog(entry: ExtLogEntry): void;
  onExtReload(handler: () => void): () => void;
  saveArtifact?(runId: string, filename: string, content: string): Promise<{ path: string; bytes: number }>;
}

/** The slice of `RunManager` the worker uses. */
export interface RunManagerPort {
  onEvent(listener: (runId: RunId, event: RunEvent) => void): () => void;
  start(options: StartOptions): Promise<StartResult>;
  pause(runId: RunId): boolean;
  resume(runId: RunId): boolean;
  abort(runId: RunId): boolean;
  replay(runId: RunId): RunEvent[];
  /** Rehydrates one run's replay buffer from the durable store (M6). No-op when already in memory. */
  restoreReplay(runId: RunId): Promise<void>;
  navigateActiveTab(url: string): Promise<void>;
  resolveTabId(): Promise<number | undefined>;
  readonly activeRunId: RunId | undefined;
}

export interface WorkerDeps {
  host: HostPort;
  runManager: RunManagerPort;
  /** The panel's stored configuration, used by the dev trigger which sends none. */
  getConfig: () => Promise<Config>;
  /** Last watched run id (`session:lastRunId`), restored once at worker startup. */
  getLastRunId?: () => Promise<string | null>;
  handleUserscript?: typeof defaultHandleUserscript;
  extensionVersion?: string;
  modelsCacheMs?: number;
  now?: () => number;
  /**
   * Seam over `chrome.runtime.reload()`, which re-reads an unpacked extension from disk.
   * A seam and not a direct call: a test that actually reloaded would take the runner
   * with it, and this is the one line of the dev loop that cannot be exercised for real.
   */
  reloadExtension?: () => void;
}

export interface Worker {
  /** Registers one connected side panel. */
  connect(port: BrowserPort): void;
  /** Number of panels currently connected. */
  readonly panelCount: number;
  /** Drops the host subscription. Panels close with their ports. */
  dispose(): void;
}

type PanelChannel = Channel<unknown, HubOutbound | WorkerToPanel[keyof WorkerToPanel]>;

const PANEL_TYPES: ReadonlySet<string> = new Set<keyof PanelToWorker>([
  'run.start',
  'run.pause',
  'run.resume',
  'run.abort',
  'models.list',
  'readiness.get',
  'userscript.run',
  'userscript.list',
  'userscript.save',
  'userscript.delete',
  'userscript.stop',
  'userscript.saveResult',
  'runlog.replay',
  'log.append',
]);

function asPanelMessage(envelope: Envelope<unknown>): PanelToWorkerMessage | undefined {
  if (!PANEL_TYPES.has(envelope.type)) return undefined;
  return { type: envelope.type, payload: envelope.payload } as PanelToWorkerMessage;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const OBSERVE_MODES: ReadonlySet<string> = new Set<ObserveMode>(['dom', 'pixels', 'both']);
const FIDELITIES: ReadonlySet<string> = new Set<InputFidelity>(['in-page', 'escalated']);

/**
 * Folds the dev trigger's free-form `options` over the stored config. Unknown
 * keys are ignored: the socket is a dev convenience, not a second config store.
 */
export function applyRunOptions(config: Config, options?: Record<string, unknown>): Config {
  if (!options) return config;
  const next: Config = { ...config };
  const observe = options.observe ?? options.navMode;
  if (typeof observe === 'string' && OBSERVE_MODES.has(observe)) next.observe = observe as ObserveMode;
  if (typeof options.inputFidelity === 'string' && FIDELITIES.has(options.inputFidelity)) {
    next.inputFidelity = options.inputFidelity as InputFidelity;
  }
  // A model id alone is ambiguous: the same id can exist on both gateways and behave
  // differently (meta/muse-spark-1.3-contributor 404s on OpenRouter, works on Kilo), so
  // the source is its own option rather than being encoded into the id.
  const sourceOf = (raw: unknown): ModelSource | undefined =>
    raw === 'kilo' || raw === 'openrouter' ? raw : undefined;
  const leaderSource = sourceOf(options.leaderModelSource);
  if (leaderSource) next.leaderModelSource = leaderSource;
  const followerSource = sourceOf(options.followerModelSource);
  if (followerSource) next.followerModelSource = followerSource;
  if (typeof options.leaderModel === 'string' && options.leaderModel) next.leaderModel = options.leaderModel;
  if (typeof options.followerModel === 'string' && options.followerModel) {
    next.followerModel = options.followerModel;
  }
  const interval = Number(options.planningInterval);
  if (Number.isInteger(interval) && interval > 0) next.planningInterval = interval;
  const maxSteps = Number(options.maxSteps);
  if (Number.isInteger(maxSteps) && maxSteps > 0) next.maxSteps = maxSteps;
  if (typeof options.readOnly === 'boolean') next.readOnly = options.readOnly;
  return next;
}

export function createWorker(deps: WorkerDeps): Worker {
  const now = deps.now ?? Date.now;
  const handleUserscript = deps.handleUserscript ?? defaultHandleUserscript;
  const cacheMs = deps.modelsCacheMs ?? MODELS_CACHE_MS;
  const panels = new Set<PanelChannel>();
  let modelsCache: { at: number; models: ModelInfo[] } | undefined;
  // Each panel saves its own last result. One shared slot let a second panel's run
  // replace the value between the first panel's Run and its Save JSON.
  const panelUserscriptValues = new WeakMap<PanelChannel, unknown>();

  const broadcast = <K extends keyof WorkerToPanel>(type: K, payload: WorkerToPanel[K]): void => {
    for (const channel of [...panels]) channel.send(type, payload);
  };

  const reply = (channel: PanelChannel, message: WorkerToPanelMessage): void => {
    channel.send(message.type, message.payload);
  };

  // R-07: every event of every run reaches every open panel.
  const unsubscribeRuns = deps.runManager.onEvent((runId, event) => {
    broadcast('run.event', { runId, event });
  });

  async function models(): Promise<WorkerToPanel['models.list']> {
    if (modelsCache && now() - modelsCache.at < cacheMs) return { models: modelsCache.models };
    try {
      const list = await deps.host.listModels();
      modelsCache = { at: now(), models: list };
      return { models: list };
    } catch (error) {
      return { error: describe(error) };
    }
  }

  async function readiness(): Promise<Readiness> {
    try {
      const status = await deps.host.keyStatus();
      if (status.hostConnected) return status;
      return {
        hostConnected: false,
        keyReady: false,
        reason: status.reason ? `${HOST_UNREACHABLE_REASON} (${status.reason})` : HOST_UNREACHABLE_REASON,
      };
    } catch (error) {
      return {
        hostConnected: false,
        keyReady: false,
        reason: `${HOST_UNREACHABLE_REASON} (${describe(error)})`,
      };
    }
  }

  async function handlePanelMessage(channel: PanelChannel, message: PanelToWorkerMessage): Promise<void> {
    switch (message.type) {
      case 'run.start': {
        const { prompt, config } = message.payload;
        await deps.runManager.start({ prompt, config, followerVision: message.payload.followerVision });
        return;
      }
      case 'run.pause':
        deps.runManager.pause(message.payload.runId);
        return;
      case 'run.resume':
        deps.runManager.resume(message.payload.runId);
        return;
      case 'run.abort':
        deps.runManager.abort(message.payload.runId);
        return;
      case 'models.list':
        reply(channel, { type: 'models.list', payload: await models() });
        return;
      case 'readiness.get':
        reply(channel, { type: 'readiness', payload: await readiness() });
        return;
      case 'runlog.replay': {
        const { runId } = message.payload;
        // After a service-worker restart the buffer lives only in the durable
        // store (M6): restore first so the reopened panel replays the partial
        // log instead of an empty one.
        await deps.runManager.restoreReplay(runId);
        reply(channel, { type: 'runlog.replay', payload: { runId, events: deps.runManager.replay(runId) } });
        return;
      }
      case 'log.append':
        // The panel has no native port; the worker is its only route to ext.log.
        deps.host.appendLog(message.payload);
        return;
      case 'userscript.stop': {
        const tabId = await deps.runManager.resolveTabId();
        if (tabId === undefined) {
          reply(channel, { type: 'error', payload: { message: 'no target tab', inReplyTo: 'userscript.stop' } });
          return;
        }
        await signalUserscriptStop(tabId);
        return;
      }
      case 'userscript.saveResult': {
        if (!panelUserscriptValues.has(channel)) {
          reply(channel, {
            type: 'error',
            payload: { message: 'no userscript result to save', inReplyTo: 'userscript.saveResult' },
          });
          return;
        }
        if (!deps.host.saveArtifact) {
          reply(channel, {
            type: 'error',
            payload: { message: 'the host cannot save a file', inReplyTo: 'userscript.saveResult' },
          });
          return;
        }
        const packed = userscriptArtifactBody(panelUserscriptValues.get(channel));
        const filename = message.payload.filename || 'userscript.json';
        const artifact = await deps.host.saveArtifact('panel', filename, packed.body);
        reply(channel, {
          type: 'userscript.saved',
          payload: {
            filename,
            path: artifact.path,
            bytes: artifact.bytes,
            ...(packed.droppedRows ? { note: 'rows exceeded 8 MiB and were left out; summary and log were saved' } : {}),
          },
        });
        return;
      }
      case 'userscript.run':
      case 'userscript.list':
      case 'userscript.save':
      case 'userscript.delete': {
        const activeRunId = deps.runManager.activeRunId;
        const result = await handleUserscript(message, {
          resolveTabId: () => deps.runManager.resolveTabId(),
          // A userscript run during a live run belongs in that run's log (R-07/R-09).
          ...(activeRunId
            ? { emit: (event: RunEvent) => broadcast('run.event', { runId: activeRunId, event }) }
            : {}),
        });
        if (result?.type === 'userscript.result' && result.payload.value !== undefined) {
          panelUserscriptValues.set(channel, result.payload.value);
          if (activeRunId) {
            void sessionUserscriptValueStore(activeRunId)
              ?.save(result.payload.value)
              .catch((error: unknown) => {
                console.warn('[nanobrowser] could not persist the panel userscript value', error);
              });
          }
        }
        if (result) reply(channel, result);
        return;
      }
    }
  }

  function connect(port: BrowserPort): void {
    const channel: PanelChannel = createChannel<unknown, HubOutbound | WorkerToPanel[keyof WorkerToPanel]>(port);
    panels.add(channel);
    channel.onClose(() => panels.delete(channel));

    channel.onMessage((envelope) => {
      // Defensive: `Envelope` is a compile-time-only contract (no runtime
      // schema anywhere on this path — see docs/test-review.md), so a peer
      // that sends `null`/non-object garbage must not throw here.
      if (envelope === null || typeof envelope !== 'object') return;
      if (envelope.type === HUB_MESSAGE) {
        const payload = envelope.payload as HubInbound;
        if (payload?.kind === 'ping') channel.send(HUB_MESSAGE, { kind: 'pong', at: now() });
        return;
      }
      const message = asPanelMessage(envelope);
      if (!message) return;
      void handlePanelMessage(channel, message).catch((error: unknown) => {
        channel.send('error', { message: describe(error), inReplyTo: message.type });
      });
    });

    channel.send(HUB_MESSAGE, {
      kind: 'hello',
      extensionVersion: deps.extensionVersion ?? '0.0.0',
    });
  }

  /**
   * The dev trigger (docs/host-protocol.md): the host pushes `run.start` and
   * streams the run back to a unix-socket client. That client is closed by a
   * run-log event whose `type` is `run.end`, which is not a contract event —
   * hence the explicit terminator here.
   */
  async function devRun(msg: DevRunStart): Promise<void> {
    const end = (status: HostRunEndEvent['status'], message: string, steps: number): void => {
      deps.host.appendRunLog(msg.runId, {
        type: 'run.end',
        runId: msg.runId,
        status,
        message,
        steps,
        at: now(),
      });
    };

    let config: Config;
    try {
      config = applyRunOptions(await deps.getConfig(), msg.options);
    } catch (error) {
      end('error', `could not read the stored config: ${describe(error)}`, 0);
      return;
    }

    if (msg.url) {
      try {
        await deps.runManager.navigateActiveTab(msg.url);
      } catch (error) {
        end('error', `could not open ${msg.url}: ${describe(error)}`, 0);
        return;
      }
    }

    try {
      // nb-run sends no vision metadata, so followerVision stays unknown (allowed):
      // the pixels/text-only refusal only fires on the panel path, which looks the
      // follower up in its fetched catalog. A dev-trigger vision option is future work.
      const { done } = await deps.runManager.start({ prompt: msg.prompt, config, runId: msg.runId });
      const ended = await done;
      end(ended.status, ended.message, ended.steps);
    } catch (error) {
      end('error', describe(error), 0);
    }
  }

  const unsubscribeHost = deps.host.onRunStart((msg) => {
    void devRun(msg);
  });

  // Regression: closing the CLI client that started a dev run did not stop it -- nothing
  // told the extension to. `cancel` on the dev socket now pushes this instead.
  const unsubscribeAbort = deps.host.onRunAbort((msg) => {
    const matched = deps.runManager.abort(msg.runId);
    deps.host.appendLog({
      level: matched ? 'info' : 'warn',
      source: 'worker',
      message: matched
        ? `run.abort matched active run ${msg.runId}`
        : `run.abort for ${msg.runId} found no matching active run (active: ${deps.runManager.activeRunId ?? 'none'})`,
      at: now(),
    });
  });

  /**
   * The host-pushed self-reload. This tears the service worker down mid-call, so nothing
   * after it runs -- which is also why the host answers its socket client before pushing.
   */
  const unsubscribeReload = deps.host.onExtReload(() => {
    const reload = deps.reloadExtension ?? (() => chrome.runtime.reload());
    try {
      reload();
    } catch (error) {
      deps.host.appendLog({
        level: 'error',
        source: 'worker',
        message: `ext.reload failed: ${describe(error)}`,
        at: now(),
      });
    }
  });

  // A restart mid-run must terminate the run even when no panel ever reopens:
  // restore the last watched run once, so an unattended dev/CLI run gets its
  // clean terminal event and nb-run its run.end instead of hanging. Best effort;
  // a missing id or store simply means there is nothing to restore.
  if (deps.getLastRunId) {
    const getLastRunId = deps.getLastRunId;
    void getLastRunId()
      .then((runId) => (runId ? deps.runManager.restoreReplay(runId) : undefined))
      .catch((error: unknown) => {
        console.warn('[nanobrowser] could not restore the last run at startup', error);
      });
  }

  return {
    connect,
    get panelCount() {
      return panels.size;
    },
    dispose() {
      unsubscribeRuns();
      unsubscribeHost();
      unsubscribeAbort();
      unsubscribeReload();
    },
  };
}
