/**
 * Graph behaviour: cadence (R-04), Follower-initiated handoff (R-03), tool-call
 * logging (R-06/R-07), observe modes (R-08), and history separation.
 *
 * No network and no browser: `FakeChatModel` scripts the models and
 * `FakePageTools` records the page calls (N-01/N-02 — nothing outside the run
 * drives it, so a scripted model is the whole world).
 */
import { describe, expect, it } from 'vitest';
import { MemorySaver } from '@langchain/langgraph/web';
import type { ToolMessage } from '@langchain/core/messages';
import type { RunEvent } from '@/src/messaging/contract';
import type { Config, ObserveMode } from '@/src/storage';
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

interface HarnessOptions {
  follower: (call: FakeCall) => FakeTurn;
  leader?: (call: FakeCall) => FakeTurn;
  planningInterval?: number;
  maxSteps?: number;
  observe?: ObserveMode;
  readOnly?: boolean;
  subgoals?: string[];
}

interface HarnessResult {
  events: RunEvent[];
  ended: RunEndedEvent;
  page: FakePageTools;
  leader: FakeChatModel;
  follower: FakeChatModel;
}

async function harness(options: HarnessOptions): Promise<HarnessResult> {
  const events: RunEvent[] = [];
  const page = new FakePageTools();
  const subgoals = options.subgoals ?? ['open the page', 'read the page'];
  const leader = new FakeChatModel({
    label: 'leader',
    respond:
      options.leader ??
      (() => ({
        kind: 'tool',
        name: 'set_plan',
        args: { plan: 'do it in two moves', subgoals, currentSubgoal: 0 },
      })),
  });
  const follower = new FakeChatModel({ label: 'follower', respond: options.follower });

  const handle = startRun({
    prompt: 'find the widget',
    config: {
      ...baseConfig,
      planningInterval: options.planningInterval ?? baseConfig.planningInterval,
      maxSteps: options.maxSteps ?? baseConfig.maxSteps,
      observe: options.observe ?? baseConfig.observe,
      ...(options.readOnly !== undefined ? { readOnly: options.readOnly } : {}),
    },
    tools: page,
    models: { leader, follower },
    onEvent: (event) => events.push(event),
    checkpointer: new MemorySaver(),
    runId: `test-${Math.random().toString(36).slice(2)}`,
  });

  const ended = await handle.done;
  return { events, ended, page, leader, follower };
}

function pick<K extends RunEvent['kind']>(
  events: RunEvent[],
  kind: K,
): Extract<RunEvent, { kind: K }>[] {
  return events.filter((e): e is Extract<RunEvent, { kind: K }> => e.kind === kind);
}

function followerStepNumbers(events: RunEvent[]): number[] {
  return pick(events, 'step')
    .filter((e) => e.role === 'follower')
    .map((e) => e.n);
}

/** The follower step number in effect when each follower -> leader handoff fired. */
function handoffSteps(events: RunEvent[]): number[] {
  const at: number[] = [];
  let step = 0;
  for (const event of events) {
    if (event.kind === 'step' && event.role === 'follower') step = event.n;
    if (event.kind === 'handoff' && event.from === 'follower') at.push(step);
  }
  return at;
}

function toolNamesInHistory(model: FakeChatModel): string[] {
  return model.calls.flatMap((call) =>
    call.messages
      .filter((m) => m.type === 'tool')
      .map((m) => (m as ToolMessage).name ?? '(unnamed)'),
  );
}

const alwaysContinue = (): FakeTurn => ({
  kind: 'tool',
  name: 'click',
  args: { ref: 'e1', signal: 'CONTINUE' },
});

