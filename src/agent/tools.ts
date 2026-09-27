/**
 * Page tools the graph depends on.
 *
 * Nothing in `src/agent` may import `chrome.*`. The graph talks to the page only
 * through the {@link PageTools} port; the service worker supplies the real
 * implementation and tests supply {@link FakePageTools}.
 *
 * Every tool is a LangChain `tool()` with a zod schema (C-02: the framework's own
 * tool-calling machinery, not a hand-rolled dispatcher). Descriptions are written
 * for small free models: one imperative sentence, then the argument contract.
 *
 * `navigate` and `download` are Follower tools per O-05's assumption.
 */
import * as z from 'zod';
import { tool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { FollowerSignal } from '@/src/messaging/contract';
import type { ObserveMode } from '@/src/storage';
import { allowedInReadOnly } from './policy';

/** Zod mirror of the contract's {@link FollowerSignal} (R-03, verbatim vocabulary). */
export const FollowerSignalSchema = z.enum([
  'CONTINUE',
  'SUBGOAL_COMPLETE',
  'RETURN_TO_LEADER',
  'BLOCKED',
]);

// Compile-time proof the mirror never drifts from the contract.
const _signalParity: FollowerSignal = 'CONTINUE' satisfies z.infer<typeof FollowerSignalSchema>;
void _signalParity;

export interface SnapshotResult {
  text: string;
  tokens?: number;
}

export interface ScreenshotResult {
  dataUrl: string;
  width: number;
  height: number;
}

/** Viewport box of one element, in CSS pixels (the space `InputTier` acts in). */
export interface ElementBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Scroll target: a direction keyword or an element ref from the snapshot. */
export type ScrollTarget = 'up' | 'down' | 'top' | 'bottom' | (string & {});

/** One `write_userscript` call: create when `scriptId` is absent, revise when present. */
export interface WriteUserscriptRequest {
  scriptId?: string;
  name: string;
  matches: string[];
  code: string;
}

/**
 * The page port. One method per capability the Follower can exercise.
 * Implementations live outside `src/agent`.
 */
export interface PageTools {
  snapshot(): Promise<SnapshotResult>;
  screenshot(): Promise<ScreenshotResult>;
  extractText(maxChars?: number, startChar?: number): Promise<string>;
  /** Viewport box of one ref, so `both` mode can correlate refs to screenshot regions. */
  getBox(ref: string): Promise<ElementBox>;
  click(ref: string): Promise<string>;
  hover(ref: string): Promise<string>;
  type(ref: string, text: string): Promise<string>;
  press(key: string): Promise<string>;
  scroll(target: ScrollTarget): Promise<string>;
  select(ref: string, value: string): Promise<string>;
  navigate(url: string): Promise<string>;
  download(target: string): Promise<string>;
  runUserscript(scriptId: string, args?: Record<string, unknown>): Promise<string>;
  /** Lists the saved scripts so the Follower knows what ids exist (R-09). */
  listUserscripts(): Promise<string>;
  /** The source of one saved script, bundled seeds included. */
  readUserscript(idOrName: string): Promise<string>;
  /**
   * Creates or revises an agent-authored script (R-10/O-03). The rails on what an
   * agent may write live in `src/userscripts/authoring.ts`, not here; this port
   * just carries the request and returns whatever the write path reports.
   */
  writeUserscript(request: WriteUserscriptRequest): Promise<string>;
  /**
   * Saves `content` (or, when `fromLastUserscript` is true, the full untruncated
   * result of the most recent `run_userscript` call) as a file. `content` has
   * already been normalised to a string by {@link createPageToolset} (an object arg
   * is JSON.stringify'd there); the runtime implementation owns where it lands.
   */
  saveFile(filename: string, content: string | undefined, fromLastUserscript: boolean): Promise<string>;
  wait(ms: number): Promise<string>;
  done(summary: string): Promise<string>;
  blocked(reason: string): Promise<string>;
}

/**
 * The control envelope carried on every Follower tool call.
 *
 * R-03 wants the Follower to return control on its own signal. The signal rides
 * on the arguments of the action the Follower is already taking, so one model
 * call yields both the action and the classification — no second LLM round trip.
 * Both fields are optional so a small model that omits them still produces a
 * valid call (absent signal means CONTINUE).
 */
const controlEnvelope = {
  signal: FollowerSignalSchema.optional().describe(
    'Your control state after this action. CONTINUE = keep working on the current subgoal. ' +
      'SUBGOAL_COMPLETE = this subgoal is finished. RETURN_TO_LEADER = you need a new plan. ' +
      'BLOCKED = you cannot proceed at all. Leave empty to mean CONTINUE.',
  ),
  note: z.string().optional().describe('One short sentence saying why. Max 20 words.'),
};

const refField = z
  .string()
  .describe('The element ref exactly as it appears in the page snapshot, e.g. "e12".');

/**
 * `save_file`'s filename contract, enforced here so a bad filename never reaches
 * either save mechanism (chrome.downloads and the host's artifact.save): basename
 * only, an allowed extension, no path separator, no "..", no leading dot, not too
 * long. Returns the problem, or `undefined` when the filename is fine.
 */
export function validateSaveFilename(filename: string): string | undefined {
  if (typeof filename !== 'string' || filename.length === 0) return 'filename must be a non-empty string';
  if (filename.length > 100) return 'filename must be at most 100 characters';
  if (filename.includes('/') || filename.includes('\\')) return 'filename must not contain a path separator';
  if (filename.includes('..')) return 'filename must not contain ".."';
  if (filename.startsWith('.')) return 'filename must not start with a dot';
  if (!/\.(json|txt|csv)$/i.test(filename)) return 'filename must end in .json, .txt, or .csv';
  return undefined;
}

/** Tool names the Follower may call. Kept as a const tuple so the graph can switch on it. */
export const TOOL_NAMES = [
  'snapshot',
  'screenshot',
  'extract_text',
  'get_box',
  'click',
  'hover',
  'type',
  'press',
  'scroll',
  'select',
  'navigate',
  'download',
  'run_userscript',
  'list_userscripts',
  'read_userscript',
  'write_userscript',
  'save_file',
  'wait',
  'done',
  'blocked',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/** Tools whose call ends the run regardless of the reported signal. */
export const TERMINAL_TOOLS: Record<string, 'done' | 'blocked'> = {
  done: 'done',
  blocked: 'blocked',
};

/**
 * Tools that only read. Their success is not evidence the page changed, so it does
 * not reset the repeat-failure counter in `src/agent/graph.ts`. Everything else that
 * succeeds counts as progress. `wait` is here too: pausing performs no action, so a
 * failure alternating with waits is still the same futile loop. `save_file` writes
 * a local artifact, not page state, so alternating it with a failing page action is
 * the same loop wearing a different hat.
 */
export const READ_TOOL_NAMES: ReadonlySet<string> = new Set([
  'read_userscript',
  'snapshot',
  'screenshot',
  'extract_text',
  'get_box',
  'list_userscripts',
  'wait',
  'save_file',
]);

export interface PageToolset {
  /** Every Follower tool, in the order the model sees them. */
  all: StructuredToolInterface[];
  byName: Map<string, StructuredToolInterface>;
}

/** Keeps a tool result short enough for the UI log (R-06) without echoing payloads. */
export function summarize(value: unknown, max = 240): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Ceiling on what one tool result may add to the model's context.
 *
 * Deliberately equal to the largest amount any tool will produce (`extract_text`'s
 * `maxChars` maximum, and `run_userscript`'s own result cap), so this is a backstop
 * and never the binding constraint. A graph-level cap tighter than a tool's own
 * advertised limit is a second, hidden truncation: `extract_text` documents up to
 * 60000 characters and appends its "call again with startChar N" hint at the *end*
 * of the string, so anything that trims below the tool's limit also removes the
 * instruction telling the model how to recover.
 */
export const MAX_TOOL_RESULT_CHARS = 60_000;

/**
 * The text of a tool result as the *model* sees it.
 *
 * Separate from {@link summarize}, which exists for the run log. The graph used to
 * put the 240-character log summary into the ToolMessage as well, so no tool could
 * return more than 240 characters to the model however much it had been asked for.
 * When this does have to cut, it says so on its own line at the end, with the real
 * length, rather than trailing off in an ellipsis the model cannot act on.
 */
export function toolResultText(value: unknown, max = MAX_TOOL_RESULT_CHARS): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[tool result truncated at ${max} of ${text.length} characters]`;
}

/**
 * Builds the Follower toolset over a {@link PageTools} implementation.
 *
 * In a read-only run (#13) the acting tools are not bound at all: the model
 * cannot even see them, so it learns the boundary from the tool list rather
 * than from refusals. The runtime refuses them in depth anyway
 * (`src/runtime/pageTools.ts`) in case the shapes ever drift apart.
 */
export function createPageToolset(page: PageTools, options: { readOnly?: boolean } = {}): PageToolset {
  const all: StructuredToolInterface[] = [
    tool(
      async () => {
        const snap = await page.snapshot();
        return snap.text;
      },
      {
        name: 'snapshot',
        description:
          'Read the page as text with a ref for every element you can act on. ' +
          'Call this when you do not know what is on the page or after it changed.',
        schema: z.object({ ...controlEnvelope }),
      },
    ),
    tool(
      async () => {
        const shot = await page.screenshot();
        return `screenshot ${shot.width}x${shot.height}`;
      },
      {
        name: 'screenshot',
        description:
          'Take a picture of the visible page. Use only when the text snapshot is not enough.',
        schema: z.object({ ...controlEnvelope }),
      },
    ),
    tool(async ({ maxChars, startChar }) => page.extractText(maxChars, startChar), {
      name: 'extract_text',
      description:
        'Read the page as plain readable text instead of a structured snapshot. Use this for ' +
        'long lists or articles where you only need to read, not act on refs. Links become ' +
        '"text (href)".',
      schema: z.object({
        maxChars: z
          .number()
          .int()
          .min(1)
          .max(60_000)
          .optional()
          .describe('Character cap on the returned text. Default 20000, max 60000.'),
        startChar: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            'Start reading from this offset. When a reply ends "[truncated at N of M]", ' +
              'call again with startChar N to read the rest.',
          ),
        ...controlEnvelope,
      }),
    }),
    tool(async ({ ref }) => page.click(ref), {
      name: 'click',
      description: 'Click one element. Give the ref from the snapshot, nothing else.',
      schema: z.object({ ref: refField, ...controlEnvelope }),
    }),
    tool(async ({ ref }) => JSON.stringify(await page.getBox(ref)), {
      name: 'get_box',
      description:
        'Get the viewport box of one element as JSON {x, y, width, height} in CSS pixels. ' +
        'Use this with a screenshot to correlate a ref to the region you see.',
      schema: z.object({ ref: refField, ...controlEnvelope }),
    }),
    tool(async ({ ref }) => page.hover(ref), {
      name: 'hover',
      description:
        'Move the pointer over one element without clicking, e.g. to open a hover menu ' +
        'before clicking something inside it. Give the ref from the snapshot.',
      schema: z.object({ ref: refField, ...controlEnvelope }),
    }),
    tool(async ({ ref, text }) => page.type(ref, text), {
      name: 'type',
      description:
        'Type text into one field. Give the ref of the field and the exact text to enter. ' +
        'This replaces whatever is already in the field.',
      schema: z.object({
        ref: refField,
        text: z.string().describe('The literal text to enter.'),
        ...controlEnvelope,
      }),
    }),
    tool(async ({ key }) => page.press(key), {
      name: 'press',
      description:
        'Press one keyboard key, e.g. "Enter", "Tab", "Escape", "ArrowDown". One key per call.',
      schema: z.object({
        key: z.string().describe('A single key name such as "Enter".'),
        ...controlEnvelope,
      }),
    }),
    tool(async ({ target }) => page.scroll(target), {
      name: 'scroll',
      description:
        'Scroll the page. Give "up", "down", "top", "bottom", or an element ref to scroll it into view.',
      schema: z.object({
        target: z
          .string()
          .describe('"up", "down", "top", "bottom", or an element ref like "e12".'),
        ...controlEnvelope,
      }),
    }),
    tool(async ({ ref, value }) => page.select(ref, value), {
      name: 'select',
      description: 'Choose an option in a dropdown. Give the ref of the select and the option text.',
      schema: z.object({
        ref: refField,
        value: z.string().describe('The visible option text or its value.'),
        ...controlEnvelope,
      }),
    }),
    tool(async ({ url }) => page.navigate(url), {
      name: 'navigate',
      description:
        'Go to a URL in the tab the user already has open. Use a full URL starting with http.',
      schema: z.object({
        url: z.string().describe('Full URL, e.g. "https://example.com/search".'),
        ...controlEnvelope,
      }),
    }),
    tool(async ({ target }) => page.download(target), {
      name: 'download',
      description:
        'Download a file. Give a full URL, or the ref of the link or button that starts the download.',
      schema: z.object({
        target: z.string().describe('A full URL or an element ref like "e12".'),
        ...controlEnvelope,
      }),
    }),
    tool(async ({ scriptId, args }) => (args === undefined ? page.runUserscript(scriptId) : page.runUserscript(scriptId, args)), {
      name: 'run_userscript',
      description:
        'Run a saved userscript on this page by its id. The reply gives you the summary the script ' +
        'returned plus anything it logged; rows are saved with save_file, not pasted here. ' +
        'If it failed you get the error and the line. Read the source with read_userscript first. ' +
        'Pass args to shorten a long script, for example {"limitQueries":1,"pages":1}.',
      schema: z.object({
        scriptId: z.string().describe('The id of a saved userscript.'),
        args: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Optional JSON the script sees as args. Omit it to run the script\'s full config.'),
        ...controlEnvelope,
      }),
    }),
    tool(async () => page.listUserscripts(), {
      name: 'list_userscripts',
      description: 'List the saved userscripts with their ids, so you know what run_userscript can take.',
      schema: z.object({ ...controlEnvelope }),
    }),
    tool(async ({ idOrName }) => page.readUserscript(idOrName), {
      name: 'read_userscript',
      description:
        'Read the source of a saved userscript, including a bundled one, before you run or copy it. ' +
        'Pass the id, or the name when only one script has it.',
      schema: z.object({
        idOrName: z.string().describe('The id from list_userscripts, or an unambiguous name.'),
        ...controlEnvelope,
      }),
    }),
    tool(async ({ scriptId, name, matches, code }) => page.writeUserscript({ scriptId, name, matches, code }), {
      name: 'write_userscript',
      description:
        'Write a small script that runs on the page, for reading data that would cost many ' +
        'steps to click through. Your code is the body of an async function: hand back your ' +
        'result with a top-level return, and use console.log to trace what it saw. Then call ' +
        'run_userscript with the id you get back. If it fails, call this again with the same ' +
        'scriptId and fixed code.',
      schema: z.object({
        name: z.string().describe('Short name, e.g. "chatgpt-thread-titles".'),
        matches: z
          .array(z.string())
          .min(1)
          .describe(
            'Which pages it may run on, e.g. ["*://chatgpt.com/*"]. Write each host out ' +
              'in full; a wildcard host like "*" or "*.com" is refused. List several ' +
              'patterns if you mean several hosts.',
          ),
        code: z
          .string()
          .describe('The script body. End with "return <your result>;". No function wrapper.'),
        scriptId: z
          .string()
          .optional()
          .describe('Leave empty to create. Pass the id of a script you wrote to replace it.'),
        ...controlEnvelope,
      }),
    }),
    tool(
      async ({ filename, content, fromLastUserscript }) => {
        const problem = validateSaveFilename(filename);
        if (problem) throw new Error(problem);
        if (!fromLastUserscript && content === undefined) {
          throw new Error('content is required unless fromLastUserscript is true');
        }
        const body =
          content === undefined ? undefined : typeof content === 'string' ? content : JSON.stringify(content, null, 2);
        return page.saveFile(filename, body, fromLastUserscript ?? false);
      },
      {
        name: 'save_file',
        description:
          'Save data to a file in the user\'s Downloads/nanobrowser folder. Give it a filename ' +
          'ending .json, .txt or .csv and either content, or fromLastUserscript:true to save the ' +
          'full result of the most recent run_userscript call losslessly.',
        schema: z.object({
          filename: z
            .string()
            .describe('Basename only, ending .json, .txt or .csv, e.g. "ddr5-current.json".'),
          content: z
            // An array has to be here in its own right: the natural thing to save is a
            // list of extracted rows, and a bare `z.record` rejects one. A live run
            // failed every save with "Invalid input -> at content" for exactly that.
            .union([z.string(), z.array(z.unknown()), z.record(z.string(), z.unknown())])
            .optional()
            .describe('The data to save: text, or a JSON array or object, written as 2-space-indented JSON.'),
          fromLastUserscript: z
            .boolean()
            .optional()
            .describe('Save the full result of the last run_userscript call verbatim, ignoring content.'),
          ...controlEnvelope,
        }),
      },
    ),
    tool(async ({ ms }) => page.wait(ms), {
      name: 'wait',
      description:
        'Wait for the page to settle. Use only after an action that loads new content. Keep it short.',
      schema: z.object({
        ms: z.number().int().min(0).max(15000).describe('Milliseconds to wait, at most 15000.'),
        ...controlEnvelope,
      }),
    }),
    tool(async ({ summary }) => page.done(summary), {
      name: 'done',
      description:
        'The whole objective is finished. Say what was accomplished. This ends the run.',
      schema: z.object({
        summary: z.string().describe('What was accomplished, in one or two sentences.'),
        ...controlEnvelope,
      }),
    }),
    tool(async ({ reason }) => page.blocked(reason), {
      name: 'blocked',
      description:
        'You cannot go any further, e.g. a login wall or a missing element. Say why. This ends the run.',
      schema: z.object({
        reason: z.string().describe('Why you are stuck, in one sentence.'),
        ...controlEnvelope,
      }),
    }),
  ];

  if (!options.readOnly) return { all, byName: new Map(all.map((t) => [t.name, t])) };
  const readOnlyAll = all.filter((t) => allowedInReadOnly(t.name));
  return { all: readOnlyAll, byName: new Map(readOnlyAll.map((t) => [t.name, t])) };
}

/**
 * The Leader's only tool. Planning is expressed as a tool call rather than as
 * JSON-mode structured output because most of the free models in
 * `docs/research/models-and-grounding.md` advertise `tools` but not
 * `structured_outputs`.
 */
export const planTool = tool(
  async ({ plan }) => `plan recorded: ${summarize(plan, 80)}`,
  {
    name: 'set_plan',
    description:
      'Record the plan for the objective and pick the subgoal the follower should work on now. ' +
      'Always call this exactly once. Keep subgoals short and concrete.',
    schema: z.object({
      plan: z.string().describe('One short paragraph: how the objective will be achieved.'),
      subgoals: z
        .array(z.string())
        .min(1)
        .describe('Ordered list of short concrete subgoals, e.g. "open the search page".'),
      currentSubgoal: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe('Zero-based index into subgoals of the one to work on now.'),
    }),
  },
);

/**
 * How many observation reads the Leader may pull per replan (M4).
 *
 * The reads exist so a replan can check what actually happened — "pull
 * evidence" — not so the Leader can drive the page step by step as a second
 * Follower. A weak model that spends its whole turn reading never replans, so
 * the graph refuses reads past this cap and tells it to call `set_plan`.
 */
export const LEADER_READ_CAP = 2;

/** Names of the Leader's read tools. Distinct from the Follower's so the run
 * log never confuses who observed what (the `role` field agrees with the name). */
export const LEADER_READ_TOOL_NAMES = ['leader_snapshot', 'leader_screenshot', 'leader_extract_text'] as const;

export type LeaderReadToolName = (typeof LEADER_READ_TOOL_NAMES)[number];

/**
 * The page reads the Leader may pull. A subset of {@link PageTools} — reads
 * only, and no `run_userscript`: a script can write page state, and which
 * scripts are read-only is the M9 policy question, still open.
 */
export interface LeaderReads {
  snapshot(): Promise<SnapshotResult>;
  screenshot(): Promise<ScreenshotResult>;
  extractText(maxChars?: number, startChar?: number): Promise<string>;
}

/**
 * The Leader's read-only observation subset, bound alongside {@link planTool}.
 *
 * Filtered by the run's observe mode like the Follower's own observations: a `dom`
 * run must not send screenshots anywhere, and a `pixels` run must not send DOM
 * text. Absent mode binds everything (callers that predate the filter).
 */
export function createLeaderReadTools(
  page: LeaderReads,
  options: { observe?: ObserveMode } = {},
): StructuredToolInterface[] {
  const observe = options.observe ?? 'both';
  const tools: StructuredToolInterface[] = [];
  if (observe !== 'pixels') {
    tools.push(
      tool(async () => (await page.snapshot()).text, {
        name: 'leader_snapshot',
        description:
          'Read the page as text once, to check what actually happened before re-planning. ' +
          'This pulls evidence for the plan; it does not act. At most 2 reads per turn.',
        schema: z.object({}),
      }),
    );
  }
  if (observe !== 'dom') {
    tools.push(
      tool(
        async () => {
          const shot = await page.screenshot();
          return `screenshot ${shot.width}x${shot.height}`;
        },
        {
          name: 'leader_screenshot',
          description:
            'Look at the visible page once, to check what actually happened before re-planning. ' +
            'This pulls evidence for the plan; it does not act. At most 2 reads per turn.',
          schema: z.object({}),
        },
      ),
    );
  }
  if (observe !== 'pixels') {
    tools.push(
      tool(async ({ maxChars, startChar }) => page.extractText(maxChars, startChar), {
        name: 'leader_extract_text',
        description:
          'Read the page as plain text once, to check what actually happened before re-planning. ' +
          'This pulls evidence for the plan; it does not act. At most 2 reads per turn.',
        schema: z.object({
          maxChars: z.number().int().min(1).max(60_000).optional()
            .describe('Character cap on the returned text. Default 20000, max 60000.'),
          startChar: z.number().int().min(0).optional()
            .describe('Start reading from this offset.'),
        }),
      }),
    );
  }
  return tools;
}

/* ------------------------------------------------------------------------- */
/* Test double                                                               */
/* ------------------------------------------------------------------------- */

export interface RecordedToolCall {
  name: keyof PageTools;
  args: unknown[];
}

export interface FakePageToolsInit {
  /** Snapshots handed out in order; the last one repeats once exhausted. */
  snapshots?: SnapshotResult[];
  /** Screenshots handed out in order; the last one repeats once exhausted. */
  screenshots?: ScreenshotResult[];
}

/** Records every call and returns scripted observations. Never touches a browser. */
export class FakePageTools implements PageTools {
  readonly calls: RecordedToolCall[] = [];

  #snapshots: SnapshotResult[];
  #screenshots: ScreenshotResult[];
  #snapshotIndex = 0;
  #screenshotIndex = 0;

  constructor(init: FakePageToolsInit = {}) {
    this.#snapshots = init.snapshots?.length
      ? init.snapshots
      : [{ text: 'page: [e1] link "Example"', tokens: 8 }];
    this.#screenshots = init.screenshots?.length
      ? init.screenshots
      : [{ dataUrl: 'data:image/png;base64,ZmFrZQ==', width: 1024, height: 768 }];
  }

  /** Names of the calls made, in order. Convenient for assertions. */
  get names(): string[] {
    return this.calls.map((c) => c.name);
  }

  #record(name: keyof PageTools, ...args: unknown[]): void {
    this.calls.push({ name, args });
  }

  #next<T>(list: T[], index: number): [T, number] {
    const item = list[Math.min(index, list.length - 1)] as T;
    return [item, index + 1];
  }

  async snapshot(): Promise<SnapshotResult> {
    this.#record('snapshot');
    const [item, next] = this.#next(this.#snapshots, this.#snapshotIndex);
    this.#snapshotIndex = next;
    return item;
  }

  async screenshot(): Promise<ScreenshotResult> {
    this.#record('screenshot');
    const [item, next] = this.#next(this.#screenshots, this.#screenshotIndex);
    this.#screenshotIndex = next;
    return item;
  }

  async extractText(maxChars?: number, startChar?: number): Promise<string> {
    this.#record('extractText', maxChars, startChar);
    return 'extracted text';
  }

  async getBox(ref: string): Promise<ElementBox> {
    this.#record('getBox', ref);
    return { x: 0, y: 0, width: 10, height: 10 };
  }

  async click(ref: string): Promise<string> {
    this.#record('click', ref);
    return `clicked ${ref}`;
  }

  async hover(ref: string): Promise<string> {
    this.#record('hover', ref);
    return `hovered ${ref}`;
  }

  async type(ref: string, text: string): Promise<string> {
    this.#record('type', ref, text);
    return `typed into ${ref}`;
  }

  async press(key: string): Promise<string> {
    this.#record('press', key);
    return `pressed ${key}`;
  }

  async scroll(target: ScrollTarget): Promise<string> {
    this.#record('scroll', target);
    return `scrolled ${target}`;
  }

  async select(ref: string, value: string): Promise<string> {
    this.#record('select', ref, value);
    return `selected ${value} in ${ref}`;
  }

  async navigate(url: string): Promise<string> {
    this.#record('navigate', url);
    return `navigated to ${url}`;
  }

  async download(target: string): Promise<string> {
    this.#record('download', target);
    return `downloaded ${target}`;
  }

  async runUserscript(scriptId: string, args?: Record<string, unknown>): Promise<string> {
    this.#record('runUserscript', ...(args === undefined ? [scriptId] : [scriptId, args]));
    return `ran userscript ${scriptId}`;
  }

  async listUserscripts(): Promise<string> {
    this.#record('listUserscripts');
    return 'no userscripts are saved';
  }

  async readUserscript(idOrName: string): Promise<string> {
    this.#record('readUserscript', idOrName);
    return `source of ${idOrName}`;
  }

  async writeUserscript(request: WriteUserscriptRequest): Promise<string> {
    this.#record('writeUserscript', request);
    return `saved userscript ${request.scriptId ?? 'fake-script-id'}`;
  }

  async saveFile(filename: string, content: string | undefined, fromLastUserscript: boolean): Promise<string> {
    this.#record('saveFile', filename, content, fromLastUserscript);
    return `saved ${filename}`;
  }

  async wait(ms: number): Promise<string> {
    this.#record('wait', ms);
    return `waited ${ms}ms`;
  }

  async done(summary: string): Promise<string> {
    this.#record('done', summary);
    return summary;
  }

  async blocked(reason: string): Promise<string> {
    this.#record('blocked', reason);
    return reason;
  }
}
