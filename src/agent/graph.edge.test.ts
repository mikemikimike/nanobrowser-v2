/**
 * Gaps the review found in `graph.test.ts`:
 *
 * 1. `decideNext` -- "the single source of truth for what happens after a
 *    Follower step" -- is a pure, exported function, but was only ever
 *    exercised incidentally through full-graph `FakeChatModel` runs. This
 *    file unit-tests its priority order directly, including the tie cases
 *    (e.g. maxSteps reached *and* SUBGOAL_COMPLETE signalled together) that a
 *    full-graph harness cannot cleanly force.
 * 2. The follower node's `!tool` branch (an unknown tool name from the model)
 *    was never hit by any scripted turn.
 * 3. The leader node's `currentSubgoal` clamp and its `planTool.invoke`
 *    failure branch were never exercised.
 * 4. Issue #8: a tool call resetting the idle counter, and a schema-valid
 *    Follower call that fails at the page layer.
 */
import { describe, expect, it } from 'vitest';
import { MemorySaver } from '@langchain/langgraph/web';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunEvent } from '@/src/messaging/contract';
import type { Config } from '@/src/storage';
import {
  actionKey,
  decideNext,
  trimFollowerHistory,
  FOLLOWER_HISTORY_TURNS,
  MAX_IDLE_FOLLOWER_TURNS,
  type RouteInputs,
} from './graph';
import { FakePageTools } from './tools';
import { FakeChatModel, type FakeCall, type FakeTurn } from './models';
import { startRun, type RunEndedEvent } from './run';

const baseConfig: Config = {
  leaderModel: 'fake/leader',
  followerModel: 'fake/follower',
  observe: 'dom',
  planningInterval: 5,
  maxSteps: 10,
  inputFidelity: 'in-page',
};

const baseInputs: RouteInputs = { status: 'running', lastSignal: null, stepCount: 0, stepsSinceReplan: 0 };
const ctx = { planningInterval: 3, maxSteps: 10 };

describe('decideNext: priority order, tested directly as a pure function', () => {
  it('done always ends the run, regardless of anything else', () => {
    expect(decideNext({ ...baseInputs, status: 'done', stepCount: 999 }, ctx).to).toBe('__end__');
  });

  it('error always ends the run', () => {
    expect(decideNext({ ...baseInputs, status: 'error' }, ctx).to).toBe('__end__');
  });

  it('BLOCKED ends the run even if status is still "running"', () => {
    expect(decideNext({ ...baseInputs, lastSignal: 'BLOCKED' }, ctx).to).toBe('__end__');
  });

  it('status "blocked" ends the run even with no BLOCKED signal', () => {
    expect(decideNext({ ...baseInputs, status: 'blocked' }, ctx).to).toBe('__end__');
  });

  it('maxSteps reached ends the run even when the signal alone would have gone to the leader', () => {
    // Tie case: SUBGOAL_COMPLETE would normally hand off to the leader, but the
    // step budget takes priority once it is reached.
    const decision = decideNext({ ...baseInputs, lastSignal: 'SUBGOAL_COMPLETE', stepCount: 10 }, ctx);
    expect(decision.to).toBe('__end__');
    expect(decision.reason).toContain('step budget');
  });

  it('SUBGOAL_COMPLETE routes to the leader when the step budget is not yet reached', () => {
    expect(decideNext({ ...baseInputs, lastSignal: 'SUBGOAL_COMPLETE', stepCount: 1 }, ctx).to).toBe('leader');
  });

  it('RETURN_TO_LEADER routes to the leader', () => {
    expect(decideNext({ ...baseInputs, lastSignal: 'RETURN_TO_LEADER', stepCount: 1 }, ctx).to).toBe('leader');
  });

  it('the planning interval routes to the leader once reached, with no signal at all', () => {
    expect(decideNext({ ...baseInputs, stepsSinceReplan: 3 }, ctx).to).toBe('leader');
    expect(decideNext({ ...baseInputs, stepsSinceReplan: 2 }, ctx).to).toBe('follower');
  });

  it('CONTINUE (or no signal) stays on the follower when nothing else fires', () => {
    expect(decideNext({ ...baseInputs, lastSignal: 'CONTINUE' }, ctx).to).toBe('follower');
    expect(decideNext(baseInputs, ctx).to).toBe('follower');
  });

  it('maxSteps=0 ends the run immediately on the very first check', () => {
    expect(decideNext({ ...baseInputs, stepCount: 0 }, { planningInterval: 3, maxSteps: 0 }).to).toBe('__end__');
  });
});