describe('leader/follower cadence (R-04)', () => {
  it('replans exactly every planningInterval follower steps', async () => {
    const { events, ended } = await harness({
      planningInterval: 2,
      maxSteps: 6,
      follower: alwaysContinue,
    });

    expect(followerStepNumbers(events)).toEqual([1, 2, 3, 4, 5, 6]);
    // One initial plan plus one re-plan after each pair of follower steps.
    expect(pick(events, 'leader.plan').map((e) => e.replan)).toEqual([false, true, true]);
    expect(handoffSteps(events)).toEqual([2, 4]);
    expect(pick(events, 'handoff').filter((e) => e.from === 'leader')).toHaveLength(3);
    for (const handoff of pick(events, 'handoff').filter((e) => e.from === 'follower')) {
      expect(handoff.reason).toContain('planning interval of 2');
      expect(handoff.signal).toBe('CONTINUE');
    }
    expect(ended.status).toBe('max-steps');
  });
});

describe('follower-initiated handoff (R-03)', () => {
  it.each(['SUBGOAL_COMPLETE', 'RETURN_TO_LEADER'] as const)(
    'routes %s straight back to the leader',
    async (signal) => {
      const { events, ended } = await harness({
        planningInterval: 5,
        maxSteps: 4,
        follower: (call) =>
          call.index === 0
            ? { kind: 'tool', name: 'click', args: { ref: 'e1', signal, note: 'moving on' } }
            : { kind: 'tool', name: 'done', args: { summary: 'found the widget' } },
      });

      // The handoff happened on step 1, well inside the planning interval of 5.
      expect(handoffSteps(events)).toEqual([1]);
      const back = pick(events, 'handoff').find((e) => e.from === 'follower');
      expect(back?.signal).toBe(signal);
      expect(back?.reason).not.toContain('planning interval');

      const kinds = events.map((e) => e.kind);
      const handoffIndex = kinds.indexOf('handoff', kinds.indexOf('step') + 1);
      // Nothing runs between the follower's signal and the leader's re-plan.
      expect(kinds.slice(handoffIndex).filter((k) => k === 'leader.plan')).toHaveLength(1);
      expect(pick(events, 'leader.plan').map((e) => e.replan)).toEqual([false, true]);
      expect(followerStepNumbers(events)).toEqual([1, 2]);
      expect(ended.status).toBe('done');
    },
  );

  it('ends the run on BLOCKED without returning to the leader', async () => {
    const { events, ended } = await harness({
      maxSteps: 10,
      follower: () => ({
        kind: 'tool',
        name: 'click',
        args: { ref: 'e1', signal: 'BLOCKED', note: 'login wall' },
      }),
    });

    expect(ended.status).toBe('blocked');
    expect(ended.steps).toBe(1);
    expect(pick(events, 'follower.signal')[0]).toMatchObject({
      signal: 'BLOCKED',
      note: 'login wall',
    });
    expect(pick(events, 'handoff').filter((e) => e.from === 'follower')).toHaveLength(0);
    expect(pick(events, 'leader.plan')).toHaveLength(1);
  });
});

describe('tool call log (R-06)', () => {
  it('emits tool.call then tool.result in order with matching callIds', async () => {
    const { events } = await harness({
      planningInterval: 5,
      maxSteps: 4,
      follower: (call) =>
        call.index < 2
          ? { kind: 'tool', name: 'type', args: { ref: 'e2', text: 'widget', signal: 'CONTINUE' } }
          : { kind: 'tool', name: 'done', args: { summary: 'found it' } },
    });

    const pairs = events.filter((e) => e.kind === 'tool.call' || e.kind === 'tool.result');
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs.length % 2).toBe(0);

    const names: string[] = [];
    for (let i = 0; i < pairs.length; i += 2) {
      const call = pairs[i];
      const result = pairs[i + 1];
      if (call?.kind !== 'tool.call' || result?.kind !== 'tool.result') {
        throw new Error(`unpaired tool events at ${i}: ${call?.kind} / ${result?.kind}`);
      }
      expect(result.result.callId).toBe(call.call.callId);
      expect(result.result.name).toBe(call.call.name);
      expect(result.role).toBe(call.role);
      expect(result.result.ok).toBe(true);
      names.push(call.call.name);
    }

    // The leader's own planning call is logged the same way.
    expect(names).toContain('set_plan');
    expect(names).toContain('type');
    expect(names).toContain('done');

    // The control envelope is a protocol detail, not something the UI shows as
    // an argument of the action.
    const typeCall = pick(events, 'tool.call').find((e) => e.call.name === 'type');
    expect(typeCall?.call.args).toEqual({ ref: 'e2', text: 'widget' });
  });
});

