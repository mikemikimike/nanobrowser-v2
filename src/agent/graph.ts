/**
 * The Leader/Follower graph (R-03, R-04, C-02).
 *
 * Two nodes, one conditional edge. The loop, the supersteps, the checkpointing
 * and the routing all come from LangGraph — nothing here re-implements them.
 *
 * - `leader` plans or re-plans, picks the current subgoal, emits `leader.plan`.
 * - `follower` observes per the user's `observe` mode (R-08), executes exactly
 *   ONE tool call, and classifies its own control signal from a field on that
 *   same tool call — one model round trip, no second classification call (R-03).
 * - `route` is deterministic: re-plan when `stepsSinceReplan >= planningInterval`
 *   or on `SUBGOAL_COMPLETE` / `RETURN_TO_LEADER`; end on `BLOCKED`, on `done`,
 *   or when `stepCount >= maxSteps` (R-04's safety valve).
 *
 * Every role change emits `handoff`; every tool call emits `tool.call` then
 * `tool.result` (R-06); every Follower action emits `step` (R-07).
 *
 * Imports come from `@langchain/langgraph/web` only. No `createReactAgent`, no
 * `interrupt()`, none of the APIs deprecated in 1.4.13 (C-03).
 */
import {
  END,
  START,
  StateGraph,
  type ConditionalEdgeRouter,
  type GraphNode,
  type LangGraphRunnableConfig,
} from '@langchain/langgraph/web';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
  type ContentBlock,
} from '@langchain/core/messages';
import type { FollowerSignal, Role, RunEvent } from '@/src/messaging/contract';
import { AgentContextSchema, AgentState, type AgentContext, type RunStatus } from './state';
import { FollowerSignalSchema, LEADER_READ_CAP, READ_TOOL_NAMES, TERMINAL_TOOLS, createLeaderReadTools, planTool, summarize, toolResultText } from './tools';

/**
 * How many past Follower turns (a human observation plus the model's reply) are
 * resent with each step.
 *
 * Every turn carries a full page observation, and on a 60-listing eBay page that
 * is ~17k tokens before any tool result. Unbounded, the history reached 285,351
 * tokens against a 262,144-token model and the run died with a 400. Older
 * observations are stale snapshots of a page that has since changed, so they are
 * not merely expensive, they are wrong to resend.
 */
export const FOLLOWER_HISTORY_TURNS = 3;

/**
 * Keeps the most recent turns of Follower history.
 *
 * Trims by turn, not by fixed message count: a turn is a human observation plus
 * everything the model emitted for it (one AI message plus its tool results,
 * including refused extras). Slicing a fixed count can keep tool results whose
 * assistant call was cut away, and OpenAI-compatible providers reject orphaned
 * tool messages — so the cut lands only on a human boundary, and any leading
 * tool messages left by the cut are dropped with it.
 */
export function trimFollowerHistory(
  messages: BaseMessage[],
  turns: number = FOLLOWER_HISTORY_TURNS,
): BaseMessage[] {
  const want = Math.max(turns, 1);
  let seen = 0;
  let cut = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] instanceof HumanMessage) {
      seen++;
      if (seen === want) cut = i;
    }
  }
  let kept = seen >= want ? messages.slice(cut) : messages.slice();
  while (kept.length > 0 && kept[0] instanceof ToolMessage) kept = kept.slice(1);
  return kept.length > 0 ? kept : messages.slice(-1);
}

/** Consecutive tool-call-less Follower turns before a run is called stalled. */
export const MAX_IDLE_FOLLOWER_TURNS = 4;

/** Identical failures of the same action before the run is called stuck. */
export const MAX_REPEAT_FAILURE_TURNS = 2;

/**
 * Identity of one failed attempt: the tool name, its visible arguments with stable
 * key order (the `signal`/`note` envelope is already stripped by the caller, so two
 * attempts that differ only in their control note still match), and the error with
 * durations normalized (timeouts and waits vary between identical failures).
 * Capped so a `save_file` with a huge payload cannot bloat checkpointed state; the
 * digest keeps truncated keys distinct when large payloads share a prefix and length.
 *
 * Only durations normalize: any other digit change (HTTP 429 vs 500, counts, ports)
 * is a different failure, and collapsing those would stop a run whose failure mode
 * changed. Missing a loop whose counts vary is the tolerable direction — that is
 * just the pre-detector behavior of burning budget, not a new false stop.
 */