const subgoals = ['open the page', 'read the page'];

function harness(options: {
  follower: (call: FakeCall) => FakeTurn;
  leaderRespond?: (call: FakeCall) => FakeTurn;
  page?: FakePageTools;
}): Promise<{ events: RunEvent[]; ended: RunEndedEvent; follower: FakeChatModel }> {
  const events: RunEvent[] = [];
  const page = options.page ?? new FakePageTools();
  const leader = new FakeChatModel({
    label: 'leader',
    respond:
      options.leaderRespond ??
      (() => ({ kind: 'tool', name: 'set_plan', args: { plan: 'do it', subgoals, currentSubgoal: 0 } })),
  });
  const follower = new FakeChatModel({ label: 'follower', respond: options.follower });

  const handle = startRun({
    prompt: 'find the widget',
    config: baseConfig,
    tools: page,
    models: { leader, follower },
    onEvent: (event) => events.push(event),
    checkpointer: new MemorySaver(),
    runId: `test-${Math.random().toString(36).slice(2)}`,
  });

  return handle.done.then((ended) => ({ events, ended, follower }));
}

function pick<K extends RunEvent['kind']>(events: RunEvent[], kind: K): Extract<RunEvent, { kind: K }>[] {
  return events.filter((e): e is Extract<RunEvent, { kind: K }> => e.kind === kind);
}

describe('follower node: an unrecognised tool name from the model', () => {
  it('reports a failed tool.result rather than crashing the run', async () => {
    const { events, ended } = await harness({
      follower: () => ({ kind: 'tool', name: 'not_a_real_tool', args: { signal: 'BLOCKED' } }),
    });

    const results = pick(events, 'tool.result').filter((r) => r.role === 'follower');
    expect(results).toHaveLength(1);
    expect(results[0]?.result.ok).toBe(false);
    expect(results[0]?.result.summary).toContain('no such tool');
    // The run must still end cleanly (BLOCKED signal), not hang or throw.
    expect(ended.status).toBe('blocked');
  });
});

describe('leader node: currentSubgoal clamp and a failing planTool.invoke', () => {
  it('clamps an out-of-range currentSubgoal into the actual subgoal list', async () => {
    const { events } = await harness({
      follower: () => ({ kind: 'tool', name: 'done', args: { summary: 'ok', signal: 'SUBGOAL_COMPLETE' } }),
      leaderRespond: () => ({
        kind: 'tool',
        name: 'set_plan',
        args: { plan: 'do it', subgoals: ['only-one'], currentSubgoal: 99 },
      }),
    });

    const plans = pick(events, 'leader.plan');
    expect(plans[0]?.subgoals).toEqual(['only-one']);
    const handoff = pick(events, 'handoff').find((h) => h.from === 'leader');
    expect(handoff?.reason).toContain('subgoal 0'); // clamped to the only valid index
  });

  it('clamps a negative currentSubgoal to 0', async () => {
    const { events } = await harness({
      follower: () => ({ kind: 'tool', name: 'done', args: { summary: 'ok', signal: 'SUBGOAL_COMPLETE' } }),
      leaderRespond: () => ({
        kind: 'tool',
        name: 'set_plan',
        args: { plan: 'do it', subgoals: ['a', 'b'], currentSubgoal: -5 },
      }),
    });

    const handoff = pick(events, 'handoff').find((h) => h.from === 'leader');
    expect(handoff?.reason).toContain('subgoal 0');
  });

  it('reports a failed leader tool.result when planTool.invoke rejects the args, without crashing the run', async () => {
    const { events, ended } = await harness({
      follower: () => ({ kind: 'tool', name: 'done', args: { summary: 'ok' } }),
      // subgoals: [] violates planTool's schema (.min(1)) so planTool.invoke throws.
      leaderRespond: () => ({ kind: 'tool', name: 'set_plan', args: { plan: 'do it', subgoals: [] } }),
    });

    const leaderResults = pick(events, 'tool.result').filter((r) => r.role === 'leader');
    expect(leaderResults).toHaveLength(1);
    expect(leaderResults[0]?.result.ok).toBe(false);
    // The run still proceeds to the follower and completes rather than hanging.
    expect(ended.status).toBe('done');
  });
});