describe('observe modes (R-08)', () => {
  const imageBlocks = (model: FakeChatModel): string[] => {
    const last = model.calls.at(-1);
    const human = last?.messages.at(-1);
    const content = human?.content;
    if (typeof content === 'string' || content === undefined) return [];
    return (content as Array<{ type?: string }>).map((b) => b.type ?? '');
  };

  it('sends an image content block in pixels mode and none in dom mode', async () => {
    const pixels = await harness({ maxSteps: 1, observe: 'pixels', follower: alwaysContinue });
    expect(imageBlocks(pixels.follower)).toContain('image');
    expect(pixels.page.names).toContain('screenshot');
    expect(pixels.page.names).not.toContain('snapshot');
    expect(pick(pixels.events, 'observation')[0]).toMatchObject({
      mode: 'pixels',
      hasScreenshot: true,
    });

    const dom = await harness({ maxSteps: 1, observe: 'dom', follower: alwaysContinue });
    expect(imageBlocks(dom.follower)).not.toContain('image');
    expect(dom.page.names).toContain('snapshot');
    expect(dom.page.names).not.toContain('screenshot');
    expect(pick(dom.events, 'observation')[0]).toMatchObject({
      mode: 'dom',
      hasScreenshot: false,
    });

    const both = await harness({ maxSteps: 1, observe: 'both', follower: alwaysContinue });
    expect(imageBlocks(both.follower)).toContain('image');
    expect(both.page.names).toContain('snapshot');
    expect(both.page.names).toContain('screenshot');
  });
});

describe('role isolation', () => {
  it('keeps the leader and follower message histories separate', async () => {
    const { leader, follower } = await harness({
      planningInterval: 2,
      maxSteps: 6,
      observe: 'both',
      follower: (call) =>
        call.index < 3
          ? { kind: 'tool', name: 'click', args: { ref: 'e1', signal: 'CONTINUE' } }
          : { kind: 'tool', name: 'done', args: { summary: 'done' } },
    });

    expect(leader.calls.length).toBeGreaterThan(1);
    expect(follower.calls.length).toBeGreaterThan(1);

    // The planner never sees a page observation.
    const leaderSeen = JSON.stringify(leader.calls.map((c) => c.messages.map((m) => m.content)));
    expect(leaderSeen).not.toContain('Page snapshot');
    expect(toolNamesInHistory(leader)).toEqual(
      Array.from({ length: leader.calls.length - 1 }, () => 'set_plan'),
    );

    // The navigator never sees the plan tool or the planner's instructions.
    const followerSeen = JSON.stringify(
      follower.calls.map((c) => c.messages.map((m) => m.content)),
    );
    expect(followerSeen).not.toContain('set_plan');
    expect(followerSeen).toContain('Page snapshot');
    const followerTools = toolNamesInHistory(follower);
    expect(followerTools.length).toBeGreaterThan(0);
    expect(followerTools).not.toContain('set_plan');

    // Each role is bound only to its own tools.
    expect(leader.boundTools).toEqual([
      'leader_snapshot',
      'leader_screenshot',
      'leader_extract_text',
      'set_plan',
    ]);
    expect(follower.boundTools).toContain('click');
    expect(follower.boundTools).not.toContain('set_plan');
  });
});

