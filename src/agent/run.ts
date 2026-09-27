/**
 * Run driver: owns the thread, the event stream, and the pause/resume/abort
 * surface the side panel drives (R-05).
 *
 * Pause is `RunControl.requestDrain()`, not `interrupt()` — `interrupt()` needs
 * AsyncLocalStorage and throws in MV3 (docs/research/langgraph.md §4). Drain
 * stops at the next superstep boundary, the checkpoint is already durable
 * (`durability: "sync"`), and resume is `invoke(null, cfg)` on the same
 * `thread_id`. Abort is an `AbortSignal` on `config.signal`.
 *
 * Every event the graph writes is forwarded verbatim; this module adds only the
 * four lifecycle events the graph cannot know about.
 */
import { RunControl, isGraphDrained } from '@langchain/langgraph/web';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { Config } from '@/src/storage';
import type { RunEvent, RunId } from '@/src/messaging/contract';
import { buildAgentGraph } from './graph';
import { IndexedDBSaver } from './checkpointer';
import { createPageToolset, type PageTools } from './tools';
import type { RunStatus } from './state';

export type RunEndedEvent = Extract<RunEvent, { kind: 'run.ended' }>;

export interface RunModels {
  leader: BaseChatModel;
  follower: BaseChatModel;
}

export interface StartRunOptions {
  /** The user's objective, verbatim. */
  prompt: string;
  /** The user's side-panel configuration (R-05/R-08/R-11). */
  config: Config;
  tools: PageTools;
  models: RunModels;
  onEvent: (event: RunEvent) => void;
  /** Host abort, e.g. the worker shutting down. Merged with `abort()`. */
  signal?: AbortSignal;
  /** Defaults to a fresh {@link IndexedDBSaver}. */
  checkpointer?: BaseCheckpointSaver;
  /** Also used as the checkpointer `thread_id`. */
  runId?: RunId;
  tabId?: number;
  url?: string;
  /** Stored userscripts whose match pattern fits this tab (R-09). Default none. */
  availableUserscripts?: Array<{ id: string; name: string }>;
  /** Re-reads the tab URL so a navigate changes which scripts the prompt lists. */
  refreshUserscripts?: () => Promise<Array<{ id: string; name: string }>>;
}

export interface RunHandle {
  runId: RunId;
  /** Requests a drain; the run stops at the next step boundary and emits `run.paused`. */
  pause(): void;
  /** Resumes from the checkpoint on the same thread and emits `run.resumed`. */
  resume(): void;
  abort(): void;
  done: Promise<RunEndedEvent>;
}

const ENDED_MESSAGE: Record<RunEndedEvent['status'], string> = {
  done: 'objective complete',
  aborted: 'aborted by the user',
  blocked: 'the follower is blocked',
  'max-steps': 'step budget reached',
  error: 'run failed',
};

function toEndedStatus(status: RunStatus): RunEndedEvent['status'] {
  switch (status) {
    case 'done':
      return 'done';
    case 'blocked':
      return 'blocked';
    case 'max-steps':
      return 'max-steps';
    default:
      return 'error';
  }
}

export function startRun(options: StartRunOptions): RunHandle {
  const {
    prompt,
    config,
    tools,
    models,
    onEvent,
    signal: hostSignal,
    checkpointer = new IndexedDBSaver(),
    runId = crypto.randomUUID(),
    tabId = -1,
    url = '',
    availableUserscripts = [],
    refreshUserscripts,
  } = options;

  const graph = buildAgentGraph(checkpointer);
  const context = {
    objective: prompt,
    planningInterval: config.planningInterval,
    maxSteps: config.maxSteps,
    observe: config.observe,
    readOnly: config.readOnly ?? false,
    leaderModel: models.leader,
    followerModel: models.follower,
    toolset: createPageToolset(tools, { readOnly: config.readOnly ?? false }),
    page: tools,
    availableUserscripts,
    refreshUserscripts: refreshUserscripts ?? (async () => availableUserscripts),
  };

  const controller = new AbortController();
  const onHostAbort = () => controller.abort(hostSignal?.reason);
  if (hostSignal) {
    if (hostSignal.aborted) controller.abort(hostSignal.reason);
    else hostSignal.addEventListener('abort', onHostAbort, { once: true });
  }

  let control = new RunControl();
  let releasePause: (() => void) | undefined;
  let finished = false;

  const emit = (event: RunEvent) => onEvent(event);

  const configurable = { thread_id: runId };
  const runConfig = () => ({
    configurable,
    context,
    streamMode: 'custom' as const,
    durability: 'sync' as const,
    control,
    signal: controller.signal,
    // Two nodes can run per follower step, plus the leader turns between them.
    recursionLimit: config.maxSteps * 3 + 10,
  });

  async function drive(): Promise<RunEndedEvent> {
    emit({ kind: 'run.started', runId, prompt, config, tabId, url, at: Date.now() });

    let input: Record<string, unknown> | null = { status: 'running' };
    let ended: RunEndedEvent | undefined;

    for (;;) {
      control = new RunControl();
      try {
        for await (const chunk of await graph.stream(input, runConfig())) {
          emit(chunk as RunEvent);
        }
        break;
      } catch (error) {
        if (controller.signal.aborted) {
          ended = {
            kind: 'run.ended',
            status: 'aborted',
            message: ENDED_MESSAGE.aborted,
            steps: await stepsSoFar(),
            at: Date.now(),
          };
          break;
        }
        if (isGraphDrained(error)) {
          // Arm the gate before announcing the pause: a caller that calls
          // resume() synchronously from its onEvent handler must not deadlock.
          const gate = new Promise<void>((resolve) => {
            releasePause = resolve;
          });
          emit({ kind: 'run.paused', at: Date.now() });
          await gate;
          releasePause = undefined;
          if (controller.signal.aborted) {
            ended = {
              kind: 'run.ended',
              status: 'aborted',
              message: ENDED_MESSAGE.aborted,
              steps: await stepsSoFar(),
              at: Date.now(),
            };
            break;
          }
          emit({ kind: 'run.resumed', at: Date.now() });
          input = null;
          continue;
        }
        ended = {
          kind: 'run.ended',
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
          steps: await stepsSoFar(),
          at: Date.now(),
        };
        break;
      }
    }

    if (!ended) {
      const snapshot = await graph.getState({ configurable });
      const status = toEndedStatus((snapshot.values.status ?? 'error') as RunStatus);
      ended = {
        kind: 'run.ended',
        status,
        message: (snapshot.values.endNote as string | null) ?? ENDED_MESSAGE[status],
        steps: snapshot.values.stepCount ?? 0,
        at: Date.now(),
      };
    }

    finished = true;
    hostSignal?.removeEventListener('abort', onHostAbort);
    emit(ended);
    return ended;
  }

  async function stepsSoFar(): Promise<number> {
    try {
      const snapshot = await graph.getState({ configurable });
      return snapshot.values.stepCount ?? 0;
    } catch {
      return 0;
    }
  }

  const done = drive();

  return {
    runId,
    pause() {
      if (finished) return;
      control.requestDrain('user-pause');
    },
    resume() {
      releasePause?.();
    },
    abort() {
      if (finished) return;
      controller.abort(new Error('aborted by the user'));
      releasePause?.();
    },
    done,
  };
}