describe('a follower that never calls a tool', () => {
  // Regression: the free Nemotron pair answered in prose every turn, so the Leader
  // replanned and nothing happened, 18 steps deep, until the step budget ran out.
  it('stops the run and names the cause instead of burning every step', async () => {
    const { events, ended } = await harness({
      follower: () => ({ kind: 'text', text: 'I think I should look at the page.' }),
    });

    expect(ended.status).toBe('error');
    expect(ended.steps).toBeLessThan(10);
    const signals = pick(events, 'follower.signal');
    expect(signals.at(-1)?.note).toContain('no tool call');
    expect(signals.at(-1)?.note).toContain('reliably calls tools');
    // The terminal event carries the same diagnosis, not the generic mapping.
    expect(ended.message).toContain('no tool call');
  });

  // Idle runs of MAX-1 prose turns either side of one click. A counter that
  // accumulated instead of resetting would reach MAX on the first prose turn
  // after the click.
  const idleThenClickThenIdle = (idleAfter: number) => (call: FakeCall): FakeTurn => {
    const before = MAX_IDLE_FOLLOWER_TURNS - 1;
    if (call.index < before) return { kind: 'text', text: 'let me think about it' };
    if (call.index === before) return { kind: 'tool', name: 'click', args: { ref: 'e1', signal: 'CONTINUE' } };
    if (call.index <= before + idleAfter) return { kind: 'text', text: 'thinking again' };
    return { kind: 'tool', name: 'done', args: { summary: 'found it' } };
  };

  it('resets the idle counter on a tool call instead of accumulating across it', async () => {
    const { events, ended } = await harness({
      follower: idleThenClickThenIdle(MAX_IDLE_FOLLOWER_TURNS - 1),
    });

    expect(ended.status).toBe('done');
    expect(ended.steps).toBe(2 * MAX_IDLE_FOLLOWER_TURNS);
    const notes = pick(events, 'follower.signal').map((s) => s.note);
    expect(notes.some((n) => n.includes('turns running'))).toBe(false);
  });

  it('still trips after a reset, counting only the idle turns since the tool call', async () => {
    const { events, ended } = await harness({
      follower: idleThenClickThenIdle(MAX_IDLE_FOLLOWER_TURNS),
    });

    expect(ended.status).toBe('error');
    expect(ended.steps).toBe(2 * MAX_IDLE_FOLLOWER_TURNS);
    expect(pick(events, 'follower.signal').at(-1)?.note).toContain(
      `no tool call ${MAX_IDLE_FOLLOWER_TURNS} turns running`,
    );
  });
});

describe('follower node: a schema-valid tool call that fails at the page layer', () => {
  it('logs a failed tool.result, feeds the error back to the model, and keeps the run going', async () => {
    const page = new FakePageTools();
    page.click = async (ref) => {
      (page.calls as Array<{ name: 'click'; args: unknown[] }>).push({ name: 'click', args: [ref] });
      throw new Error(`stale ref ${ref}: the element is no longer in the page`);
    };

    const { events, ended, follower } = await harness({
      page,
      follower: (call) =>
        call.index === 0
          ? { kind: 'tool', name: 'click', args: { ref: 'e1', signal: 'CONTINUE' } }
          : { kind: 'tool', name: 'done', args: { summary: 'found it' } },
    });

    // The args passed the schema: the page itself was asked to click.
    expect(page.calls.filter((c) => c.name === 'click')).toEqual([{ name: 'click', args: ['e1'] }]);

    const click = pick(events, 'tool.result').find((r) => r.role === 'follower' && r.result.name === 'click');
    expect(click?.result.ok).toBe(false);
    expect(click?.result.summary).toContain('stale ref e1');
    expect(pick(events, 'follower.signal')[0]).toMatchObject({ signal: 'CONTINUE', note: 'tool call failed' });

    const toolMessages = follower.calls.flatMap(
      (call) => call.messages.filter((m) => m.type === 'tool') as ToolMessage[],
    );
    expect(toolMessages.find((m) => m.name === 'click')?.content).toContain('stale ref e1');

    // One page failure is neither a crash nor a repeat loop.
    expect(ended).toMatchObject({ status: 'done', steps: 2 });
  });
});

