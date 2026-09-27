/**
 * Direct schema/routing tests for `src/agent/tools.ts`.
 *
 * No test file existed for this module before: every Follower tool's zod schema
 * (bounds, enums, required fields) was previously exercised only incidentally,
 * through `FakeChatModel` turns in `graph.test.ts` that always supply
 * well-formed args. This file drives `createPageToolset` and `planTool`
 * directly via `.invoke()`, which is the real LangChain validation path (it
 * parses input against the tool's schema before calling the underlying
 * function — see `@langchain/core/tools`), so a malformed/wrong-typed/missing
 * argument here is rejected by the same code path a real model's tool call
 * would go through.
 */
import { describe, expect, it } from 'vitest';
import {
  createPageToolset,
  FakePageTools,
  FollowerSignalSchema,
  planTool,
  summarize,
  toolResultText,
  MAX_TOOL_RESULT_CHARS,
  TERMINAL_TOOLS,
  TOOL_NAMES,
} from './tools';

function toolset() {
  const page = new FakePageTools();
  const { all, byName } = createPageToolset(page);
  return { page, all, byName };
}

describe('createPageToolset: schema validation rejects bad model output', () => {
  it('click rejects a missing ref', async () => {
    const { byName } = toolset();
    await expect(byName.get('click')!.invoke({})).rejects.toThrow();
  });

  it('click rejects a non-string ref', async () => {
    const { byName } = toolset();
    await expect(byName.get('click')!.invoke({ ref: 123 })).rejects.toThrow();
  });

  it('hover rejects a missing ref', async () => {
    const { byName } = toolset();
    await expect(byName.get('hover')!.invoke({})).rejects.toThrow();
  });

  it('hover routes to the hover tool and reports what it hovered', async () => {
    const { byName, page } = toolset();
    const result = await byName.get('hover')!.invoke({ ref: 'e9' });
    expect(String(result)).toContain('e9');
    expect(page.calls).toContainEqual({ name: 'hover', args: ['e9'] });
  });

  it('type rejects a missing text field', async () => {
    const { byName } = toolset();
    await expect(byName.get('type')!.invoke({ ref: 'e1' })).rejects.toThrow();
  });

  it('wait accepts the boundary values 0 and 15000', async () => {
    const { byName, page } = toolset();
    await byName.get('wait')!.invoke({ ms: 0 });
    await byName.get('wait')!.invoke({ ms: 15000 });
    expect(page.calls.filter((c) => c.name === 'wait').map((c) => c.args)).toEqual([[0], [15000]]);
  });

  it('wait rejects ms below 0, above 15000, and non-integer', async () => {
    const { byName } = toolset();
    await expect(byName.get('wait')!.invoke({ ms: -1 })).rejects.toThrow();
    await expect(byName.get('wait')!.invoke({ ms: 15001 })).rejects.toThrow();
    await expect(byName.get('wait')!.invoke({ ms: 1.5 })).rejects.toThrow();
    await expect(byName.get('wait')!.invoke({ ms: 'soon' })).rejects.toThrow();
  });

  it('wait rejects a missing ms field entirely', async () => {
    const { byName } = toolset();
    await expect(byName.get('wait')!.invoke({})).rejects.toThrow();
  });

  it('the control envelope signal must be one of the four verbatim values', async () => {
    const { byName } = toolset();
    await expect(byName.get('click')!.invoke({ ref: 'e1', signal: 'MAYBE' })).rejects.toThrow();
    await byName.get('click')!.invoke({ ref: 'e1', signal: 'BLOCKED' });
    await byName.get('click')!.invoke({ ref: 'e1' }); // signal is optional (absent means CONTINUE)
  });

  it('done requires a summary and blocked requires a reason', async () => {
    const { byName } = toolset();
    await expect(byName.get('done')!.invoke({})).rejects.toThrow();
    await expect(byName.get('blocked')!.invoke({})).rejects.toThrow();
    await byName.get('done')!.invoke({ summary: 'ok' });
    await byName.get('blocked')!.invoke({ reason: 'stuck' });
  });

  it('select requires both ref and value', async () => {
    const { byName } = toolset();
    await expect(byName.get('select')!.invoke({ ref: 'e1' })).rejects.toThrow();
    await expect(byName.get('select')!.invoke({ value: 'x' })).rejects.toThrow();
    await byName.get('select')!.invoke({ ref: 'e1', value: 'x' });
  });

  it('navigate and download and run_userscript reject a missing single string field', async () => {
    const { byName } = toolset();
    await expect(byName.get('navigate')!.invoke({})).rejects.toThrow();
    await expect(byName.get('download')!.invoke({})).rejects.toThrow();
    await expect(byName.get('run_userscript')!.invoke({})).rejects.toThrow();
  });

  it('press requires a key', async () => {
    const { byName } = toolset();
    await expect(byName.get('press')!.invoke({})).rejects.toThrow();
    await byName.get('press')!.invoke({ key: 'Enter' });
  });

  it('scroll requires a target', async () => {
    const { byName } = toolset();
    await expect(byName.get('scroll')!.invoke({})).rejects.toThrow();
    await byName.get('scroll')!.invoke({ target: 'down' });
  });

  it('snapshot, screenshot and extract_text accept an empty object (only the optional control envelope)', async () => {
    const { byName } = toolset();
    await byName.get('snapshot')!.invoke({});
    await byName.get('screenshot')!.invoke({});
    await byName.get('extract_text')!.invoke({});
  });

  it('extract_text rejects maxChars below 1, above 60000, and non-integer', async () => {
    const { byName } = toolset();
    await expect(byName.get('extract_text')!.invoke({ maxChars: 0 })).rejects.toThrow();
    await expect(byName.get('extract_text')!.invoke({ maxChars: 60_001 })).rejects.toThrow();
    await expect(byName.get('extract_text')!.invoke({ maxChars: 1.5 })).rejects.toThrow();
    await byName.get('extract_text')!.invoke({ maxChars: 60_000 });
  });

  it('save_file accepts a JSON array, which is what an extracted list actually is', async () => {
    // Regression: content was string-or-object, so every live save of a listing
    // array failed with "Received tool input did not match expected schema -> at content".
    const { byName } = createPageToolset(new FakePageTools());
    const rows = [{ title: 'DDR5 32GB', price: '$99.00' }, { title: 'DDR5 16GB', price: '$49.00' }];

    const result = await byName.get('save_file')!.invoke({ filename: 'rows.json', content: rows });
    expect(String(result)).toContain('rows.json');
  });

  it('save_file requires a well-formed filename', async () => {
    const { byName } = toolset();
    await expect(byName.get('save_file')!.invoke({ filename: '', content: 'x' })).rejects.toThrow();
    await expect(byName.get('save_file')!.invoke({ filename: 'a/b.json', content: 'x' })).rejects.toThrow();
    await expect(byName.get('save_file')!.invoke({ filename: '../evil.json', content: 'x' })).rejects.toThrow();
    await expect(byName.get('save_file')!.invoke({ filename: '.hidden.json', content: 'x' })).rejects.toThrow();
    await expect(byName.get('save_file')!.invoke({ filename: 'result.exe', content: 'x' })).rejects.toThrow();
    await expect(
      byName.get('save_file')!.invoke({ filename: `${'x'.repeat(97)}.json`, content: 'x' }),
    ).rejects.toThrow();
  });

  it('save_file requires content unless fromLastUserscript is true', async () => {
    const { byName, page } = toolset();
    await expect(byName.get('save_file')!.invoke({ filename: 'a.json' })).rejects.toThrow();
    await byName.get('save_file')!.invoke({ filename: 'a.json', fromLastUserscript: true });
    expect(page.calls.at(-1)).toEqual({ name: 'saveFile', args: ['a.json', undefined, true] });
  });

  it('save_file JSON.stringifies an object argument with 2-space indent', async () => {
    const { byName, page } = toolset();
    await byName.get('save_file')!.invoke({ filename: 'a.json', content: { a: 1, b: [2, 3] } });
    expect(page.calls.at(-1)).toEqual({
      name: 'saveFile',
      args: ['a.json', JSON.stringify({ a: 1, b: [2, 3] }, null, 2), false],
    });
  });

  it('save_file passes a string argument through unchanged', async () => {
    const { byName, page } = toolset();
    await byName.get('save_file')!.invoke({ filename: 'a.txt', content: 'plain text' });
    expect(page.calls.at(-1)).toEqual({ name: 'saveFile', args: ['a.txt', 'plain text', false] });
  });

  it('extra, unrecognised fields on a well-formed call do not by themselves break the call', async () => {
    // Zod object schemas are not `.strict()` here, so a model that adds a stray
    // field (a common small-model failure mode) must not lose the whole action.
    const { byName, page } = toolset();
    await byName.get('click')!.invoke({ ref: 'e1', signal: 'CONTINUE', note: 'ok', extra: 'ignored' } as never);
    expect(page.calls).toEqual([{ name: 'click', args: ['e1'] }]);
  });
});

