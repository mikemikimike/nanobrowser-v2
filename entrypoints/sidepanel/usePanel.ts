import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  ChromePort,
  createChannel,
  HUB_MESSAGE,
  SIDEPANEL_PORT,
  type Channel,
  type Envelope,
  type ModelInfo,
  type PanelToWorker,
  type Readiness,
  type RunId,
  type Userscript,
  type UserscriptRunResult,
  type WorkerToPanel,
  type HubInbound,
  type HubOutbound,
} from '@/src/messaging';
import { installErrorForwarding } from '@/src/runtime';
import type { Config } from '@/src/storage';
import { getLastRunId, setLastRunId } from '@/src/ui/state/lastRun';
import { initialRunLogState, runLogReducer, type RunLogState } from '@/src/ui/state/runlog';
import type { AreaStatus } from '@/src/ui/state/status';

export type HubStatus = 'connecting' | 'connected' | 'disconnected';

export interface HubState {
  status: HubStatus;
  extensionVersion?: string;
  lastPongAt?: number;
}

export type { AreaStatus };

export interface PanelApi {
  hub: HubState;
  /** True once the worker has been silent on the contract for longer than {@link SILENCE_MS}. */
  workerSilent: boolean;
  workerError?: string;

  models: ModelInfo[];
  modelsStatus: AreaStatus;
  modelsError?: string;

  readiness?: Readiness;
  readinessStatus: AreaStatus;

  scripts: Userscript[];
  scriptsStatus: AreaStatus;
  scriptResult?: UserscriptRunResult;
  scriptRunStatus: AreaStatus;
  /** Where Save JSON wrote the last result, once the host confirms it. */
  scriptSaved?: WorkerToPanel['userscript.saved'];

  log: RunLogState;
  /** True between sending `run.start` and the worker's first event for that run. */
  starting: boolean;

  refreshModels: () => void;
  refreshReadiness: () => void;
  refreshScripts: () => void;
  startRun: (prompt: string, config: Config) => void;
  pauseRun: () => void;
  resumeRun: () => void;
  abortRun: () => void;
  saveScript: (script: Userscript) => void;
  runScript: (scriptId: string, code: string) => void;
  stopScript: () => void;
  saveScriptResult: (value: unknown) => void;
  deleteScript: (id: string) => void;
}

const HEARTBEAT_MS = 5_000;
const SILENCE_MS = 4_000;

const WORKER_TYPES: ReadonlySet<string> = new Set<keyof WorkerToPanel>([
  'run.event',
  'models.list',
  'readiness',
  'userscript.result',
  'userscript.list',
  'userscript.saved',
  'runlog.replay',
  'error',
]);

type WorkerMessage = { [K in keyof WorkerToPanel]: { type: K; payload: WorkerToPanel[K] } }[keyof WorkerToPanel];

/** Narrows a raw envelope to a contract message. Anything unrecognised is dropped, never thrown on. */
function asWorkerMessage(envelope: Envelope<unknown>): WorkerMessage | undefined {
  if (!WORKER_TYPES.has(envelope.type)) return undefined;
  return { type: envelope.type, payload: envelope.payload } as WorkerMessage;
}

type PanelChannel = Channel<HubOutbound | WorkerToPanel[keyof WorkerToPanel], HubInbound | PanelToWorker[keyof PanelToWorker]>;

/**
 * The configured Follower's catalog vision flag, if the fetched catalog names it.
 * Same id on both gateways prefers the configured source (or openrouter, the run's
 * default, when no source is configured). A source mismatch is unknown, not a
 * fallback: with a partial catalog the surviving gateway's flag describes a model
 * the run is not routed to.
 */
export function followerVisionFor(models: ModelInfo[], config: Config): boolean | undefined {
  const candidates = models.filter((m) => m.id === config.followerModel);
  const wantSource = config.followerModelSource ?? 'openrouter';
  const follower = candidates.find((m) => m.source === wantSource) ?? candidates[0];
  if (!follower) return undefined;
  if (follower.source !== undefined && follower.source !== wantSource) return undefined;
  return follower.vision;
}