describe('follower history is bounded', () => {
  // Regression: every turn carries a full page observation (~17k tokens on a
  // 60-listing eBay page). Unbounded, a live run reached 285,351 tokens against a
  // 262,144-token model and died with a 400 before it could save anything.
  const msg = (i: number) => new HumanMessage(`turn ${i}`);

  it('keeps only the most recent turns', () => {
    const history = Array.from({ length: 40 }, (_, i) => msg(i));
    const kept = trimFollowerHistory(history);

    expect(kept).toHaveLength(FOLLOWER_HISTORY_TURNS);
    expect(kept.at(-1)).toBe(history.at(-1));
    expect(kept).not.toContain(history[0]);
  });

  it('leaves a short history untouched, so early steps lose nothing', () => {
    const history = [msg(0), msg(1)];
    expect(trimFollowerHistory(history)).toEqual(history);
  });

  it('never returns an empty history, whatever it is asked for', () => {
    const history = Array.from({ length: 10 }, (_, i) => msg(i));
    expect(trimFollowerHistory(history, 0).length).toBeGreaterThan(0);
  });

  it('cuts only at turn boundaries, so no kept tool result loses its assistant call', () => {
    // Turn 1 carries refused extras (one AI message, three tool results); a
    // fixed message-count slice would keep the first refused result while
    // cutting the assistant call it answers, which providers reject.
    const ai = (id: string, calls: string[]) =>
      new AIMessage({
        content: '',
        tool_calls: calls.map((name, i) => ({ id: `${id}-${i}`, name, args: {} })),
      });
    const res = (id: string) => new ToolMessage({ tool_call_id: id, content: 'refused' });
    const turn1: BaseMessage[] = [msg(0), ai('a0', ['snapshot', 'bogus', 'bogus']), res('a0-0'), res('a0-1'), res('a0-2')];
    const turn2: BaseMessage[] = [msg(1), ai('a1', ['click']), res('a1-0')];
    const history = [...turn1, ...turn2];

    const kept = trimFollowerHistory(history, 1);
    expect(kept).toEqual(turn2);
    expect(kept[0]).toBeInstanceOf(HumanMessage);
    expect(kept.filter((m) => m instanceof ToolMessage)).toHaveLength(1);
  });
});

describe('actionKey', () => {
  it('matches identical attempts despite key order and varying durations', () => {
    const a = actionKey('click', { ref: 'e1' }, 'stale ref after 12ms');
    const b = actionKey('click', { ref: 'e1' }, 'stale ref after 34ms');
    expect(a).toBe(b);
    expect(actionKey('type', { ref: 'e1', text: 'x' }, 'e')).toBe(
      actionKey('type', { text: 'x', ref: 'e1' }, 'e'),
    );
  });

  it('treats other digit changes as different failures (429 is not 500)', () => {
    expect(actionKey('snapshot', {}, 'request failed with status code 429')).not.toBe(
      actionKey('snapshot', {}, 'request failed with status code 500'),
    );
  });

  it('distinguishes errors that share a long prefix but differ after it', () => {
    const prefix = `console output:\n${'x'.repeat(300)}\n`;
    const a = actionKey('run_userscript', { scriptId: 's' }, `${prefix}TypeError: undefined is not an object`);
    const b = actionKey('run_userscript', { scriptId: 's' }, `${prefix}ReferenceError: foo is not defined`);
    expect(a).not.toBe(b);
  });

  it('distinguishes large payloads that share a prefix and length', () => {
    const a = actionKey('save_file', { body: `${'x'.repeat(600)}a` }, 'denied');
    const b = actionKey('save_file', { body: `${'x'.repeat(600)}b` }, 'denied');
    expect(a).not.toBe(b);
  });
});