describe('tool results reaching the model (R-06)', () => {
  /**
   * Regression: `summarize()` exists to keep the *run log* short (R-06). The graph
   * was passing that same 240-char summary into the ToolMessage the model reads,
   * so `extract_text` could never return more than 240 characters however large a
   * `maxChars` the model asked for -- and its own "[truncated at N of M]" marker,
   * which sits at the end of the string, was cut off with it.
   */
  it('gives the model the full tool result, not the 240-char log summary', async () => {
    const long = `ROW-${'x'.repeat(4000)}-END`;
    const page = new FakePageTools();
    page.extractText = async () => long;

    let turn = 0;
    const events: RunEvent[] = [];
    const leader = new FakeChatModel({
      label: 'leader',
      respond: () => ({
        kind: 'tool',
        name: 'set_plan',
        args: { plan: 'read it', subgoals: ['read the page'], currentSubgoal: 0 },
      }),
    });
    const follower = new FakeChatModel({
      label: 'follower',
      respond: (): FakeTurn =>
        turn++ === 0
          ? { kind: 'tool', name: 'extract_text', args: { maxChars: 20000, signal: 'CONTINUE' } }
          : { kind: 'tool', name: 'done', args: { summary: 'read it' } },
    });

    const handle = startRun({
      prompt: 'read the page',
      config: baseConfig,
      tools: page,
      models: { leader, follower },
      onEvent: (event) => events.push(event),
      checkpointer: new MemorySaver(),
      runId: `test-${Math.random().toString(36).slice(2)}`,
    });
    await handle.done;

    const toolMessages = follower.calls.flatMap((call) =>
      call.messages.filter((m) => m.type === 'tool') as ToolMessage[],
    );
    const extract = toolMessages.find((m) => m.name === 'extract_text');
    expect(extract).toBeDefined();
    expect(extract?.content).toBe(long);

    // The run log still gets the short form, so the panel is not flooded.
    const logged = pick(events, 'tool.result').find((e) => e.result.name === 'extract_text');
    expect(logged?.result.summary.length).toBeLessThanOrEqual(240);
  });
});

describe('the Follower authoring its own userscript (R-09/R-10, O-03)', () => {
  it('can write a script, run the id it gets back, and see what the script returned', async () => {
    const page = new FakePageTools();
    page.writeUserscript = async (request) => {
      // Recorded through the real port so the assertion below is on what the
      // model actually asked for, not on a stub's convenience.
      (page.calls as Array<{ name: 'writeUserscript'; args: unknown[] }>).push({
        name: 'writeUserscript',
        args: [request],
      });
      return 'created userscript sc-9 ("titles"). Run it with run_userscript scriptId "sc-9".';
    };
    page.runUserscript = async (scriptId) => {
      (page.calls as Array<{ name: 'runUserscript'; args: unknown[] }>).push({
        name: 'runUserscript',
        args: [scriptId],
      });
      return `userscript ${scriptId} ran in 4ms: ["a","b"]\nconsole:\n[log] found 2`;
    };

    let turn = 0;
    const events: RunEvent[] = [];
    const leader = new FakeChatModel({
      label: 'leader',
      respond: () => ({
        kind: 'tool',
        name: 'set_plan',
        args: { plan: 'script it', subgoals: ['read the titles'], currentSubgoal: 0 },
      }),
    });
    const follower = new FakeChatModel({
      label: 'follower',
      respond: (): FakeTurn => {
        switch (turn++) {
          case 0:
            return {
              kind: 'tool',
              name: 'write_userscript',
              args: {
                name: 'titles',
                matches: ['*://chatgpt.com/*'],
                code: 'return [...document.querySelectorAll("h1")].map((h) => h.textContent);',
                signal: 'CONTINUE',
              },
            };
          case 1:
            return { kind: 'tool', name: 'run_userscript', args: { scriptId: 'sc-9', signal: 'CONTINUE' } };
          default:
            return { kind: 'tool', name: 'done', args: { summary: 'read the titles' } };
        }
      },
    });

    const handle = startRun({
      prompt: 'read the titles',
      config: baseConfig,
      tools: page,
      models: { leader, follower },
      onEvent: (event) => events.push(event),
      checkpointer: new MemorySaver(),
      runId: `test-${Math.random().toString(36).slice(2)}`,
    });
    await handle.done;

    const userscriptCalls = page.calls.filter(
      (call) => call.name === 'writeUserscript' || call.name === 'runUserscript',
    );
    expect(userscriptCalls.map((call) => call.name)).toEqual(['writeUserscript', 'runUserscript']);
    expect(userscriptCalls[0]!.args[0]).toMatchObject({ name: 'titles', matches: ['*://chatgpt.com/*'] });
    expect(userscriptCalls[1]!.args[0]).toBe('sc-9');

    const toolMessages = follower.calls.flatMap((call) =>
      call.messages.filter((m) => m.type === 'tool') as ToolMessage[],
    );
    // Both halves of the loop have to survive the trip back to the model: the id to
    // run, and the console the next edit would be based on.
    expect(toolMessages.find((m) => m.name === 'write_userscript')?.content).toContain('sc-9');
    expect(toolMessages.find((m) => m.name === 'run_userscript')?.content).toContain('[log] found 2');
  });
});

