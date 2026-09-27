/**
 * Model handles for the graph.
 *
 * `createChatModel` builds a `ChatOpenAI` pointed at an OpenRouter-shaped
 * endpoint. The extension never holds the user's key (R-12): the `fetch` passed
 * in belongs to the host proxy, which attaches the real credential on its way
 * out. `apiKey` here is a non-secret placeholder only because the underlying
 * openai client refuses to construct without one.
 *
 * `provider.data_collection` is "deny" for paid models because page DOM and
 * screenshots are sent on every step (docs/research/models-and-grounding.md §6).
 * OpenRouter's `:free` endpoints exist only under the training data policy, so
 * "deny" yields `404 No endpoints found matching your data policy`; the user
 * chose free models knowingly (a live run on the free pair ended `error 404`
 * under "deny" before this mapping existed), so those get "allow".
 */
export function dataCollectionFor(model: string): 'allow' | 'deny' {
  return model.endsWith(':free') ? 'allow' : 'deny';
}
import { ChatOpenAI } from '@langchain/openai';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseChatModelParams } from '@langchain/core/language_models/chat_models';
import type { BindToolsInput } from '@langchain/core/language_models/chat_models';
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import { AIMessage, type AIMessageChunk, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import type { Runnable } from '@langchain/core/runnables';
import type { ModelSource } from '@/src/storage';

/** Sentinel key. The real credential is added by the host proxy behind `fetch` (R-12). */
export const PROXY_MANAGED_KEY = 'host-proxy-managed';

export const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
/** Kilo AI Gateway: OpenAI-compatible, same client, different base and credential. */
export const KILO_BASE_URL = 'https://api.kilo.ai/api/gateway';

function baseUrlFor(source: ModelSource): string {
  return source === 'kilo' ? KILO_BASE_URL : DEFAULT_BASE_URL;
}

export interface CreateChatModelOptions {
  /** The provider's own model id, e.g. "nvidia/nemotron-3.5-lightning:free". Never prefixed with a source. */
  model: string;
  /** The host proxy's fetch. Every request goes through it; it holds the key. */
  fetch: typeof globalThis.fetch;
  /** Which catalog this model came from. Absent defaults to OpenRouter (R-11 continuity: old stored configs never named a source). */
  source?: ModelSource;
  baseURL?: string;
  temperature?: number;
}

/**
 * OpenRouter reports upstream provider failures (and free-tier hiccups) as an
 * HTTP 200 whose JSON body is `{ error: { code, message } }` or simply lacks
 * `choices`. The openai SDK only retries on real error statuses, and LangChain
 * dereferences `choices[0]` and dies with "reading 'message'" otherwise (seen
 * live against `nvidia/nemotron-3-ultra-550b-a55b:free`, 2026-09-03). This
 * rewrites such replies into the status they should have carried so the SDK's
 * retry policy (429/5xx) engages.
 *
 * OpenRouter-specific: this is a quirk of *OpenRouter's* proxying (it forwards a
 * failed upstream provider call as if it succeeded). There is no live evidence
 * Kilo does the same -- a real Kilo chat/completions call returned a normal
 * `finish_reason: tool_calls` with no such wrapping -- so `createChatModel` below
 * applies this only to the OpenRouter source and leaves Kilo's `fetch` untouched
 * rather than assume the same failure mode without evidence for it.
 */
export function hardenEmptyChoices(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    const res = await fetch(input, init);
    if (res.status !== 200) return res;
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) return res;
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return errorResponse(502, 'openrouter returned unparseable JSON', res.headers);
    }
    const obj = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
    const error = obj?.error as { code?: unknown; message?: unknown } | undefined;
    if (error && typeof error === 'object') {
      const code = typeof error.code === 'number' && error.code >= 400 && error.code < 600 ? error.code : 502;
      return errorResponse(code, typeof error.message === 'string' ? error.message : 'provider error', res.headers);
    }
    if (obj && !Array.isArray(obj.choices) && obj.object !== 'list') {
      return errorResponse(502, `openrouter reply has no choices: ${text.slice(0, 200)}`, res.headers);
    }
    return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}

function errorResponse(status: number, message: string, upstream: Headers): Response {
  const headers = new Headers(upstream);
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify({ error: { message, code: status } }), { status, headers });
}

/**
 * No `maxTokens`/completion cap is set here, and none should be added casually: a
 * low cap silently breaks a reasoning model before it reaches its tool call (seen
 * live against `meta/muse-spark-1.3-contributor` via Kilo -- a 400-token cap
 * produced `finish_reason: length` with empty content and no tool call; 3000
 * tokens let it emit a correct tool call after 682 reasoning tokens). Reasoning
 * tokens count against whatever cap is set, so any future cap must budget for
 * them, not just the visible completion.
 */