describe('createPageToolset: every valid call routes to the matching PageTools method with the right args', () => {
  it('routes every tool to its PageTools method exactly once, in order', async () => {
    const { byName, page } = toolset();
    await byName.get('click')!.invoke({ ref: 'e1' });
    await byName.get('hover')!.invoke({ ref: 'e1b' });
    await byName.get('get_box')!.invoke({ ref: 'e1c' });
    await byName.get('type')!.invoke({ ref: 'e2', text: 'hi' });
    await byName.get('press')!.invoke({ key: 'Enter' });
    await byName.get('scroll')!.invoke({ target: 'down' });
    await byName.get('select')!.invoke({ ref: 'e3', value: 'v' });
    await byName.get('navigate')!.invoke({ url: 'https://x.test/' });
    await byName.get('download')!.invoke({ target: 'https://x.test/f.pdf' });
    await byName.get('run_userscript')!.invoke({ scriptId: 's1' });
    await byName.get('save_file')!.invoke({ filename: 'a.json', content: 'x' });
    await byName.get('extract_text')!.invoke({ maxChars: 100 });
    await byName.get('wait')!.invoke({ ms: 5 });
    await byName.get('done')!.invoke({ summary: 'done' });
    await byName.get('blocked')!.invoke({ reason: 'stuck' });

    expect(page.calls).toEqual([
      { name: 'click', args: ['e1'] },
      { name: 'hover', args: ['e1b'] },
      { name: 'getBox', args: ['e1c'] },
      { name: 'type', args: ['e2', 'hi'] },
      { name: 'press', args: ['Enter'] },
      { name: 'scroll', args: ['down'] },
      { name: 'select', args: ['e3', 'v'] },
      { name: 'navigate', args: ['https://x.test/'] },
      { name: 'download', args: ['https://x.test/f.pdf'] },
      { name: 'runUserscript', args: ['s1'] },
      { name: 'saveFile', args: ['a.json', 'x', false] },
      // startChar rides along undefined when the model does not ask to resume.
      { name: 'extractText', args: [100, undefined] },
      { name: 'wait', args: [5] },
      { name: 'done', args: ['done'] },
      { name: 'blocked', args: ['stuck'] },
    ]);
  });

  it('every declared tool name in TOOL_NAMES is present exactly once in byName and all', () => {
    const { all, byName } = toolset();
    expect(all.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(byName.size).toBe(TOOL_NAMES.length);
    for (const name of TOOL_NAMES) expect(byName.get(name)).toBeDefined();
  });

  it('a read-only toolset binds no acting tool', () => {
    const { all, byName } = createPageToolset(new FakePageTools(), { readOnly: true });
    expect(all.map((t) => t.name)).not.toContain('click');
    for (const blocked of ['click', 'hover', 'type', 'press', 'select', 'download', 'write_userscript']) {
      expect(byName.get(blocked)).toBeUndefined();
    }
    // Reads, navigation, the terminal tools, and the read-only userscript loop stay.
    for (const kept of ['snapshot', 'screenshot', 'extract_text', 'get_box', 'scroll', 'navigate', 'run_userscript', 'list_userscripts', 'read_userscript', 'save_file', 'wait', 'done', 'blocked']) {
      expect(byName.get(kept)).toBeDefined();
    }
    expect(byName.size).toBe(all.length);
  });
});

describe('planTool (the Leader\'s only tool)', () => {
  it('requires at least one subgoal', async () => {
    await expect(planTool.invoke({ plan: 'do the thing', subgoals: [] })).rejects.toThrow();
  });

  it('requires plan and subgoals', async () => {
    await expect(planTool.invoke({ subgoals: ['a'] } as never)).rejects.toThrow();
    await expect(planTool.invoke({ plan: 'x' } as never)).rejects.toThrow();
  });

  it('currentSubgoal defaults to 0 and rejects a negative index', async () => {
    const result = await planTool.invoke({ plan: 'x', subgoals: ['a', 'b'] });
    expect(result).toContain('plan recorded');
    await expect(planTool.invoke({ plan: 'x', subgoals: ['a'], currentSubgoal: -1 })).rejects.toThrow();
    await expect(planTool.invoke({ plan: 'x', subgoals: ['a'], currentSubgoal: 1.5 })).rejects.toThrow();
  });
});

describe('FollowerSignalSchema', () => {
  it('accepts exactly the four verbatim R-03 values and nothing else', () => {
    for (const v of ['CONTINUE', 'SUBGOAL_COMPLETE', 'RETURN_TO_LEADER', 'BLOCKED']) {
      expect(FollowerSignalSchema.safeParse(v).success).toBe(true);
    }
    expect(FollowerSignalSchema.safeParse('continue').success).toBe(false);
    expect(FollowerSignalSchema.safeParse('').success).toBe(false);
    expect(FollowerSignalSchema.safeParse(undefined).success).toBe(false);
  });
});

describe('TERMINAL_TOOLS', () => {
  it('names exactly done and blocked as run-ending tools', () => {
    expect(TERMINAL_TOOLS).toEqual({ done: 'done', blocked: 'blocked' });
  });
});

describe('summarize', () => {
  it('passes short strings through unchanged', () => {
    expect(summarize('hello')).toBe('hello');
  });

  it('truncates with an ellipsis at exactly max length', () => {
    const long = 'x'.repeat(300);
    const out = summarize(long, 10);
    expect(out).toHaveLength(10);
    expect(out.endsWith('…')).toBe(true);
    expect(out.startsWith('x'.repeat(9))).toBe(true);
  });

  it('a string exactly at max is left unchanged, one over is truncated', () => {
    expect(summarize('x'.repeat(5), 5)).toBe('x'.repeat(5));
    expect(summarize('x'.repeat(6), 5)).toHaveLength(5);
  });

  it('stringifies a non-string value', () => {
    expect(summarize({ a: 1 })).toBe('{"a":1}');
  });

  it('falls back to String() for a value JSON.stringify cannot render', () => {
    expect(summarize(undefined)).toBe('undefined');
  });
});

describe('toolResultText', () => {
  it('passes a result far longer than the log summary through untouched', () => {
    const long = 'y'.repeat(10_000);
    expect(toolResultText(long)).toBe(long);
    // The whole point: what the log keeps and what the model reads are different sizes.
    expect(summarize(long).length).toBeLessThan(long.length);
  });

  it('says how much it cut, on its own line, so the model can ask for the rest', () => {
    const long = 'z'.repeat(MAX_TOOL_RESULT_CHARS + 500);
    const out = toolResultText(long);
    expect(out.startsWith('z'.repeat(MAX_TOOL_RESULT_CHARS))).toBe(true);
    expect(out).toContain(`[tool result truncated at ${MAX_TOOL_RESULT_CHARS} of ${long.length} characters]`);
  });

  it('leaves a result exactly at the ceiling alone', () => {
    const exact = 'q'.repeat(MAX_TOOL_RESULT_CHARS);
    expect(toolResultText(exact)).toBe(exact);
  });

  it('stringifies a non-string result', () => {
    expect(toolResultText({ a: 1 })).toBe('{"a":1}');
    expect(toolResultText(undefined)).toBe('undefined');
  });
});
