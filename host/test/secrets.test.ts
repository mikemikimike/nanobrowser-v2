/**
 * `SecretStore` itself (not `DopplerSecretProvider`, covered by
 * `secrets.edge.test.ts`): loading two independent credentials in parallel,
 * neither one's absence crashing the other, and per-source readiness (C-06,
 * the Kilo addition to host/src/secrets.ts).
 *
 * Issue #5: the store validates every provider value as a single token, so a
 * malformed backend can never smuggle a multi-line blob into an Authorization
 * header -- the key stays null and the reason says why (what `nb-status`
 * reports instead of attempting the live GET /key that used to 401).
 */
import { describe, expect, it } from 'vitest';
import { FakeSecretProvider, SecretStore, type SecretProvider } from '../src/secrets.ts';

describe('SecretStore.load with both sources present', () => {
  it('loads OpenRouter and Kilo independently and reports both ready', async () => {
    const store = new SecretStore(
      new FakeSecretProvider({ OPENROUTER_API_KEY: 'or-key', KILO_CODE_API_KEY: 'kilo-key' }),
    );
    await store.load();

    expect(store.key('openrouter')).toBe('or-key');
    expect(store.key('kilo')).toBe('kilo-key');
    expect(store.status('openrouter')).toEqual({ ready: true });
    expect(store.status('kilo')).toEqual({ ready: true });
  });
});

describe('SecretStore.load with one source missing', () => {
  it('does not crash when only OPENROUTER_API_KEY is absent, and still loads Kilo', async () => {
    const store = new SecretStore(new FakeSecretProvider({ KILO_CODE_API_KEY: 'kilo-key' }));
    await expect(store.load()).resolves.toBeUndefined();

    expect(store.key('openrouter')).toBeNull();
    expect(store.status('openrouter')).toMatchObject({ ready: false });
    expect(store.status('openrouter').reason).toContain('OPENROUTER_API_KEY');
    expect(store.key('kilo')).toBe('kilo-key');
    expect(store.status('kilo')).toEqual({ ready: true });
  });

  it('does not crash when only KILO_CODE_API_KEY is absent, and still loads OpenRouter', async () => {
    const store = new SecretStore(new FakeSecretProvider({ OPENROUTER_API_KEY: 'or-key' }));
    await expect(store.load()).resolves.toBeUndefined();

    expect(store.key('kilo')).toBeNull();
    expect(store.status('kilo').reason).toContain('KILO_CODE_API_KEY');
    expect(store.key('openrouter')).toBe('or-key');
  });

  it('does not crash when neither key is available', async () => {
    const store = new SecretStore(new FakeSecretProvider({}));
    await expect(store.load()).resolves.toBeUndefined();

    expect(store.status('openrouter').ready).toBe(false);
    expect(store.status('kilo').ready).toBe(false);
  });
});

describe('SecretStore back-compat single-source accessors', () => {
  it('openRouterKey and missingReason mirror the openrouter source (pre-Kilo call sites)', async () => {
    const store = new SecretStore(new FakeSecretProvider({}));
    await store.load();
    expect(store.openRouterKey).toBeNull();
    expect(store.missingReason).toContain('OPENROUTER_API_KEY');
  });
});

describe('SecretStore.load rejects non-token values (issue #5)', () => {
  it('rejects a multi-line provider value with a clear reason, and keeps the other source working', async () => {
    const store = new SecretStore(
      new FakeSecretProvider({
        OPENROUTER_API_KEY: 'banner line\nsk-or-v1-realkey',
        KILO_CODE_API_KEY: 'kilo-key',
      }),
    );
    await store.load();

    expect(store.key('openrouter')).toBeNull();
    const status = store.status('openrouter');
    expect(status.ready).toBe(false);
    expect(status.reason).toContain('OPENROUTER_API_KEY');
    expect(status.reason).toContain('single token');
    expect(status.reason).toContain('2 lines');
    expect(status.reason).not.toContain('banner line');
    expect(status.reason).not.toContain('sk-or-v1-realkey');
    // The malformed OpenRouter value must not take Kilo down with it.
    expect(store.key('kilo')).toBe('kilo-key');
    expect(store.status('kilo')).toEqual({ ready: true });
  });

  it('rejects embedded whitespace without echoing the value', async () => {
    const store = new SecretStore(new FakeSecretProvider({ OPENROUTER_API_KEY: 'aaa bbb' }));
    await store.load();

    expect(store.key('openrouter')).toBeNull();
    expect(store.missingReason).toContain('single token');
    expect(store.missingReason).not.toContain('aaa bbb');
  });

  it('surfaces a provider-supplied failure reason verbatim (what nb-status prints)', async () => {
    const failing: SecretProvider = {
      name: 'doppler',
      get: async () => ({ value: null, reason: 'OPENROUTER_API_KEY from doppler failed: doppler: not logged in' }),
    };
    const store = new SecretStore(failing);
    await store.load();

    expect(store.key('openrouter')).toBeNull();
    expect(store.status('openrouter')).toEqual({
      ready: false,
      reason: 'OPENROUTER_API_KEY from doppler failed: doppler: not logged in',
    });
    expect(store.missingReason).toContain('not logged in');
  });
});