describe('leader observation reads (M4)', () => {
  const finishQuickly = (): FakeTurn => ({ kind: 'tool', name: 'done', args: { summary: 'done' } });

  function leaderCalls(events: RunEvent[], name: string) {
    return pick(events, 'tool.call').filter((e) => e.role === 'leader' && e.call.name === name);
  }

  function leaderResults(events: RunEvent[], name: string) {
    return pick(events, 'tool.result').filter((e) => e.role === 'leader' && e.result.name === name);
  }

  it('lets the leader pull a snapshot before planning, logged as a leader tool call', async () => {
    const { events, ended, page } = await harness({
      maxSteps: 2,
      follower: finishQuickly,
      leader: (call) =>
        call.index === 0
          ? { kind: 'tool', name: 'leader_snapshot', args: {} }
          : {
              kind: 'tool',
              name: 'set_plan',
              args: { plan: 'do it in two moves', subgoals: ['open the page'], currentSubgoal: 0 },
            },
    });

    // The read really reached the page: one leader pull plus the follower's own
    // observe on its turn (observe 'dom').
    expect(page.calls.filter((c) => c.name === 'snapshot')).toHaveLength(2);
    expect(leaderCalls(events, 'leader_snapshot')).toHaveLength(1);
    expect(leaderResults(events, 'leader_snapshot')).toMatchObject([{ result: { ok: true } }]);
    // And the turn still ended in a plan, not in a second follower.
    expect(pick(events, 'leader.plan')).toHaveLength(1);
    expect(ended).toMatchObject({ status: 'done' });
  });

  it('caps leader reads per replan and refuses past the cap instead of executing', async () => {
    const { events, page } = await harness({
      maxSteps: 2,
      follower: finishQuickly,
      // A model that only ever reads: never plans, never stops asking.
      leader: () => ({ kind: 'tool', name: 'leader_snapshot', args: {} }),
    });

    // Two reads executed; the rest refused without touching the page again
    // (3 snapshots total: 2 leader pulls + the follower's own observe).
    expect(page.calls.filter((c) => c.name === 'snapshot')).toHaveLength(3);
    expect(leaderCalls(events, 'leader_snapshot')).toHaveLength(4);
    const results = leaderResults(events, 'leader_snapshot');
    expect(results.map((e) => e.result.ok)).toEqual([true, true, false, false]);
    expect(results[2]?.result.summary).toContain('observation budget spent');
    // The turn still ended (prose fallback) and the run moved on to the follower.
    expect(pick(events, 'leader.plan')).toHaveLength(1);
  });

  it('delivers a leader screenshot as pixels, with the text summary in the run log', async () => {
    const { events, leader, page } = await harness({
      maxSteps: 2,
      observe: 'both',
      follower: finishQuickly,
      leader: (call) =>
        call.index === 0
          ? { kind: 'tool', name: 'leader_screenshot', args: {} }
          : {
              kind: 'tool',
              name: 'set_plan',
              args: { plan: 'do it in two moves', subgoals: ['open the page'], currentSubgoal: 0 },
            },
    });

    // One leader pull plus the follower's own observe on its turn (observe 'both').
    expect(page.calls.filter((c) => c.name === 'screenshot')).toHaveLength(2);
    expect(leaderResults(events, 'leader_screenshot')).toMatchObject([{ result: { ok: true } }]);
    // The second lap's input carries the image block the text summary points at.
    const seen = JSON.stringify(leader.calls[1]?.messages.map((m) => m.content));
    expect(seen).toContain('Leader screenshot');
    expect(seen).toContain('image');
  });

  it('survives a text-only Leader: pixels swap for a note and the turn still plans', async () => {
    const planArgs = { plan: 'do it blind', subgoals: ['open the page'], currentSubgoal: 0 };
    const { events, leader, page } = await harness({
      maxSteps: 2,
      observe: 'both',
      follower: finishQuickly,
      leader: (call) => {
        const seen = JSON.stringify(call.messages.map((m) => m.content));
        if (seen.includes('"image"')) throw new Error('400: images not supported by this model');
        return call.index === 0
          ? { kind: 'tool', name: 'leader_screenshot', args: {} }
          : { kind: 'tool', name: 'set_plan', args: planArgs };
      },
    });

    // One leader pull plus the follower's own observe on its turn (observe 'both').
    expect(page.calls.filter((c) => c.name === 'screenshot')).toHaveLength(2);
    expect(pick(events, 'leader.plan')).toHaveLength(1);
    // The failed pixels were swapped for a note, not left to fail every replan.
    const history = JSON.stringify(leader.calls.map((c) => c.messages.map((m) => m.content)));
    expect(history).toContain('cannot see images');
  });

  it('bars further screenshots once the Leader has failed on pixels', async () => {
    const { events, page } = await harness({
      maxSteps: 2,
      observe: 'both',
      follower: finishQuickly,
      leader: (call) => {
        const seen = JSON.stringify(call.messages.map((m) => m.content));
        if (seen.includes('"image"')) throw new Error('400: images not supported by this model');
        return { kind: 'tool', name: 'leader_screenshot', args: {} };
      },
    });

    // One fetch; the retry is refused without touching the page again
    // (the second screenshot is the follower's own observe in 'both' mode).
    expect(page.calls.filter((c) => c.name === 'screenshot')).toHaveLength(2);
    const results = leaderResults(events, 'leader_screenshot');
    expect(results.map((e) => e.result.ok)).toEqual([true, false, false]);
    expect(results[1]?.result.summary).toContain('cannot see images');
  });

  it('propagates transient failures with pixels instead of mis-barring screenshots', async () => {
    const { ended, leader } = await harness({
      maxSteps: 2,
      observe: 'both',
      follower: finishQuickly,
      leader: (call) => {
        const seen = JSON.stringify(call.messages.map((m) => m.content));
        if (seen.includes('"image"')) throw new Error('429 rate limited, retry later');
        return { kind: 'tool', name: 'leader_screenshot', args: {} };
      },
    });

    expect(ended).toMatchObject({ kind: 'run.ended', status: 'error' });
    expect(ended.message).toContain('429');
    const history = JSON.stringify(leader.calls.map((c) => c.messages.map((m) => m.content)));
    expect(history).not.toContain('cannot see images');
  });

  it('answers every call id when the Leader batches two reads in one turn', async () => {
    const { events } = await harness({
      maxSteps: 2,
      follower: finishQuickly,
      leader: (call) =>
        call.index === 0
          ? {
              kind: 'tools',
              calls: [
                { name: 'leader_snapshot', args: {} },
                { name: 'leader_snapshot', args: {} },
              ],
            }
          : {
              kind: 'tool',
              name: 'set_plan',
              args: { plan: 'p', subgoals: ['s'], currentSubgoal: 0 },
            },
    });

    // First read executed, second refused with a re-issue note — never silently
    // dropped, which would corrupt the transcript on the next model call.
    const results = leaderResults(events, 'leader_snapshot');
    expect(results.map((e) => e.result.ok)).toEqual([true, false]);
    expect(results[1]?.result.summary).toContain('re-issue');
    const callIds = leaderCalls(events, 'leader_snapshot').map((e) => e.call.callId).sort();
    expect(results.map((e) => e.result.callId).sort()).toEqual(callIds);
  });

  it('answers an unknown leader tool with an error and keeps the turn going', async () => {
    const { events } = await harness({
      maxSteps: 2,
      follower: finishQuickly,
      leader: (call) =>
        call.index === 0
          ? { kind: 'tool', name: 'click', args: { ref: 'e1' } }
          : {
              kind: 'tool',
              name: 'set_plan',
              args: { plan: 'p', subgoals: ['s'], currentSubgoal: 0 },
            },
    });

    const results = leaderResults(events, 'click');
    expect(results).toHaveLength(1);
    expect(results[0]?.result.ok).toBe(false);
    expect(results[0]?.result.summary).toContain('unknown leader tool');
    expect(pick(events, 'leader.plan')).toHaveLength(1);
  });

  it('drops screenshot pixels from persisted leader history across replans', async () => {
    const planArgs = { plan: 'p', subgoals: ['s'], currentSubgoal: 0 };
    const { leader } = await harness({
      maxSteps: 4,
      observe: 'both',
      planningInterval: 1,
      follower: (call) =>
        call.index < 3
          ? { kind: 'tool', name: 'snapshot', args: {} }
          : { kind: 'tool', name: 'done', args: { summary: 'done' } },
      leader: (call) =>
        call.index % 2 === 0
          ? { kind: 'tool', name: 'leader_screenshot', args: {} }
          : { kind: 'tool', name: 'set_plan', args: planArgs },
    });

    // The live screenshot rode along exactly once, on the turn that took it...
    const early = JSON.stringify(leader.calls[1]?.messages.map((m) => m.content));
    expect(early).toContain('image');
    // ...and no later turn's opening input resends it: persisted history keeps
    // the dims text (the proof the pull happened) without the pixels.
    expect(leader.calls.length).toBeGreaterThan(2);
    for (let i = 2; i < leader.calls.length; i += 2) {
      const seen = JSON.stringify(leader.calls[i]?.messages.map((m) => m.content));
      expect(seen).not.toContain('"image"');
      expect(seen).toContain('Leader screenshot of the visible page');
    }
  });

  it('withholds screenshots from the Leader in dom mode', async () => {
    const { events, leader } = await harness({
      maxSteps: 2,
      observe: 'dom',
      follower: finishQuickly,
      leader: (call) =>
        call.index === 0
          ? { kind: 'tool', name: 'leader_screenshot', args: {} }
          : {
              kind: 'tool',
              name: 'set_plan',
              args: { plan: 'p', subgoals: ['s'], currentSubgoal: 0 },
            },
    });

    expect(leader.calls[0]?.tools).toEqual(
      expect.arrayContaining(['leader_snapshot', 'leader_extract_text', 'set_plan']),
    );
    expect(leader.calls[0]?.tools).not.toContain('leader_screenshot');
    expect(leaderResults(events, 'leader_screenshot').map((e) => e.result.ok)).toEqual([false]);
    expect(pick(events, 'leader.plan')).toHaveLength(1);
  });

  it('withholds DOM text from the Leader in pixels mode', async () => {
    const { leader } = await harness({
      maxSteps: 2,
      observe: 'pixels',
      follower: finishQuickly,
      leader: (call) =>
        call.index === 0
          ? { kind: 'tool', name: 'leader_snapshot', args: {} }
          : {
              kind: 'tool',
              name: 'set_plan',
              args: { plan: 'p', subgoals: ['s'], currentSubgoal: 0 },
            },
    });

    expect(leader.calls[0]?.tools).toEqual(
      expect.arrayContaining(['leader_screenshot', 'set_plan']),
    );
    expect(leader.calls[0]?.tools).not.toContain('leader_snapshot');
    expect(leader.calls[0]?.tools).not.toContain('leader_extract_text');
  });

  it('acts on the first call and refuses the rest when the Follower batches', async () => {
    const { events, ended, page } = await harness({
      maxSteps: 4,
      follower: (call) =>
        call.index === 0
          ? {
              kind: 'tools',
              calls: [
                { name: 'snapshot', args: {} },
                { name: 'click', args: { ref: 'e1' } },
              ],
            }
          : { kind: 'tool', name: 'done', args: { summary: 'done' } },
    });

    // One action per step: the snapshot ran, the click never touched the page.
    expect(page.calls.filter((c) => c.name === 'click')).toHaveLength(0);
    const followerResults = pick(events, 'tool.result').filter((e) => e.role === 'follower');
    expect(followerResults.map((e) => e.result.ok)).toEqual([true, false, true]);
    // Every follower call id has its result: the transcript stays valid.
    const callIds = pick(events, 'tool.call')
      .filter((e) => e.role === 'follower')
      .map((e) => e.call.callId)
      .sort();
    expect(followerResults.map((e) => e.result.callId).sort()).toEqual(callIds);
    expect(ended).toMatchObject({ status: 'done' });
  });

  it('does not let the follower call the leader reads', async () => {
    const { ended } = await harness({
      maxSteps: 4,
      follower: (call) =>
        call.index === 0
          ? { kind: 'tool', name: 'leader_snapshot', args: {} }
          : { kind: 'tool', name: 'done', args: { summary: 'done' } },
    });

    // The unknown-tool failure is not a repeat loop: the next turn finishes.
    expect(ended).toMatchObject({ status: 'done', steps: 2 });
  });
});