export function actionKey(name: string, args: Record<string, unknown>, error: string): string {
  const sorted = Object.fromEntries(
    Object.entries(args).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  let json: string;
  try {
    json = JSON.stringify(sorted) ?? '';
  } catch {
    json = String(sorted);
  }
  if (json.length > 500) json = `${json.slice(0, 500)}…len=${json.length}#${hash32(json)}`;
  // Hash the full normalized error, not just its head: two failures sharing a
  // 200-char prefix (long userscript errors with a common console preamble) must
  // not read as one identical failure and stop a run whose failure changed.
  const failure = normalizeError(error);
  return `${name}\n${json}\n${failure.slice(0, 200)}#${hash32(failure)}`;
}

/** Durations (`12ms`, `3 s`, `1.5 minutes`) collapse; every other digit is significant. */
function normalizeError(error: string): string {
  return error.replace(/\d[\d,]*(?:\.\d+)?\s*(?:ms|s(?:ec(?:ond)?s?)?|m(?:in(?:ute)?s?)?|h(?:ours?)?|ns|µs|us)\b/gi, '#dur');
}

/** Short non-crypto digest (FNV-1a) for truncated failure keys. */
function hash32(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export const LEADER_SYSTEM = [
  'You are the Leader of a two-role browser agent. You do not touch the page.',
  'You decompose the objective into a short ordered list of concrete subgoals and hand one at a time to the Follower.',
  'You are called again whenever the Follower finishes a subgoal, gets stuck, or after a fixed number of its steps.',
  'When called again, revise the plan against what actually happened. Keep what worked. Do not repeat a subgoal that is already done.',
  'Before re-planning you may pull evidence with your read tools ' +
    '(at most 2 reads per turn) to check what actually happened.',
  'Pulling evidence is not acting: reads never change the page, and the Follower remains the only role that acts.',
  'The Follower can read long lists as plain text, write and run a script against the page, and save a file; it will call blocked rather than sign in anywhere, so never plan a subgoal that requires logging in.',
  'Always answer by calling set_plan exactly once. Never write prose instead.',
].join(' ');

export const FOLLOWER_SYSTEM = [
  'You control a web browser to accomplish one subgoal at a time.',
  'Each turn you call exactly ONE tool. Never more than one.',
  'Element refs like "e12" come from the page snapshot you are shown. Never invent a ref.',
  'For a long list or article, prefer extract_text over reading it out of the snapshot.',
  'Read a userscript with read_userscript before you change it. run_userscript takes an id and optional args.',
  'A run_userscript result can be saved with save_file(fromLastUserscript:true) instead of retyping it; saved files land in the user\'s Downloads/nanobrowser folder.',
  'When a page holds more data than you can reach by clicking, write_userscript a small reader for it, run_userscript it, and fix it from the error and console lines you get back.',
  'If you land on a sign-in or login page, call blocked; never enter credentials.',
  'On every tool call also set "signal": CONTINUE while you are still working on the subgoal,',
  'SUBGOAL_COMPLETE the moment the subgoal is achieved, RETURN_TO_LEADER if the plan no longer fits',
  'what you see, BLOCKED if you truly cannot proceed. Add a short "note" saying why.',
  'Call done only when the whole objective is achieved. Call blocked only when nothing else can work.',
].join(' ');

type Emitter = LangGraphRunnableConfig<AgentContext>;

function emit(config: Emitter, event: RunEvent): void {
  config.writer?.(event);
}

function now(): number {
  return Date.now();
}

function requireContext(config: Emitter): AgentContext {
  const ctx = config.context;
  if (!ctx) throw new Error('agent graph invoked without a run context');
  return ctx;
}

function textOf(message: AIMessage): string {
  const { content } = message;
  if (typeof content === 'string') return content;
  return content
    .map((part) => (typeof part === 'string' ? part : part.type === 'text' ? part.text : ''))
    .join('')
    .trim();
}

function parseSignal(value: unknown): FollowerSignal | undefined {
  const parsed = FollowerSignalSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Answers every tool call past the first so the transcript stays valid:
 * OpenAI-compatible providers reject an assistant message whose call ids lack
 * results. Both roles act once per turn by design, so extras are refused with
 * an instruction to re-issue, never run.
 */
const EXTRA_CALL_REFUSAL =
  'only the first tool call per turn is answered; re-issue this call next turn if it still matters.';

function answerExtraCalls(
  config: Emitter,
  role: Role,
  extra: NonNullable<AIMessage['tool_calls']>,
  fallbackPrefix: string,
  messages: BaseMessage[],
): void {
  extra.forEach((call, i) => {
    const callId = call.id ?? `${fallbackPrefix}-extra-${i}`;
    const refusal = EXTRA_CALL_REFUSAL;
    emit(config, {
      kind: 'tool.call',
      role,
      call: { callId, name: call.name, args: (call.args ?? {}) as Record<string, unknown> },
      at: now(),
    });
    emit(config, {
      kind: 'tool.result',
      role,
      result: { callId, name: call.name, ok: false, summary: refusal, durationMs: 0 },
      at: now(),
    });
    messages.push(new ToolMessage({ tool_call_id: callId, name: call.name, content: refusal }));
  });
}

/* ------------------------------------------------------------------------- */
/* Routing                                                                    */
/* ------------------------------------------------------------------------- */

export type RouteTarget = 'leader' | 'follower' | typeof END;

export interface RouteDecision {
  to: RouteTarget;
  /** Human-readable cause, carried verbatim on the `handoff` event (R-07). */
  reason: string;
}

export interface RouteInputs {
  status: RunStatus;
  lastSignal: FollowerSignal | null;
  stepCount: number;
  stepsSinceReplan: number;
}

/**
 * The single source of truth for what happens after a Follower step.
 *
 * The Follower node calls it to name the handoff; the conditional edge calls it
 * to pick the node. Both see the same post-update state, so the emitted log and
 * the actual control flow cannot disagree.
 */
export function decideNext(
  s: RouteInputs,
  ctx: Pick<AgentContext, 'planningInterval' | 'maxSteps'>,
): RouteDecision {
  if (s.status === 'done') return { to: END, reason: 'objective complete' };
  if (s.status === 'error') return { to: END, reason: 'run failed' };
  if (s.status === 'blocked' || s.lastSignal === 'BLOCKED') {
    return { to: END, reason: 'follower is blocked' };
  }
  if (s.stepCount >= ctx.maxSteps) {
    return { to: END, reason: `step budget of ${ctx.maxSteps} reached` };
  }
  if (s.lastSignal === 'SUBGOAL_COMPLETE') return { to: 'leader', reason: 'subgoal complete' };
  if (s.lastSignal === 'RETURN_TO_LEADER') {
    return { to: 'leader', reason: 'follower returned control' };
  }
  if (s.stepsSinceReplan >= ctx.planningInterval) {
    return { to: 'leader', reason: `planning interval of ${ctx.planningInterval} steps reached` };
  }
  return { to: 'follower', reason: 'continue on the current subgoal' };
}

const route: ConditionalEdgeRouter<typeof AgentState, AgentContext, 'leader' | 'follower'> = (
  state,
  config,
) => {
  const ctx = requireContext(config);
  return decideNext(state, ctx).to;
};

/* ------------------------------------------------------------------------- */
/* Nodes                                                                      */
/* ------------------------------------------------------------------------- */

/**
 * Replaces a Leader screenshot's image block when the model cannot see images.
 * The note's presence in history also keeps screenshots barred on later turns:
 * the bar below only exists because a provider call already failed on pixels.
 */
const LEADER_NO_VISION_NOTE =
  'Leader screenshot requested, but this Leader cannot see images: plan from the text evidence.';

/** Whether a provider failure names images as the problem (vs a transient/transport error). */
function isVisionRejection(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /\bimages?\b|\bvision\b|\bmultimodal\b|\bpictures?\b|\bimage_url\b/i.test(text);
}

/** Index of the last message carrying an image block, or -1. */
function findLastImageMessage(messages: BaseMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i]!.content;
    if (Array.isArray(content) && content.some(isImageBlock)) return i;
  }
  return -1;
}

/** Whether a content block is an image payload (either spelling the codebase emits). */
function isImageBlock(block: unknown): boolean {
  if (typeof block === 'string') return false;
  const type = (block as { type?: unknown }).type;
  return type === 'image' || type === 'image_url';
}

/**
 * Persisted leader history keeps a screenshot's text but drops its pixels: history
 * appends every turn and every replan resends it all, so retained data URLs would
 * accumulate stale full images in context and checkpoint despite the per-turn cap.
 * Only the human observation blocks the leader node itself appended are rebuilt;
 * tool traffic (ids matter) passes through untouched.
 */
function stripImageBlocks(message: BaseMessage): BaseMessage {
  if (!(message instanceof HumanMessage) || !Array.isArray(message.content)) return message;
  if (!message.content.some(isImageBlock)) return message;
  const kept = message.content.filter((block) => !isImageBlock(block));
  return new HumanMessage({
    content:
      kept.length > 0 ? kept : '[earlier leader screenshot: pixels dropped from history]',
  });
}

const leader: GraphNode<typeof AgentState, AgentContext> = async (state, config) => {
  const ctx = requireContext(config);
  const replan = state.stepCount > 0;

  emit(config, { kind: 'step', n: state.stepCount, role: 'leader', at: now() });

  const situation = replan
    ? [
        `Objective: ${ctx.objective}`,
        `Steps used: ${state.stepCount} of ${ctx.maxSteps}.`,
        `Previous plan: ${state.plan || '(none)'}`,
        `Subgoals: ${state.subgoals.map((s, i) => `${i}. ${s}`).join(' | ') || '(none)'}`,
        `The follower was working on subgoal ${state.currentSubgoal} and signalled ${state.lastSignal ?? 'CONTINUE'}.`,
        'Revise the plan and pick the subgoal to work on next. Call set_plan.',
      ].join('\n')
    : [
        `Objective: ${ctx.objective}`,
        `The follower gets ${ctx.planningInterval} steps before you are consulted again, and ${ctx.maxSteps} steps in total.`,
        'Write the plan and its subgoals. Call set_plan.',
      ].join('\n');

  // The Leader's read-only observation subset (M4): evidence pulls, not actions.
  // Built from the same page port the Follower drives, filtered by the run's
  // observe mode, bound next to set_plan. The availability line keeps the model
  // from reaching for a read its mode withholds.
  const leaderReads = createLeaderReadTools(ctx.page, { observe: ctx.observe });
  const readByName = new Map(leaderReads.map((t) => [t.name, t]));
  const bound = ctx.leaderModel.bindTools?.([...leaderReads, planTool]) ?? ctx.leaderModel;
  const human = new HumanMessage(
    `${situation}\nEvidence reads available: ${leaderReads.map((t) => t.name).join(', ') || '(none)'}.` +
      (ctx.readOnly
        ? '\nRead-only mode is on: the Follower has no act tools (no click, hover, type, press, select, download, or write_userscript). Plan reads, navigation, read-only userscripts, and saving only — never a subgoal that needs an action.'
        : ''),
  );

  const messages: BaseMessage[] = [human];
  let plan = state.plan;
  let subgoals = state.subgoals;
  let currentSubgoal = state.currentSubgoal;
  let readsUsed = 0;
  let planned = false;
  let lastText = '';
  // A previous turn already proved this Leader cannot see images: keep the pixels
  // barred rather than spending another doomed provider call per replan.
  let screenshotsBarred = state.leaderMessages.some(
    (m) => typeof m.content === 'string' && m.content === LEADER_NO_VISION_NOTE,
  );

  // Pull evidence, then plan. Each lap is one model round trip; the loop is
  // bounded (reads plus room for the plan and one refusal) so a model that
  // only ever reads still ends its turn instead of becoming a second Follower.
  for (let lap = 0; lap < LEADER_READ_CAP + 2 && !planned; lap++) {
    let response: AIMessage;
    try {
      response = (await bound.invoke(
        [new SystemMessage(LEADER_SYSTEM), ...state.leaderMessages, ...messages],
        config,
      )) as AIMessage;
    } catch (error) {
      // A text-only Leader dies on the image block leader_screenshot appended: swap
      // the pixels for a note, bar further screenshots, and retry the lap. Only a
      // vision-specific rejection qualifies — timeouts, rate limits, and transport
      // errors propagate (and fail the run) exactly as before.
      const imgIdx = findLastImageMessage(messages);
      if (imgIdx === -1 || screenshotsBarred || !isVisionRejection(error)) throw error;
      screenshotsBarred = true;
      messages[imgIdx] = new HumanMessage(LEADER_NO_VISION_NOTE);
      continue;
    }
    messages.push(response);

    const text = textOf(response);
    if (text) {
      lastText = text;
      emit(config, { kind: 'model.text', role: 'leader', text, at: now() });
    }

    const calls = response.tool_calls ?? [];
    if (calls.length === 0) break;
    const [call, ...extras] = calls;
    // Every extra is answered after the first call is processed below, so the log
    // reads action-then-refusals and every emitted id still has its result.
    const answerExtras = (): void => {
      answerExtraCalls(config, 'leader', extras, `leader-${state.stepCount}-${lap}`, messages);
    };
    if (!call) break;
    const callId = call.id ?? `leader-${state.stepCount}-${lap}`;

    if (call.name === planTool.name) {
      emit(config, {
        kind: 'tool.call',
        role: 'leader',
        call: { callId, name: call.name, args: call.args },
        at: now(),
      });
      const started = now();
      let ok = true;
      let result: string;
      const args = call.args as { plan: string; subgoals: string[]; currentSubgoal?: number };
      try {
        result = toolResultText(await planTool.invoke(args, config));
        plan = args.plan ?? plan;
        subgoals = Array.isArray(args.subgoals) && args.subgoals.length ? args.subgoals : subgoals;
        const picked = typeof args.currentSubgoal === 'number' ? args.currentSubgoal : 0;
        currentSubgoal = Math.min(Math.max(picked, 0), Math.max(subgoals.length - 1, 0));
      } catch (error) {
        ok = false;
        result = toolResultText(error instanceof Error ? error.message : String(error));
      }
      emit(config, {
        kind: 'tool.result',
        role: 'leader',
        result: { callId, name: call.name, ok, summary: summarize(result), durationMs: now() - started },
        at: now(),
      });
      messages.push(new ToolMessage({ tool_call_id: callId, name: call.name, content: result }));
      planned = true;
      answerExtras();
    } else if (readByName.has(call.name)) {
      emit(config, {
        kind: 'tool.call',
        role: 'leader',
        call: { callId, name: call.name, args: call.args },
        at: now(),
      });
      const started = now();
      if (readsUsed >= LEADER_READ_CAP) {
        // The cap is per replan: this turn's evidence budget is spent, and the
        // refusal says what to do instead so a weak model can still finish.
        const refusal =
          `observation budget spent: at most ${LEADER_READ_CAP} reads per turn. ` +
          'Call set_plan with your best plan now.';
        emit(config, {
          kind: 'tool.result',
          role: 'leader',
          result: { callId, name: call.name, ok: false, summary: refusal, durationMs: now() - started },
          at: now(),
        });
        messages.push(new ToolMessage({ tool_call_id: callId, name: call.name, content: refusal }));
        answerExtras();
        continue;
      }
      readsUsed += 1;
      if (call.name === 'leader_screenshot') {
        if (screenshotsBarred) {
          // The model already failed on pixels this run: refuse without fetching so
          // a text-only Leader that keeps asking still ends its turn planning.
          const refusal =
            'this Leader cannot see images: use leader_snapshot or leader_extract_text, then call set_plan.';
          emit(config, {
            kind: 'tool.result',
            role: 'leader',
            result: { callId, name: call.name, ok: false, summary: refusal, durationMs: now() - started },
            at: now(),
          });
          messages.push(new ToolMessage({ tool_call_id: callId, name: call.name, content: refusal }));
          answerExtras();
          continue;
        }
        // Pixels cannot ride in a ToolMessage (capped text), so the screenshot
        // arrives as an observation block like the Follower's — fetched once,
        // logged as text, seen as an image.
        try {
          const shot = await ctx.page.screenshot();
          const summary = `screenshot ${shot.width}x${shot.height}`;
          emit(config, {
            kind: 'tool.result',
            role: 'leader',
            result: { callId, name: call.name, ok: true, summary, durationMs: now() - started },
            at: now(),
          });
          messages.push(new ToolMessage({ tool_call_id: callId, name: call.name, content: summary }));
          messages.push(
            new HumanMessage({
              content: [
                { type: 'text', text: `Leader screenshot of the visible page, ${shot.width} by ${shot.height} pixels.` },
                { type: 'image', url: shot.dataUrl, mimeType: 'image/png' },
              ],
            }),
          );
        } catch (error) {
          const result = toolResultText(error instanceof Error ? error.message : String(error));
          emit(config, {
            kind: 'tool.result',
            role: 'leader',
            result: { callId, name: call.name, ok: false, summary: summarize(result), durationMs: now() - started },
            at: now(),
          });
          messages.push(new ToolMessage({ tool_call_id: callId, name: call.name, content: result }));
        }
        answerExtras();
        continue;
      }
      let ok = true;
      let result: string;
      try {
        result = toolResultText(await readByName.get(call.name)!.invoke(call.args, config));
      } catch (error) {
        ok = false;
        result = toolResultText(error instanceof Error ? error.message : String(error));
      }
      emit(config, {
        kind: 'tool.result',
        role: 'leader',
        result: { callId, name: call.name, ok, summary: summarize(result), durationMs: now() - started },
        at: now(),
      });
      messages.push(new ToolMessage({ tool_call_id: callId, name: call.name, content: result }));
      answerExtras();
    } else {
      // Not the plan and not a read (a Follower tool name, say): answer the call
      // id so the transcript stays valid, and let the next lap try again rather
      // than executing another role's action. The lap bound still ends the turn.
      const refusal =
        `unknown leader tool ${JSON.stringify(call.name)}: the Leader plans with set_plan and reads ` +
        `with ${[...readByName.keys()].join(', ') || 'no read tools in this observe mode'}. Only the Follower acts.`;
      const started = now();
      emit(config, {
        kind: 'tool.call',
        role: 'leader',
        call: { callId, name: call.name, args: call.args },
        at: now(),
      });
      emit(config, {
        kind: 'tool.result',
        role: 'leader',
        result: { callId, name: call.name, ok: false, summary: refusal, durationMs: now() - started },
        at: now(),
      });
      messages.push(new ToolMessage({ tool_call_id: callId, name: call.name, content: refusal }));
      answerExtras();
    }
  }

  if (!planned) {
    // Small models sometimes answer in prose. Take the text as the plan rather
    // than stalling the run.
    plan = lastText || plan;
    if (!subgoals.length) subgoals = [plan || ctx.objective];
    currentSubgoal = Math.min(currentSubgoal, Math.max(subgoals.length - 1, 0));
  }

  emit(config, { kind: 'leader.plan', plan, subgoals, replan, at: now() });
  emit(config, {
    kind: 'handoff',
    from: 'leader',
    to: 'follower',
    reason: replan
      ? `re-planned; follower resumes on subgoal ${currentSubgoal}`
      : `plan set; follower starts on subgoal ${currentSubgoal}`,
    at: now(),
  });

  return {
    leaderMessages: messages.map(stripImageBlocks),
    plan,
    subgoals,
    currentSubgoal,
    stepsSinceReplan: 0,
    status: 'running',
  };
};

const follower: GraphNode<typeof AgentState, AgentContext> = async (state, config) => {
  const ctx = requireContext(config);
  const stepN = state.stepCount + 1;
  const role: Role = 'follower';

  emit(config, { kind: 'step', n: stepN, role, at: now() });

  // --- observe (R-08) -----------------------------------------------------
  const subgoal = state.subgoals[state.currentSubgoal] ?? state.plan ?? ctx.objective;
  const scripts = ctx.refreshUserscripts ? await ctx.refreshUserscripts().catch(() => ctx.availableUserscripts) : ctx.availableUserscripts;
  const scriptLine = scripts.length
    ? `Userscripts available here: ${scripts.map((s) => `${s.id} (${s.name})`).join(', ')}. Read one with read_userscript. run_userscript accepts optional args such as {"limitQueries":1,"pages":1}.`
    : 'No userscript is registered for this page. Write one with write_userscript if reading this page by hand would take many steps.';
  const blocks: ContentBlock[] = [
    {
      type: 'text',
      text: [
        `Objective: ${ctx.objective}`,
        `Current subgoal: ${subgoal}`,
        `Step ${stepN} of at most ${ctx.maxSteps}.`,
        ...(ctx.readOnly
          ? [
              'Read-only mode is on: act tools (click, hover, type, press, select, download, ' +
                'write_userscript) are unavailable. Read, navigate, run read-only userscripts, and save — ' +
                'or call blocked naming the unavailable action.',
            ]
          : []),
        scriptLine,
      ].join('\n'),
    },
  ];

  let tokens: number | undefined;
  let hasScreenshot = false;

  if (ctx.observe === 'dom' || ctx.observe === 'both') {
    const snap = await ctx.page.snapshot();
    tokens = snap.tokens;
    blocks.push({ type: 'text', text: `Page snapshot:\n${snap.text}` });
  }
  if (ctx.observe === 'pixels' || ctx.observe === 'both') {
    const shot = await ctx.page.screenshot();
    hasScreenshot = true;
    blocks.push({
      type: 'text',
      text: `Screenshot of the visible page, ${shot.width} by ${shot.height} pixels.`,
    });
    // Standard multimodal block. `image_url` / `MessageContentComplex` are
    // deprecated in @langchain/core 1.2.9 (C-03).
    blocks.push({ type: 'image', url: shot.dataUrl, mimeType: 'image/png' });
  }

  emit(config, { kind: 'observation', mode: ctx.observe, tokens, hasScreenshot, at: now() });

  // --- act ----------------------------------------------------------------
  const human = new HumanMessage({ content: blocks });
  const bound = ctx.followerModel.bindTools?.(ctx.toolset.all) ?? ctx.followerModel;
  const response = (await bound.invoke(
    [new SystemMessage(FOLLOWER_SYSTEM), ...trimFollowerHistory(state.followerMessages), human],
    config,
  )) as AIMessage;

  const text = textOf(response);
  if (text) emit(config, { kind: 'model.text', role, text, at: now() });

  const messages: BaseMessage[] = [human, response];
  const calls = response.tool_calls ?? [];
  const [call, ...extras] = calls;

  let signal: FollowerSignal = 'CONTINUE';
  let note = '';
  let status: RunStatus = 'running';
  let repeatFailureKey: string | null = state.repeatFailureKey;
  let repeatFailureTurns = state.repeatFailureTurns;
  let failureText = '';
  let recordedFailure = false;
  let failureAction: string | null = null;
  let endNote: string | null = state.endNote;

  if (!call) {
    // No action taken. Hand control back rather than burning steps.
    // Prose turns deliberately leave the repeat-failure tracker alone: answering in
    // prose between two identical failures does not make the retry any less futile.
    signal = 'RETURN_TO_LEADER';
    note = 'the follower produced no tool call';
  } else {
    const callId = call.id ?? `follower-${stepN}`;
    const rawArgs = (call.args ?? {}) as Record<string, unknown>;
    const { signal: declared, note: declaredNote, ...visibleArgs } = rawArgs;

    emit(config, {
      kind: 'tool.call',
      role,
      call: { callId, name: call.name, args: visibleArgs },
      at: now(),
    });

    const started = now();
    let ok = true;
    let result: string;
    const tool = ctx.toolset.byName.get(call.name);
    if (!tool) {
      ok = false;
      result = `no such tool: ${call.name}`;
    } else {
      try {
        result = toolResultText(await tool.invoke(rawArgs, config));
      } catch (error) {
        ok = false;
        result = toolResultText(error instanceof Error ? error.message : String(error));
      }
    }

    emit(config, {
      kind: 'tool.result',
      role,
      result: { callId, name: call.name, ok, summary: summarize(result), durationMs: now() - started },
      at: now(),
    });
    messages.push(new ToolMessage({ tool_call_id: callId, name: call.name, content: result }));

    note = typeof declaredNote === 'string' ? declaredNote : '';
    const terminal = TERMINAL_TOOLS[call.name];
    if (terminal === 'done' && ok) {
      signal = 'SUBGOAL_COMPLETE';
      status = 'done';
      if (!note) note = 'objective reported complete';
    } else if (terminal === 'blocked') {
      signal = 'BLOCKED';
      if (!note) note = 'follower reported it is blocked';
    } else if (!ok) {
      signal = parseSignal(declared) ?? 'CONTINUE';
      if (!note) note = 'tool call failed';
      // Repeat-failure stall detection (M2): the same action failing identically with
      // no successful page-changing action between attempts is a futile loop. Terminal
      // tools already ended the run above, so reaching here means the run continues.
      if (status === 'running') {
        failureText = result;
        recordedFailure = true;
        failureAction = call.name;
        const key = actionKey(call.name, visibleArgs, result);
        if (key === repeatFailureKey) repeatFailureTurns += 1;
        else {
          repeatFailureKey = key;
          repeatFailureTurns = 1;
        }
      }
    } else {
      signal = parseSignal(declared) ?? 'CONTINUE';
      // A successful read is not progress against a failing action: the page did not
      // change. Any other success clears the repeat chain (a retry after real progress
      // is recovery, not a loop).
      if (!READ_TOOL_NAMES.has(call.name)) {
        repeatFailureKey = null;
        repeatFailureTurns = 0;
      }
    }
  }

  // Answered after the acted call so the log reads action-then-refusals; every
  // emitted id still has its result before the next model call.
  answerExtraCalls(config, role, extras, `follower-${stepN}`, messages);

  // A refused extra is still a failed attempt for loop detection: without this, a
  // model batching [read, same-failing-action] every turn would repeat the refused
  // action forever outside both detectors. Only when the acted call did not already
  // record a failure this turn, so a real failure is never evicted by a refusal.
  const firstExtra = extras[0];
  if (status === 'running' && !recordedFailure && firstExtra) {
    failureText = EXTRA_CALL_REFUSAL;
    failureAction = firstExtra.name;
    const extraArgs = { ...((firstExtra.args ?? {}) as Record<string, unknown>) };
    delete extraArgs.signal;
    delete extraArgs.note;
    const key = actionKey(firstExtra.name, extraArgs, EXTRA_CALL_REFUSAL);
    if (key === repeatFailureKey) repeatFailureTurns += 1;
    else {
      repeatFailureKey = key;
      repeatFailureTurns = 1;
    }
  }

  if (status === 'running' && signal === 'BLOCKED') status = 'blocked';

  // A Follower that answers in prose never touches the page, so the Leader replans
  // and the same nothing happens again. Live: the free Nemotron pair spent 18 steps
  // in that loop. Stop while the reason is still legible instead of at maxSteps.
  const idleFollowerTurns = call ? 0 : state.idleFollowerTurns + 1;
  if (status === 'running' && idleFollowerTurns >= MAX_IDLE_FOLLOWER_TURNS) {
    status = 'error';
    note =
      `the follower returned no tool call ${idleFollowerTurns} turns running; ` +
      'it is answering in prose instead of acting. Try a model that reliably calls tools.';
    endNote = note;
  }

  if (status === 'running' && repeatFailureTurns >= MAX_REPEAT_FAILURE_TURNS) {
    status = 'error';
    const failingName = failureAction ?? (call ? call.name : null);
    note =
      `the follower repeated the same failing action ${repeatFailureTurns} times` +
      `${failingName ? ` (${failingName})` : ''}: ${summarize(failureText, 160)} No successful action happened ` +
      'between attempts. Try a different tool or subgoal, or call blocked.';
    endNote = note;
  }

  if (status === 'running' && stepN >= ctx.maxSteps) status = 'max-steps';

  emit(config, { kind: 'follower.signal', signal, note, at: now() });

  const stepsSinceReplan = state.stepsSinceReplan + 1;
  const decision = decideNext({ status, lastSignal: signal, stepCount: stepN, stepsSinceReplan }, ctx);
  if (decision.to === 'leader') {
    emit(config, {
      kind: 'handoff',
      from: 'follower',
      to: 'leader',
      reason: decision.reason,
      signal,
      at: now(),
    });
  }

  return {
    followerMessages: messages,
    stepCount: stepN,
    stepsSinceReplan,
    idleFollowerTurns,
    repeatFailureKey,
    repeatFailureTurns,
    lastSignal: signal,
    status,
    endNote,
  };
};

/* ------------------------------------------------------------------------- */
/* Assembly                                                                   */
/* ------------------------------------------------------------------------- */

export function buildAgentGraph(checkpointer?: BaseCheckpointSaver) {
  return new StateGraph(AgentState, { context: AgentContextSchema })
    .addNode('leader', leader)
    .addNode('follower', follower)
    .addEdge(START, 'leader')
    .addEdge('leader', 'follower')
    .addConditionalEdges('follower', route, ['leader', 'follower', END])
    .compile({ checkpointer });
}

export type AgentGraph = ReturnType<typeof buildAgentGraph>;