export function createChatModel(options: CreateChatModelOptions): ChatOpenAI {
  const { model, fetch, source = 'openrouter', baseURL = baseUrlFor(source), temperature = 0 } = options;
  const isOpenRouter = source === 'openrouter';
  return new ChatOpenAI({
    model,
    temperature,
    apiKey: PROXY_MANAGED_KEY,
    maxRetries: 4,
    // Applied to BOTH gateways. It was OpenRouter-only on the reasoning that Kilo had
    // shown no such quirk; then the free Nemotron pair on Kilo failed a live eBay run with
    // "Cannot read properties of undefined (reading 'message')", which is LangChain
    // dereferencing `generations[0][0]` after a 200 with no `choices`. The check is
    // provider-agnostic, so there is no reason to leave either gateway unguarded.
    configuration: { baseURL, fetch: hardenEmptyChoices(fetch) },
    // `provider.data_collection` is an OpenRouter-specific field; Kilo does not use it,
    // and sending it there breaks models whose Kilo endpoint would otherwise work
    // (live evidence: meta/muse-spark-1.3-contributor 404s on OpenRouter under `deny`
    // but completes normally on Kilo -- only when this field is left out of the request).
    ...(isOpenRouter
      ? { modelKwargs: { provider: { data_collection: dataCollectionFor(model), allow_fallbacks: true } } }
      : {}),
  });
}

/* ------------------------------------------------------------------------- */
/* Test double                                                               */
/* ------------------------------------------------------------------------- */

/** One scripted model turn: plain text, a single tool call, or a batched pair. */
export type FakeTurn =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; args: Record<string, unknown>; text?: string }
  | { kind: 'tools'; calls: { name: string; args: Record<string, unknown> }[]; text?: string };

export interface FakeCall {
  /** Zero-based index of this call on this model instance. */
  index: number;
  messages: BaseMessage[];
  /** Names of the tools bound at the time of the call. */
  tools: string[];
}

export interface FakeChatModelInit extends BaseChatModelParams {
  /** Turns played in order. The last one repeats once the list is exhausted. */
  turns?: FakeTurn[];
  /** Takes precedence over `turns` when present. */
  respond?: (call: FakeCall) => FakeTurn;
  label?: string;
}

/**
 * A `BaseChatModel` that never touches the network.
 *
 * Supports `bindTools` and scripts the Follower's structured signal by putting it
 * in the tool-call arguments, exactly where a real tool-calling model puts it.
 */
export class FakeChatModel extends BaseChatModel {
  /** Every call this instance received, in order. Assert history separation on it. */
  readonly calls: FakeCall[] = [];

  readonly label: string;

  #turns: FakeTurn[];
  #respond?: (call: FakeCall) => FakeTurn;
  #boundTools: string[] = [];
  #toolCallSeq = 0;

  constructor(init: FakeChatModelInit = {}) {
    super(init);
    this.#turns = init.turns ?? [{ kind: 'text', text: 'ok' }];
    this.#respond = init.respond;
    this.label = init.label ?? 'fake';
  }

  _llmType(): string {
    return 'fake';
  }

  override bindTools(
    tools: BindToolsInput[],
  ): Runnable<BaseLanguageModelInput, AIMessageChunk, this['ParsedCallOptions']> {
    this.#boundTools = tools.map((t) =>
      typeof t === 'object' && t !== null && 'name' in t ? String(t.name) : 'unknown',
    );
    // The fake answers directly; nothing downstream needs a distinct bound object.
    return this as unknown as Runnable<
      BaseLanguageModelInput,
      AIMessageChunk,
      this['ParsedCallOptions']
    >;
  }

  /** The tool names most recently bound. */
  get boundTools(): string[] {
    return [...this.#boundTools];
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const call: FakeCall = {
      index: this.calls.length,
      messages,
      tools: [...this.#boundTools],
    };
    this.calls.push(call);

    const turn =
      this.#respond?.(call) ??
      this.#turns[Math.min(call.index, this.#turns.length - 1)] ??
      ({ kind: 'text', text: 'ok' } satisfies FakeTurn);

    if (turn.kind === 'text') {
      const message = new AIMessage({ content: turn.text });
      return { generations: [{ text: turn.text, message }] };
    }

    if (turn.kind === 'tools') {
      const message = new AIMessage({
        content: turn.text ?? '',
        tool_calls: turn.calls.map((c) => {
          this.#toolCallSeq += 1;
          return {
            id: `${this.label}-call-${this.#toolCallSeq}`,
            name: c.name,
            args: c.args,
            type: 'tool_call' as const,
          };
        }),
      });
      return { generations: [{ text: turn.text ?? '', message }] };
    }

    this.#toolCallSeq += 1;
    const text = turn.text ?? '';
    const message = new AIMessage({
      content: text,
      tool_calls: [
        {
          id: `${this.label}-call-${this.#toolCallSeq}`,
          name: turn.name,
          args: turn.args,
          type: 'tool_call',
        },
      ],
    });
    return { generations: [{ text, message }] };
  }
}

/** @deprecated Use {@link hardenEmptyChoices}; the quirk is not OpenRouter's alone. */
export const hardenOpenRouterFetch = hardenEmptyChoices;
