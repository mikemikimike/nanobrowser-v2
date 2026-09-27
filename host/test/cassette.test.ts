import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CassetteStore,
  cassetteKey,
  cassetteMode,
  normalizePath,
  normalizeRequest,
  OffOriginError,
  stableStringify,
} from '../src/cassette.ts';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nb-cassettes-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const req = (over: Record<string, unknown> = {}) => ({
  url: '/chat/completions',
  body: { model: 'nvidia/nemotron-3.5-lightning:free', messages: [{ role: 'user', content: 'hi' }], ...over },
});

describe('cassette key', () => {
  it('is a sha256 hex digest', () => {
    expect(cassetteKey(req())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across key order in the body', () => {
    const a = cassetteKey({
      url: '/chat/completions',
      body: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
    });
    const b = cassetteKey({
      url: '/chat/completions',
      body: { messages: [{ content: 'hi', role: 'user' }], model: 'm' },
    });
    expect(a).toBe(b);
  });

  it('ignores parameters outside (url, model, messages)', () => {
    expect(cassetteKey(req({ temperature: 0.7, stream: true }))).toBe(cassetteKey(req()));
  });

  it('changes with the model', () => {
    expect(cassetteKey(req({ model: 'other' }))).not.toBe(cassetteKey(req()));
  });

  it('changes with the messages', () => {
    expect(cassetteKey(req({ messages: [{ role: 'user', content: 'bye' }] }))).not.toBe(cassetteKey(req()));
  });

  it('changes with the url path', () => {
    expect(cassetteKey({ ...req(), url: '/completions' })).not.toBe(cassetteKey(req()));
  });

  it('normalizes equivalent url spellings to one key', () => {
    expect(cassetteKey({ ...req(), url: 'chat/completions' })).toBe(cassetteKey(req()));
    expect(cassetteKey({ ...req(), url: '/chat/completions/' })).toBe(cassetteKey(req()));
  });
});

describe('stableStringify', () => {
  it('sorts keys recursively and drops undefined', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 }, e: undefined })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
  it('preserves array order', () => {
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]');
  });
});

describe('normalizePath', () => {
  it.each([
    ['/chat/completions', 'chat/completions'],
    ['chat/completions', 'chat/completions'],
    ['/chat/completions//', 'chat/completions'],
    ['https://openrouter.ai/api/v1/key', 'key'],
    ['https://openrouter.ai/api/v1/chat/completions?x=1', 'chat/completions?x=1'],
  ])('%s -> %s', (input, want) => {
    expect(normalizePath(input)).toBe(want);
  });
});

describe('normalizePath off-origin', () => {
  it('throws rather than silently rewriting a foreign origin', () => {
    expect(() => normalizePath('https://evil.example.com/steal')).toThrow(OffOriginError);
    expect(() => normalizePath('//evil.example.com/steal')).toThrow(OffOriginError);
  });
});

describe('normalizeRequest: origin tagging (the credential-selection seam)', () => {
  it('tags an OpenRouter absolute url and strips its /api/v1 prefix', () => {
    expect(normalizeRequest('https://openrouter.ai/api/v1/chat/completions')).toEqual({
      path: 'chat/completions',
      origin: 'openrouter',
    });
  });

  it('tags a Kilo absolute url and strips its /api/gateway prefix', () => {
    expect(normalizeRequest('https://api.kilo.ai/api/gateway/chat/completions')).toEqual({
      path: 'chat/completions',
      origin: 'kilo',
    });
    expect(normalizeRequest('https://api.kilo.ai/api/gateway/models')).toEqual({
      path: 'models',
      origin: 'kilo',
    });
  });

  it('leaves a relative path with no origin at all, for the caller to default', () => {
    expect(normalizeRequest('/chat/completions')).toEqual({ path: 'chat/completions', origin: null });
  });

  it('still refuses a foreign origin, same as before Kilo existed', () => {
    expect(() => normalizeRequest('https://evil.example.com/steal')).toThrow(OffOriginError);
  });
});

describe('cassetteMode', () => {
  it('is off unless explicitly record or replay', () => {
    expect(cassetteMode({})).toBe('off');
    expect(cassetteMode({ NANOBROWSER_CASSETTE: '1' })).toBe('off');
    expect(cassetteMode({ NANOBROWSER_CASSETTE: 'record' })).toBe('record');
    expect(cassetteMode({ NANOBROWSER_CASSETTE: 'replay' })).toBe('replay');
  });
});

describe('CassetteStore', () => {
  it('writes and reads an entry by key', async () => {
    const store = new CassetteStore(dir);
    const key = cassetteKey(req());
    await store.write({
      key,
      url: 'chat/completions',
      model: 'm',
      status: 200,
      headers: { a: 'b' },
      chunks: ['aGk='],
    });
    expect(await store.read(key)).toEqual({
      key,
      url: 'chat/completions',
      model: 'm',
      status: 200,
      headers: { a: 'b' },
      chunks: ['aGk='],
    });
  });

  it('returns null for a miss', async () => {
    expect(await new CassetteStore(dir).read('deadbeef')).toBeNull();
  });

  it('keeps a real key inside the cassette directory', () => {
    const file = new CassetteStore(dir).fileFor(cassetteKey(req()));
    expect(path.dirname(file)).toBe(dir);
  });

  it.each(['../../etc/passwd', '..', 'a/b', 'a\\b', '/etc/passwd', 'x.json', ''])(
    'refuses a key that could leave the cassette directory: %j',
    (key) => {
      expect(() => new CassetteStore(dir).fileFor(key)).toThrow(/not a plain filename/);
    },
  );

  it('writes nothing outside the directory for a traversal key, and reads it as a miss', async () => {
    const inner = path.join(dir, 'cassettes');
    const store = new CassetteStore(inner);
    const entry = { key: '../escaped', url: 'chat/completions', model: 'm', status: 200, headers: {}, chunks: [] };
    await expect(store.write(entry)).rejects.toThrow(/not a plain filename/);
    await expect(fs.access(path.join(dir, 'escaped.json'))).rejects.toThrow();
    expect(await store.read('../escaped')).toBeNull();
  });

  it('never follows a planted symlink inside the directory, on write or read', async () => {
    const inner = path.join(dir, 'cassettes');
    await fs.mkdir(inner, { recursive: true });
    const outside = path.join(dir, 'victim.txt');
    await fs.writeFile(outside, 'untouched', 'utf8');
    await fs.symlink(outside, path.join(inner, 'planted.json'));

    const store = new CassetteStore(inner);
    const entry = { key: 'planted', url: 'chat/completions', model: 'm', status: 200, headers: {}, chunks: [] };
    await expect(store.write(entry)).rejects.toThrow(/non-regular file/);
    expect(await fs.readFile(outside, 'utf8')).toBe('untouched');
    expect(await store.read('planted')).toBeNull();
  });
});
