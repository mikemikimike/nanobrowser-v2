/**
 * Graph state and run context.
 *
 * `StateSchema` + zod, per `docs/research/langgraph.md` §1 — `Annotation.Root`,
 * `StateGraphArgs` channels and `stateSchema:` are all deprecated (C-03).
 *
 * The Leader and the Follower keep SEPARATE message histories. They are two
 * roles with two models, two system prompts and two vocabularies (R-03); a
 * shared transcript would leak every DOM snapshot into the planner's context and
 * every plan revision into the navigator's.
 *
 * Anything that is fixed for the whole run — `planningInterval`, `maxSteps`,
 * `observe`, the model handles, the page port — lives in the run *context*, not
 * in state, so no node can corrupt it and none of it is checkpointed.
 */
import * as z from 'zod';
import { ReducedValue, StateSchema, messagesStateReducer } from '@langchain/langgraph/web';
import type { BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ObserveMode } from '@/src/storage';
import { FollowerSignalSchema, type PageTools, type PageToolset } from './tools';

/** Terminal states the graph itself can reach. `aborted` is owned by `run.ts`. */
export const RunStatusSchema = z.enum(['running', 'done', 'blocked', 'max-steps', 'error']);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/**
 * One chat history channel, shaped exactly like langgraph's own `MessagesValue`
 * but instantiated per role so the two histories never share a channel.
 */
function messageHistory(): ReducedValue<BaseMessage[], unknown> {
  return new ReducedValue<BaseMessage[], unknown>(
    z.custom<BaseMessage[]>().default(() => []),
    {
      inputSchema: z.custom<unknown>(),
      reducer: (current, next) =>
        messagesStateReducer(
          current as never,
          next as never,
        ),
      jsonSchemaExtra: { langgraph_type: 'messages' },
    },
  );
}

export const AgentState = new StateSchema({
  /** The planner's own transcript. Sees the page only through its capped read tools. */
  leaderMessages: messageHistory(),
  /** The navigator's own transcript. Holds observations and tool results. */
  followerMessages: messageHistory(),
  /** Free-text plan, as written by the Leader (R-07 shows it in the log). */
  plan: z.string().default(''),
  /** Ordered subgoals the plan decomposes into. */
  subgoals: z.array(z.string()).default(() => []),
  /** Zero-based index into `subgoals` of the one the Follower is working on. */
  currentSubgoal: z.number().int().min(0).default(0),
  /** Follower action steps taken. Never reset — this is the R-04 safety valve's counter. */
  stepCount: z.number().int().min(0).default(0),
  /** Follower action steps since the last Leader turn. Reset by the Leader (R-04). */
  stepsSinceReplan: z.number().int().min(0).default(0),
  /** The Follower's most recent self-classification (R-03). */
  /**
   * Consecutive Follower turns that produced no tool call at all.
   *
   * A model that answers in prose instead of calling a tool hands control back,
   * the Leader replans, and nothing changes -- a live run on the free Nemotron
   * pair burned 18 steps this way without touching the page once. Counted so the
   * graph can stop and say so rather than spending the whole step budget.
   */
  idleFollowerTurns: z.number().int().min(0).default(0),
  /**
   * Key of the most recent failed action (`name`, stable args, normalized error).
   * Null when the last page-changing action succeeded or no action has failed yet.
   */
  repeatFailureKey: z.string().nullable().default(null),
  /**
   * Consecutive failures of `repeatFailureKey`.
   *
   * A model retrying a deterministically failing action burns the whole step budget
   * reporting `max-steps` (seen live: the same refused `run_userscript` call retried
   * verbatim, with prose turns in between, to exhaustion). Counted so the graph can
   * stop and name the loop instead. Successful page reads do not reset this — looking
   * at an unchanged page is not new information — but any successful page-changing
   * action does.
   */
  repeatFailureTurns: z.number().int().min(0).default(0),
  lastSignal: FollowerSignalSchema.nullable().default(null),
  status: RunStatusSchema.default('running'),
  /**
   * Why an errored run stopped, in the run card's own words. Set alongside the
   * error status (idle stall, repeat loop) so `run.ended.message` names the
   * reason instead of the generic mapping. Null for every other outcome.
   */
  endNote: z.string().nullable().default(null),
});

export type AgentStateValue = typeof AgentState.State;
export type AgentStateUpdate = typeof AgentState.Update;

/**
 * Static per-run context. Model handles and the page port are passed as opaque
 * values: they are behaviour, not data, and must never reach a checkpoint.
 */
export const AgentContextSchema = z.object({
  /** The user's objective, verbatim. */
  objective: z.string(),
  /** R-04: deterministic Leader cadence, in Follower steps. */
  planningInterval: z.number().int().min(1),
  /** R-04: safety valve, not the normal handoff. */
  maxSteps: z.number().int().min(1),
  /** R-08: the user's choice in the side panel. */
  observe: z.custom<ObserveMode>(),
  /** M9 #13: read-only runs bind no acting tools and refuse them in depth. */
  readOnly: z.boolean().default(false),
  leaderModel: z.custom<BaseChatModel>(),
  followerModel: z.custom<BaseChatModel>(),
  toolset: z.custom<PageToolset>(),
  page: z.custom<PageTools>(),
  /** Stored userscripts whose match pattern fits the run's tab (R-09), so the
   *  Follower knows what id(s) `run_userscript` may take. */
  availableUserscripts: z.array(z.object({ id: z.string(), name: z.string() })).default(() => []),
  /** Re-reads the tab URL each Follower step so navigate updates the list. */
  refreshUserscripts: z.custom<() => Promise<Array<{ id: string; name: string }>>>().optional(),
});

export type AgentContext = z.infer<typeof AgentContextSchema>;