describe('read-only runs (M9 #13)', () => {
  it('tells the follower read-only mode is on, and only then', async () => {
    for (const readOnly of [true, false] as const) {
      const { follower } = await harness({
        maxSteps: 1,
        ...(readOnly ? { readOnly: true } : {}),
        follower: () => ({ kind: 'tool', name: 'done', args: { summary: 'done' } }),
      });
      const first = follower.calls[0]!;
      const text = JSON.stringify(first.messages.map((m) => m.content));
      expect(text.includes('Read-only mode is on')).toBe(readOnly);
    }
  });

  it('tells the leader the read-only boundary too, so it never plans an action', async () => {
    for (const readOnly of [true, false] as const) {
      const { leader } = await harness({
        maxSteps: 1,
        ...(readOnly ? { readOnly: true } : {}),
        follower: () => ({ kind: 'tool', name: 'done', args: { summary: 'done' } }),
      });
      const first = leader.calls[0]!;
      const text = JSON.stringify(first.messages.map((m) => m.content));
      expect(text.includes('Read-only mode is on')).toBe(readOnly);
      if (readOnly) expect(text).toContain('never a subgoal that needs an action');
    }
  });

  it('a read-only follower that tries to click learns the tool does not exist', async () => {
    // Belt and braces with the runtime refusal: the tool is not bound, so the
    // call fails as unknown-tool — and one failure is not a repeat loop.
    const { ended } = await harness({
      maxSteps: 4,
      readOnly: true,
      follower: (call) =>
        call.index === 0
          ? { kind: 'tool', name: 'click', args: { ref: 'e1' } }
          : { kind: 'tool', name: 'done', args: { summary: 'done' } },
    });
    expect(ended).toMatchObject({ status: 'done', steps: 2 });
  });
});