/**
 * The panel's single long-lived connection to the service worker. One port carries both
 * the scaffold's hub heartbeat (the hello/pong indicator) and the whole message contract,
 * so a broadcast run event is never delivered to the same panel twice.
 */
export function usePanel(): PanelApi {
  const channelRef = useRef<PanelChannel | null>(null);
  const runIdRef = useRef<RunId | undefined>(undefined);

  const [hub, setHub] = useState<HubState>({ status: 'connecting' });
  const [workerSilent, setWorkerSilent] = useState(false);
  const [workerError, setWorkerError] = useState<string | undefined>(undefined);

  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsStatus, setModelsStatus] = useState<AreaStatus>('idle');
  const [modelsError, setModelsError] = useState<string | undefined>(undefined);

  const [readiness, setReadiness] = useState<Readiness | undefined>(undefined);
  const [readinessStatus, setReadinessStatus] = useState<AreaStatus>('idle');

  const [scripts, setScripts] = useState<Userscript[]>([]);
  const [scriptsStatus, setScriptsStatus] = useState<AreaStatus>('idle');
  const [scriptResult, setScriptResult] = useState<UserscriptRunResult | undefined>(undefined);
  const [scriptRunStatus, setScriptRunStatus] = useState<AreaStatus>('idle');
  const [scriptSaved, setScriptSaved] = useState<WorkerToPanel['userscript.saved'] | undefined>(undefined);

  const [log, dispatch] = useReducer(runLogReducer, initialRunLogState);
  const [starting, setStarting] = useState(false);
  runIdRef.current = log.runId;

  const send = useCallback(<K extends keyof PanelToWorker>(type: K, payload: PanelToWorker[K]) => {
    channelRef.current?.send(type, payload);
  }, []);

  useEffect(() => {
    let channel: PanelChannel | null = null;
    try {
      channel = createChannel(new ChromePort(chrome.runtime.connect({ name: SIDEPANEL_PORT })));
    } catch (error) {
      // No worker to talk to (reloading extension, or a non-extension host). Degrade, don't crash.
      setHub({ status: 'disconnected' });
      setWorkerError(error instanceof Error ? error.message : String(error));
      return;
    }
    channelRef.current = channel;

    // The panel has no native port of its own, so its errors ride the worker channel to
    // the host's ext.log (docs/host-protocol.md). Without this a panel exception is
    // invisible to an unattended run.
    const uninstallErrorForwarding = installErrorForwarding({
      source: 'panel',
      target: window,
      console,
      send: (entry) => channelRef.current?.send('log.append', entry),
    });

    const silenceTimer = setTimeout(() => setWorkerSilent(true), SILENCE_MS);
    const seenWorker = () => {
      clearTimeout(silenceTimer);
      setWorkerSilent(false);
    };

    channel.onMessage((envelope) => {
      if (envelope.type === HUB_MESSAGE) {
        const payload = envelope.payload as HubOutbound;
        if (payload.kind === 'hello') {
          setHub({ status: 'connected', extensionVersion: payload.extensionVersion });
        } else {
          setHub((prev) => ({ ...prev, status: 'connected', lastPongAt: payload.at }));
        }
        return;
      }

      const message = asWorkerMessage(envelope);
      if (!message) return;
      seenWorker();

      switch (message.type) {
        case 'run.event': {
          const { runId, event } = message.payload;
          if (runIdRef.current !== runId) void setLastRunId(runId);
          setStarting(false);
          dispatch({ type: 'event', runId, event });
          return;
        }
        case 'runlog.replay':
          dispatch({ type: 'replay', runId: message.payload.runId, events: message.payload.events });
          return;
        case 'models.list':
          if ('error' in message.payload) {
            setModelsStatus('error');
            setModelsError(message.payload.error);
          } else {
            setModels(message.payload.models);
            setModelsStatus('ready');
            setModelsError(undefined);
          }
          return;
        case 'readiness':
          setReadiness(message.payload);
          setReadinessStatus('ready');
          return;
        case 'userscript.list':
          setScripts(message.payload.scripts);
          setScriptsStatus('ready');
          return;
        case 'userscript.result':
          setScriptResult(message.payload);
          setScriptRunStatus('ready');
          return;
        case 'userscript.saved':
          setScriptSaved(message.payload);
          return;
        case 'error':
          setWorkerError(message.payload.message);
          return;
      }
    });

    channel.onClose(() => setHub((prev) => ({ ...prev, status: 'disconnected' })));

    const heartbeat = setInterval(() => {
      channel?.send(HUB_MESSAGE, { kind: 'ping', at: Date.now() });
    }, HEARTBEAT_MS);

    // Opening shot: ask for everything the panel needs, and re-attach to a run that was
    // already in flight when the panel was last closed (R-07).
    channel.send('models.list', {});
    setModelsStatus('waiting');
    channel.send('readiness.get', {});
    setReadinessStatus('waiting');
    channel.send('userscript.list', {});
    setScriptsStatus('waiting');

    void getLastRunId()
      .then((runId) => {
        if (!runId || !channelRef.current) return;
        dispatch({ type: 'run', runId });
        channelRef.current.send('runlog.replay', { runId });
      })
      .catch(() => undefined);

    return () => {
      clearTimeout(silenceTimer);
      clearInterval(heartbeat);
      uninstallErrorForwarding();
      channelRef.current = null;
      channel?.close();
    };
  }, []);

  const refreshModels = useCallback(() => {
    setModelsStatus('waiting');
    setModelsError(undefined);
    send('models.list', {});
  }, [send]);

  const refreshReadiness = useCallback(() => {
    setReadinessStatus('waiting');
    send('readiness.get', {});
  }, [send]);

  const refreshScripts = useCallback(() => {
    setScriptsStatus('waiting');
    send('userscript.list', {});
  }, [send]);

  const startRun = useCallback(
    (prompt: string, config: Config) => {
      dispatch({ type: 'clear' });
      setWorkerError(undefined);
      setStarting(true);
      // The worker refuses pixels/both for a known text-only Follower (M5 closes
      // O-06); the catalog vision flag rides along so the guard can fire. Unknown
      // (model absent from the fetched catalog) stays omitted, which refuses nothing.
      const followerVision = followerVisionFor(models, config);
      send('run.start', { prompt, config, ...(followerVision === undefined ? {} : { followerVision }) });
    },
    [send, models],
  );

  const withRunId = useCallback(
    (type: 'run.pause' | 'run.resume' | 'run.abort') => {
      const runId = runIdRef.current;
      if (!runId) return;
      send(type, { runId });
    },
    [send],
  );

  return {
    hub,
    workerSilent,
    workerError,
    models,
    modelsStatus,
    modelsError,
    readiness,
    readinessStatus,
    scripts,
    scriptsStatus,
    scriptResult,
    scriptRunStatus,
    scriptSaved,
    log,
    starting,
    refreshModels,
    refreshReadiness,
    refreshScripts,
    startRun,
    pauseRun: useCallback(() => withRunId('run.pause'), [withRunId]),
    resumeRun: useCallback(() => withRunId('run.resume'), [withRunId]),
    abortRun: useCallback(() => withRunId('run.abort'), [withRunId]),
    saveScript: useCallback(
      (script: Userscript) => {
        send('userscript.save', script);
        setScriptsStatus('waiting');
        send('userscript.list', {});
      },
      [send],
    ),
    runScript: useCallback(
      (scriptId: string, code: string) => {
        setScriptResult(undefined);
        setScriptSaved(undefined);
        setScriptRunStatus('waiting');
        send('userscript.run', { scriptId, code });
      },
      [send],
    ),
    stopScript: useCallback(() => {
      send('userscript.stop', {});
    }, [send]),
    saveScriptResult: useCallback(
      (value: unknown) => {
        // The worker already holds this object from the run. The argument is what
        // the panel test asserts; the message does not carry the body.
        void value;
        send('userscript.saveResult', { filename: 'userscript.json' });
      },
      [send],
    ),
    deleteScript: useCallback(
      (id: string) => {
        send('userscript.delete', { id });
        setScriptsStatus('waiting');
        send('userscript.list', {});
      },
      [send],
    ),
  };
}
