import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dispatcher } from '../src/dispatcher.ts';
import { CHUNK_BYTES } from '../src/protocol.ts';
import { setInjector, NullInjector, type InputInjector } from '../src/input/index.ts';
import { decodeChunks, makeHarness, utf8, type Harness } from './harness.ts';

let h: Harness;
afterEach(async () => {
  await h?.cleanup();
  setInjector(new NullInjector());
});

describe('key.status', () => {
  it('reports ready when GET /key succeeds, and never sends the key to the panel', async () => {
    h = await makeHarness({ key: 'sk-or-v1-secretvalue' });
    h.fetch.enqueueJson(200, { data: { label: 'dev', is_free_tier: true } });
    await h.dispatcher.handle({ type: 'key.status', id: '1' });

    expect(h.sent).toEqual([{ type: 'key.status.result', id: '1', ready: true }]);
    expect(h.fetch.calls[0]!.url).toBe('https://openrouter.ai/api/v1/key');
    expect(h.fetch.calls[0]!.headers['authorization']).toBe('Bearer sk-or-v1-secretvalue');
    expect(JSON.stringify(h.sent)).not.toContain('sk-or-v1-secretvalue');
  });

  it('reports not-ready with a reason on 401', async () => {
    h = await makeHarness();
    h.fetch.enqueueJson(401, { error: { message: 'no credentials', code: 401 } });
    await h.dispatcher.handle({ type: 'key.status', id: '1' });
    expect(h.sent[0]).toMatchObject({ type: 'key.status.result', ready: false });
    expect((h.sent[0] as { reason: string }).reason).toContain('401');
  });

  it('reports not-ready with no network call when the secret store is empty', async () => {
    h = await makeHarness({ key: null });
    await h.dispatcher.handle({ type: 'key.status', id: '1' });
    expect(h.fetch.calls).toHaveLength(0);
    expect(h.sent[0]).toMatchObject({ type: 'key.status.result', ready: false });
  });
});

describe('models.list', () => {
  it('fetches both catalogs in parallel and merges them under sources, with no Authorization for OpenRouter', async () => {
    h = await makeHarness({ kiloKey: 'kilo-fake-key' });
    // Fetches start in the same tick (Promise.allSettled over a .map), so the queue
    // order matches call order: OpenRouter first, then Kilo.
    h.fetch.enqueueJson(200, { data: [{ id: 'nvidia/nemotron-3.5-lightning:free' }] });
    h.fetch.enqueueJson(200, { data: [{ id: 'meta/muse-spark-1.3-contributor' }] });
    await h.dispatcher.handle({ type: 'models.list', id: 'm1' });

    expect(h.fetch.calls[0]!.url).toBe('https://openrouter.ai/api/v1/models');
    expect(h.fetch.calls[0]!.headers['authorization']).toBeUndefined();
    expect(h.fetch.calls[1]!.url).toBe('https://api.kilo.ai/api/gateway/models');
    expect(h.fetch.calls[1]!.headers['authorization']).toBe('Bearer kilo-fake-key');
    expect(h.sent[0]).toEqual({
      type: 'models.list.result',
      id: 'm1',
      status: 200,
      body: {
        sources: {
          openrouter: { status: 200, body: { data: [{ id: 'nvidia/nemotron-3.5-lightning:free' }] } },
          kilo: { status: 200, body: { data: [{ id: 'meta/muse-spark-1.3-contributor' }] } },
        },
      },
    });
  });

  it('still returns the surviving source when the other one fails, and says which failed', async () => {
    h = await makeHarness();
    h.fetch.enqueueJson(200, { data: [{ id: 'nvidia/nemotron-3.5-lightning:free' }] });
    h.fetch.enqueue(() => {
      throw new Error('kilo unreachable');
    });
    await h.dispatcher.handle({ type: 'models.list', id: 'm1' });

    expect(h.sent[0]).toMatchObject({ type: 'models.list.result', id: 'm1', status: 200 });
    const body = (h.sent[0] as { body: { sources: unknown; errors: Record<string, string> } }).body;
    expect(body.sources).toEqual({
      openrouter: { status: 200, body: { data: [{ id: 'nvidia/nemotron-3.5-lightning:free' }] } },
    });
    expect(body.errors.kilo).toContain('kilo unreachable');
  });
});

