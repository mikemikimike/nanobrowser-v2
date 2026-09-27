import { describe, expect, it } from 'vitest';
import { createChatModel, dataCollectionFor, DEFAULT_BASE_URL, KILO_BASE_URL , hardenEmptyChoices } from './models';

describe('data collection policy per model', () => {
  it('allows training only for OpenRouter :free endpoints, denies for everything else', () => {
    expect(dataCollectionFor('nvidia/nemotron-3.5-lightning:free')).toBe('allow');
    expect(dataCollectionFor('deepseek/deepseek-v3.2')).toBe('deny');
  });

  it('puts the policy on the request body via modelKwargs', () => {
    const free = createChatModel({ model: 'x/y:free', fetch: globalThis.fetch, baseURL: 'https://openrouter.ai/api/v1' });
    const paid = createChatModel({ model: 'x/y', fetch: globalThis.fetch, baseURL: 'https://openrouter.ai/api/v1' });
    expect((free.modelKwargs as { provider: { data_collection: string } }).provider.data_collection).toBe('allow');
    expect((paid.modelKwargs as { provider: { data_collection: string } }).provider.data_collection).toBe('deny');
  });
});

import { hardenOpenRouterFetch } from './models';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('routing a run to the model\'s own source', () => {
  it('defaults to the OpenRouter base URL when no source is given (old stored configs)', () => {
    const model = createChatModel({ model: 'x/y', fetch: globalThis.fetch });
    expect((model as unknown as { clientConfig: { baseURL: string } }).clientConfig.baseURL).toBe(DEFAULT_BASE_URL);
  });

  it('routes a Kilo-sourced model to the Kilo base URL', () => {
    const model = createChatModel({ model: 'meta/muse-spark-1.3-contributor', fetch: globalThis.fetch, source: 'kilo' });
    expect((model as unknown as { clientConfig: { baseURL: string } }).clientConfig.baseURL).toBe(KILO_BASE_URL);
  });

  it('never encodes the source into the model id sent to the provider', () => {
    const model = createChatModel({ model: 'meta/muse-spark-1.3-contributor', fetch: globalThis.fetch, source: 'kilo' });
    expect(model.model).toBe('meta/muse-spark-1.3-contributor');
  });

  it('omits the OpenRouter-shaped provider block entirely for a Kilo model', () => {
    const model = createChatModel({ model: 'meta/muse-spark-1.3-contributor', fetch: globalThis.fetch, source: 'kilo' });
    expect(model.modelKwargs).not.toHaveProperty('provider');
  });

  it('wraps a Kilo request too, because Kilo returns choice-less 200s as well', async () => {
    // This test used to assert the opposite, on the reasoning that Kilo had shown no such
    // quirk. A live eBay run on the free Nemotron pair via Kilo then failed with
    // "Cannot read properties of undefined (reading 'message')" -- LangChain reading
    // generations[0][0] after exactly this reply. Evidence beats the earlier assumption.
    let calls = 0;
    const plainFetch: typeof fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ id: 'gen-1', object: 'chat.completion' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const model = createChatModel({ model: 'x/y', fetch: plainFetch, source: 'kilo' });
    const wrapped = (model as unknown as { clientConfig: { fetch: typeof fetch } }).clientConfig.fetch;
    const res = await wrapped('https://api.kilo.ai/api/gateway/chat/completions');
    expect(res.status).toBe(502);
    expect(calls).toBe(1);
  });
});

describe('hardenOpenRouterFetch', () => {
  it('passes a normal completion through untouched', async () => {
    const f = hardenOpenRouterFetch(async () => jsonResponse({ choices: [{ message: { content: 'hi' } }] }));
    const res = await f('https://openrouter.ai/api/v1/chat/completions');
    expect(res.status).toBe(200);
    expect((await res.json()).choices).toHaveLength(1);
  });

  it('turns an error-in-200 body into the status it names', async () => {
    const f = hardenOpenRouterFetch(async () => jsonResponse({ error: { code: 429, message: 'rate limited' } }));
    const res = await f('https://openrouter.ai/api/v1/chat/completions');
    expect(res.status).toBe(429);
    expect((await res.json()).error.message).toBe('rate limited');
  });

  it('turns a 200 without choices into a retryable 502', async () => {
    const f = hardenOpenRouterFetch(async () => jsonResponse({ id: 'gen-1', object: 'chat.completion' }));
    const res = await f('https://openrouter.ai/api/v1/chat/completions');
    expect(res.status).toBe(502);
  });

  it('passes a model catalog through: {object:"list"} is not a choice-less completion', async () => {
    const catalog = { object: 'list', data: [{ id: 'x/y:free', object: 'model' }, { id: 'a/b', object: 'model' }] };
    const f = hardenOpenRouterFetch(async () => jsonResponse(catalog));
    const res = await f('https://openrouter.ai/api/v1/models');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(catalog);
  });

  it('leaves non-JSON and non-200 replies alone', async () => {
    const f = hardenOpenRouterFetch(async () => new Response('nope', { status: 404, headers: { 'content-type': 'text/plain' } }));
    const res = await f('https://openrouter.ai/api/v1/models');
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('nope');
  });
});

describe('empty-choices hardening applies to both gateways', () => {
  // Regression: the guard was OpenRouter-only, and a live eBay run on the free Nemotron
  // pair via Kilo died with "Cannot read properties of undefined (reading 'message')" --
  // LangChain dereferencing generations[0][0] after a 200 that carried no `choices`.
  const emptyTwoHundred = async () =>
    new Response(JSON.stringify({ id: 'x', object: 'chat.completion' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  it('rewrites a choice-less 200 into a retryable status for Kilo too', async () => {
    const hardened = hardenEmptyChoices(emptyTwoHundred as unknown as typeof globalThis.fetch);
    const res = await hardened('https://api.kilo.ai/api/gateway/chat/completions');
    expect(res.status).toBe(502);
    expect(await res.text()).toContain('no choices');
  });

  it('is wired into the model for both sources', () => {
    for (const source of ['openrouter', 'kilo'] as const) {
      const model = createChatModel({ model: 'x/y:free', fetch: globalThis.fetch, source });
      expect(model).toBeDefined();
    }
  });
});