describe('llm.request', () => {
  const req = (over: Record<string, unknown> = {}) => ({
    type: 'llm.request' as const,
    id: 'r1',
    url: '/chat/completions',
    method: 'POST',
    body: { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true },
    ...over,
  });

  it('streams chunks then llm.end, adding auth and branding headers', async () => {
    h = await makeHarness({ key: 'sk-or-v1-secretvalue' });
    h.fetch.enqueueStream(200, [utf8('data: a\n\n'), utf8('data: b\n\n')], { 'content-type': 'text/event-stream' });
    await h.dispatcher.handle(req());

    const types = h.sent.map((m) => m.type);
    expect(types).toEqual(['llm.chunk', 'llm.chunk', 'llm.end']);
    expect(decodeChunks(h.sent, 'r1')).toBe('data: a\n\ndata: b\n\n');
    expect(h.sent.at(-1)).toMatchObject({ type: 'llm.end', id: 'r1', status: 200 });

    const call = h.fetch.calls[0]!;
    expect(call.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(call.init.method).toBe('POST');
    expect(call.headers['authorization']).toBe('Bearer sk-or-v1-secretvalue');
    expect(call.headers['http-referer']).toBeTruthy();
    expect(call.headers['x-title']).toBe('nanobrowser');
    expect(JSON.parse(String(call.init.body))).toMatchObject({ model: 'm' });
  });

  it('strips a client-supplied Authorization header rather than forwarding it', async () => {
    h = await makeHarness({ key: 'sk-or-v1-secretvalue' });
    h.fetch.enqueueStream(200, [utf8('ok')]);
    await h.dispatcher.handle(req({ headers: { Authorization: 'Bearer attacker', 'X-Title': 'spoof', 'X-Keep': 'yes' } }));

    const call = h.fetch.calls[0]!;
    expect(call.headers['authorization']).toBe('Bearer sk-or-v1-secretvalue');
    expect(call.headers['x-title']).toBe('nanobrowser');
    expect(call.headers['x-keep']).toBe('yes');
  });

  it('splits a large body into chunks under the 1 MB host->extension limit', async () => {
    h = await makeHarness();
    const big = new Uint8Array(CHUNK_BYTES * 2 + 100).fill(65);
    h.fetch.enqueueStream(200, [big]);
    await h.dispatcher.handle(req());

    const chunks = h.sent.filter((m) => m.type === 'llm.chunk');
    expect(chunks).toHaveLength(3);
    for (const c of chunks) {
      expect(Buffer.from((c as { bytes: string }).bytes, 'base64').byteLength).toBeLessThanOrEqual(CHUNK_BYTES);
      expect(Buffer.byteLength(JSON.stringify(c))).toBeLessThan(1024 * 1024);
    }
    expect(decodeChunks(h.sent, 'r1').length).toBe(big.byteLength);
  });

  it('emits llm.error no_key when no secret is available, without calling fetch', async () => {
    h = await makeHarness({ key: null });
    await h.dispatcher.handle(req());
    expect(h.fetch.calls).toHaveLength(0);
    expect(h.sent[0]).toMatchObject({ type: 'llm.error', id: 'r1', code: 'no_key' });
  });

  it('refuses a url that escapes the OpenRouter origin', async () => {
    h = await makeHarness();
    await h.dispatcher.handle(req({ url: 'https://evil.example.com/steal' }));
    expect(h.fetch.calls).toHaveLength(0);
    expect(h.sent[0]).toMatchObject({ type: 'llm.error', code: 'bad_request' });
  });

  it('reports upstream failures as llm.error', async () => {
    h = await makeHarness();
    h.fetch.enqueue(() => {
      throw new Error('econnreset');
    });
    await h.dispatcher.handle(req());
    expect(h.sent[0]).toMatchObject({ type: 'llm.error', id: 'r1', code: 'upstream', message: 'econnreset' });
  });

  it('rejects a request with no url', async () => {
    h = await makeHarness();
    await h.dispatcher.handle({ type: 'llm.request', id: 'r1' });
    expect(h.sent[0]).toMatchObject({ type: 'error', id: 'r1', code: 'bad_request' });
  });
});

describe('llm.abort', () => {
  it('aborts an in-flight request and reports code aborted', async () => {
    h = await makeHarness();
    h.fetch.enqueue(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = call.init.signal!;
          signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted.');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );
    const pending = h.dispatcher.handle({
      type: 'llm.request',
      id: 'r9',
      url: '/chat/completions',
      body: { model: 'm', messages: [] },
    });
    await new Promise((r) => setImmediate(r));
    await h.dispatcher.handle({ type: 'llm.abort', id: 'r9' });
    await pending;
    expect(h.sent).toEqual([{ type: 'llm.error', id: 'r9', code: 'aborted', message: 'aborted by client' }]);
  });

  it('is a no-op for an unknown id', async () => {
    h = await makeHarness();
    await h.dispatcher.handle({ type: 'llm.abort', id: 'nope' });
    expect(h.sent).toEqual([]);
  });
});

describe('cassettes', () => {
  const req = {
    type: 'llm.request' as const,
    id: 'c1',
    url: '/chat/completions',
    body: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
  };

  it('record writes the stream to disk and still streams to the extension', async () => {
    h = await makeHarness({ cassetteMode: 'record' });
    h.fetch.enqueueStream(200, [utf8('hello '), utf8('world')], { 'content-type': 'text/event-stream' });
    await h.dispatcher.handle(req);

    expect(decodeChunks(h.sent, 'c1')).toBe('hello world');
    const files = await fs.readdir(h.cassetteDir);
    expect(files).toHaveLength(1);
    const entry = JSON.parse(await fs.readFile(path.join(h.cassetteDir, files[0]!), 'utf8'));
    expect(entry.status).toBe(200);
    expect(entry.chunks).toHaveLength(2);
    expect(Buffer.from(entry.chunks[0], 'base64').toString('utf8')).toBe('hello ');
  });

  it('does not send a second terminal error when recording fails after upstream success', async () => {
    h = await makeHarness({ cassetteMode: 'record' });
    vi.spyOn(h.cassettes, 'write').mockRejectedValue(new Error('ENOSPC'));
    h.fetch.enqueueStream(200, [utf8('hello')]);

    await h.dispatcher.handle(req);

    expect(h.sent.map((m) => m.type)).toEqual(['llm.chunk', 'llm.end']);
    expect(h.sent.filter((m) => m.type === 'llm.error')).toHaveLength(0);
    expect(h.sent.at(-1)).toMatchObject({ type: 'llm.end', id: 'c1', status: 200 });
  });

  it('replay serves the recorded chunks with no network call', async () => {
    h = await makeHarness({ cassetteMode: 'record' });
    h.fetch.enqueueStream(201, [utf8('recorded')], { 'x-provider': 'nvidia' });
    await h.dispatcher.handle(req);
    const recordedCalls = h.fetch.calls.length;

    const replay = await makeHarness({ cassetteMode: 'replay' });
    // point the replay harness at the recorded cassette dir
    const files = await fs.readdir(h.cassetteDir);
    await fs.mkdir(replay.cassetteDir, { recursive: true });
    await fs.copyFile(path.join(h.cassetteDir, files[0]!), path.join(replay.cassetteDir, files[0]!));

    await replay.dispatcher.handle(req);
    expect(replay.fetch.calls).toHaveLength(0);
    expect(recordedCalls).toBe(1);
    expect(decodeChunks(replay.sent, 'c1')).toBe('recorded');
    expect(replay.sent.at(-1)).toMatchObject({ type: 'llm.end', status: 201, headers: { 'x-provider': 'nvidia' } });
    await replay.cleanup();
  });

  it('replay fails loudly on an unrecorded request', async () => {
    h = await makeHarness({ cassetteMode: 'replay' });
    await h.dispatcher.handle(req);
    expect(h.fetch.calls).toHaveLength(0);
    expect(h.sent[0]).toMatchObject({ type: 'llm.error', id: 'c1', code: 'cassette_miss' });
  });

  it('replay needs no secret at all', async () => {
    h = await makeHarness({ key: null, cassetteMode: 'replay' });
    await h.dispatcher.handle(req);
    expect(h.sent[0]).toMatchObject({ code: 'cassette_miss' });
  });
});

describe('runlog.append', () => {
  it('appends to <runId>.jsonl, acks, and mirrors to socket subscribers', async () => {
    h = await makeHarness();
    await h.dispatcher.handle({ type: 'runlog.append', id: 'a1', runId: 'run-1', event: { type: 'run.start' } });
    await h.dispatcher.handle({ type: 'runlog.append', runId: 'run-1', event: { type: 'run.end', status: 'done' } });

    const text = await fs.readFile(path.join(h.runsDir, 'run-1.jsonl'), 'utf8');
    expect(text.trimEnd().split('\n').map((l) => JSON.parse(l))).toEqual([
      { type: 'run.start' },
      { type: 'run.end', status: 'done' },
    ]);
    expect(h.sent[0]).toEqual({ type: 'runlog.ack', id: 'a1', runId: 'run-1', ok: true });
    expect(h.runEvents.map((e) => e.runId)).toEqual(['run-1', 'run-1']);
  });

  it('keeps arrival order when frames are handled concurrently, so run.end is never published before the events ahead of it', async () => {
    // main.ts fires `void dispatcher.handle(m)` per frame without awaiting. The harness
    // (scripts/harness.sh) caught run.end overtaking run.ended: the trigger closed the
    // nb-run socket on run.end and the stream lost the run's own terminal event.
    h = await makeHarness();
    const events = Array.from({ length: 40 }, (_, n) => ({ kind: 'step', n }));
    events.push({ kind: 'run.ended', n: 40 } as never, { type: 'run.end', n: 41 } as never);
    await Promise.all(events.map((event) => h.dispatcher.handle({ type: 'runlog.append', runId: 'run-1', event })));

    const text = await fs.readFile(path.join(h.runsDir, 'run-1.jsonl'), 'utf8');
    const order = events.map((e) => (e as { n: number }).n);
    expect(text.trimEnd().split('\n').map((l) => JSON.parse(l).n)).toEqual(order);
    expect(h.runEvents.map((e) => (e.event as { n: number }).n)).toEqual(order);
  });

  it('keeps the chain healthy when a subscriber throws: the caller sees the error, later appends still land', async () => {
    h = await makeHarness();
    let calls = 0;
    const flaky = new Dispatcher({
      send: (m) => h.sent.push(m),
      llm: h.llm,
      runsDir: h.runsDir,
      artifactsDir: h.artifactsDir,
      onRunEvent: () => {
        calls += 1;
        if (calls === 1) throw new Error('subscriber blew up');
      },
    });
    // The failed append surfaces to the caller (main.ts logs it); it must not
    // poison the run's chain into silently skipping everything behind it.
    await expect(
      flaky.handle({ type: 'runlog.append', runId: 'run-1', event: { n: 1 } }),
    ).rejects.toThrow('subscriber blew up');
    await flaky.handle({ type: 'runlog.append', runId: 'run-1', event: { n: 2 } });

    const text = await fs.readFile(path.join(h.runsDir, 'run-1.jsonl'), 'utf8');
    expect(text.trimEnd().split('\n').map((l) => JSON.parse(l).n)).toEqual([1, 2]);
    expect(h.sent.filter((m) => m.type === 'runlog.ack')).toHaveLength(1);
  });

  it('rejects a bad runId without writing anything', async () => {
    h = await makeHarness();
    await h.dispatcher.handle({ type: 'runlog.append', id: 'a1', runId: '../evil', event: {} });
    expect(h.sent[0]).toMatchObject({ type: 'error', id: 'a1', code: 'bad_request' });
    await expect(fs.readdir(h.runsDir)).rejects.toThrow();
    expect(h.runEvents).toEqual([]);
  });
});

describe('artifact.save', () => {
  it('writes the file under <artifactsDir>/<runId>/<filename> and reports its byte count', async () => {
    h = await makeHarness();
    await h.dispatcher.handle({ type: 'artifact.save', id: 'f1', runId: 'run-1', filename: 'result.json', content: '{"a":1}' });

    const file = path.join(h.artifactsDir, 'run-1', 'result.json');
    expect(await fs.readFile(file, 'utf8')).toBe('{"a":1}');
    expect(h.sent[0]).toEqual({
      type: 'artifact.save.result',
      id: 'f1',
      runId: 'run-1',
      filename: 'result.json',
      bytes: Buffer.byteLength('{"a":1}', 'utf8'),
      path: file,
    });
  });

  it('rejects a filename that escapes the run directory without writing anything', async () => {
    h = await makeHarness();
    await h.dispatcher.handle({ type: 'artifact.save', id: 'f1', runId: 'run-1', filename: '../evil.json', content: 'x' });
    expect(h.sent[0]).toMatchObject({ type: 'error', id: 'f1', code: 'bad_request' });
    await expect(fs.readdir(h.artifactsDir)).rejects.toThrow();
  });

  it('rejects a bad runId', async () => {
    h = await makeHarness();
    await h.dispatcher.handle({ type: 'artifact.save', id: 'f1', runId: '../escape', filename: 'a.json', content: 'x' });
    expect(h.sent[0]).toMatchObject({ type: 'error', id: 'f1', code: 'bad_request' });
  });

  it('rejects a non-string content field', async () => {
    h = await makeHarness();
    await h.dispatcher.handle({ type: 'artifact.save', id: 'f1', runId: 'run-1', filename: 'a.json', content: { not: 'a string' } });
    expect(h.sent[0]).toMatchObject({ type: 'error', id: 'f1', code: 'bad_request' });
  });
});

describe('input.*', () => {
  it('reports ok:false from the NullInjector rather than pretending to act', async () => {
    h = await makeHarness();
    await h.dispatcher.handle({ type: 'input.click', id: 'i1', button: 'left' });
    expect(h.sent[0]).toMatchObject({ type: 'input.result', id: 'i1', ok: false, injector: 'null' });
  });

  it('routes each verb to the current injector', async () => {
    h = await makeHarness();
    const seen: string[] = [];
    const spy: InputInjector = {
      name: 'spy',
      async moveTo(x, y) {
        seen.push(`moveTo ${x},${y}`);
      },
      async click(b) {
        seen.push(`click ${b}`);
      },
      async typeText(t) {
        seen.push(`type ${t}`);
      },
      async key(n, a) {
        seen.push(`key ${n} ${a}`);
      },
    };
    setInjector(spy);
    await h.dispatcher.handle({ type: 'input.moveTo', id: '1', x: 10, y: 20 });
    await h.dispatcher.handle({ type: 'input.click', id: '2', button: 'right' });
    await h.dispatcher.handle({ type: 'input.typeText', id: '3', text: 'abc' });
    await h.dispatcher.handle({ type: 'input.key', id: '4', name: 'Enter', action: 'press' });
    expect(seen).toEqual(['moveTo 10,20', 'click right', 'type abc', 'key Enter press']);
    expect(h.sent.every((m) => m.type === 'input.result' && m.ok)).toBe(true);
  });
});

describe('malformed input', () => {
  it('rejects a non-object message', async () => {
    h = await makeHarness();
    await h.dispatcher.handle('nope');
    expect(h.sent[0]).toMatchObject({ type: 'error', code: 'bad_request' });
  });

  it('rejects an unknown type', async () => {
    h = await makeHarness();
    await h.dispatcher.handle({ type: 'nope.wat', id: 'x' });
    expect(h.sent[0]).toMatchObject({ type: 'error', id: 'x', code: 'unknown_type' });
  });

  it('rejects a request with no id', async () => {
    h = await makeHarness();
    await h.dispatcher.handle({ type: 'key.status' });
    expect(h.sent[0]).toMatchObject({ type: 'error', code: 'bad_request' });
  });
});
