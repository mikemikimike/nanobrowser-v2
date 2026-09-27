/**
 * `DopplerSecretProvider` -- the one production credential-lookup
 * implementation (C-06) -- mocks `node:child_process` and drives the real class
 * directly: stdout trimming, empty-output -> null, exec error -> null with a
 * distinct reason, and the exact args it shells out with (project/config from
 * the env vars it documents reading).
 *
 * Issue #5: prefixed/multi-line stdout must not become the bearer token. These
 * tests prove a single token is parsed out and anything else is rejected with a
 * reason that names the shape, never the content.
 *
 * `execFile` is called with an argument *array* (never a shell string), so
 * there is no shell-injection surface to test here.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const execFileMock = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

async function loadSecrets() {
  // Re-imported per test after env vars / mocks are set, since
  // DOPPLER_PROJECT/DOPPLER_CONFIG are read once at module load.
  vi.resetModules();
  return import('../src/secrets.ts');
}

beforeEach(() => {
  execFileMock.mockReset();
  delete process.env.NANOBROWSER_DOPPLER_PROJECT;
  delete process.env.NANOBROWSER_DOPPLER_CONFIG;
});

describe('DopplerSecretProvider.get', () => {
  it('trims and returns stdout on success', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null, '  the-secret-value\n'));
    const { DopplerSecretProvider } = await loadSecrets();

    await expect(new DopplerSecretProvider().get('OPENROUTER_API_KEY')).resolves.toEqual({
      value: 'the-secret-value',
    });
  });

  it('resolves null with a categorical reason, never echoing the child error text', async () => {
    // Node folds the child's stderr into err.message, so the message is untrusted
    // input: it must not reach the reason (host.log, nb-status) even when it looks
    // like a helpful diagnostic.
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) =>
      cb(Object.assign(new Error('doppler: not logged in'), { code: 1 }), ''),
    );
    const { DopplerSecretProvider } = await loadSecrets();

    const lookup = await new DopplerSecretProvider().get('OPENROUTER_API_KEY');
    expect(lookup.value).toBeNull();
    expect(lookup.reason).toContain('OPENROUTER_API_KEY');
    expect(lookup.reason).toContain('exited with code 1');
    expect(lookup.reason).not.toContain('not logged in');
  });

  it('keeps secret-shaped stderr out of the reason', async () => {
    const err = Object.assign(new Error('Command failed: doppler leaked dp.ct.supersecretmaterial'), { code: 1 });
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(err, ''));
    const { DopplerSecretProvider } = await loadSecrets();

    const lookup = await new DopplerSecretProvider().get('OPENROUTER_API_KEY');
    expect(lookup.value).toBeNull();
    expect(lookup.reason).not.toContain('dp.ct.supersecretmaterial');
    expect(lookup.reason).toContain('exited with code 1');
  });

  it('names a kill distinctly, with the signal when the child reports one', async () => {
    const err = Object.assign(new Error('doppler timed out'), { killed: true, signal: 'SIGTERM', code: null });
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(err, ''));
    const { DopplerSecretProvider } = await loadSecrets();

    const lookup = await new DopplerSecretProvider().get('OPENROUTER_API_KEY');
    expect(lookup.value).toBeNull();
    expect(lookup.reason).toContain('killed by signal SIGTERM');
    expect(lookup.reason).not.toContain('timed out');
  });

  it('resolves null with a reason on empty or whitespace-only stdout', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null, '   \n  '));
    const { DopplerSecretProvider } = await loadSecrets();

    const lookup = await new DopplerSecretProvider().get('OPENROUTER_API_KEY');
    expect(lookup.value).toBeNull();
    expect(lookup.reason).toContain('OPENROUTER_API_KEY');
    expect(lookup.reason).toContain('empty output');
  });

  it('rejects multi-line stdout instead of using the blob as the key (issue #5)', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null, 'banner line\nsk-or-v1-realkey\n'));
    const { DopplerSecretProvider } = await loadSecrets();

    const lookup = await new DopplerSecretProvider().get('OPENROUTER_API_KEY');
    expect(lookup.value).toBeNull();
    expect(lookup.reason).toContain('OPENROUTER_API_KEY');
    expect(lookup.reason).toContain('single token');
    expect(lookup.reason).toContain('2 lines');
    // The reason must never echo stdout: no banner text, no key material.
    expect(lookup.reason).not.toContain('banner line');
    expect(lookup.reason).not.toContain('sk-or-v1-realkey');
  });

  it('rejects a prefixed deprecation notice ahead of the real secret', async () => {
    const stdout = 'DEPRECATION: doppler v3 is old, upgrade soon\nsk-or-v1-realkey\nmore trailing junk\n';
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null, stdout));
    const { DopplerSecretProvider } = await loadSecrets();

    const lookup = await new DopplerSecretProvider().get('OPENROUTER_API_KEY');
    expect(lookup.value).toBeNull();
    expect(lookup.reason).toContain('3 lines');
    expect(lookup.reason).not.toContain('DEPRECATION');
    expect(lookup.reason).not.toContain('sk-or-v1-realkey');
  });

  it('rejects a single line with embedded whitespace (two tokens, not one)', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null, 'token-one token-two\n'));
    const { DopplerSecretProvider } = await loadSecrets();

    const lookup = await new DopplerSecretProvider().get('OPENROUTER_API_KEY');
    expect(lookup.value).toBeNull();
    expect(lookup.reason).toContain('single token');
    expect(lookup.reason).toContain('whitespace');
    expect(lookup.reason).not.toContain('token-one');
  });

  it('surfaces maxBuffer distinctly from "not logged in"', async () => {
    const err = Object.assign(new Error('stdout maxBuffer length exceeded'), {
      code: 'ERR_CHILD_PROCESS_STDOUT_MAXBUFFER',
    });
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(err, ''));
    const { DopplerSecretProvider } = await loadSecrets();

    const lookup = await new DopplerSecretProvider().get('OPENROUTER_API_KEY');
    expect(lookup.value).toBeNull();
    expect(lookup.reason).toContain('OPENROUTER_API_KEY');
    expect(lookup.reason).toContain('maxBuffer');
  });

  it('includes the exit code when doppler exits non-zero', async () => {
    const err = Object.assign(new Error('Command failed: doppler secrets get'), { code: 1 });
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(err, ''));
    const { DopplerSecretProvider } = await loadSecrets();

    const lookup = await new DopplerSecretProvider().get('OPENROUTER_API_KEY');
    expect(lookup.value).toBeNull();
    expect(lookup.reason).toContain('exited with code 1');
  });

  it('shells out to doppler with the secret name and the project/config from env, as an argument array', async () => {
    process.env.NANOBROWSER_DOPPLER_PROJECT = 'my-project';
    process.env.NANOBROWSER_DOPPLER_CONFIG = 'prod';
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null, 'v'));
    const { DopplerSecretProvider } = await loadSecrets();

    await new DopplerSecretProvider().get('OPENROUTER_API_KEY');

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = execFileMock.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(cmd).toBe('doppler');
    expect(args).toEqual(['secrets', 'get', 'OPENROUTER_API_KEY', '--plain', '-p', 'my-project', '-c', 'prod']);
    expect(opts).toMatchObject({ timeout: 20_000 });
  });

  it('defaults project/config when the env vars are unset', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null, 'v'));
    const { DopplerSecretProvider } = await loadSecrets();

    await new DopplerSecretProvider().get('OPENROUTER_API_KEY');

    const [, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(args).toEqual(['secrets', 'get', 'OPENROUTER_API_KEY', '--plain', '-p', 'ai-automation', '-c', 'dev']);
  });

  it('reports its own name as "doppler"', async () => {
    const { DopplerSecretProvider } = await loadSecrets();
    expect(new DopplerSecretProvider().name).toBe('doppler');
  });
});

describe('parseSecretToken', () => {
  it('accepts a lone token with surrounding newlines', async () => {
    const { parseSecretToken } = await loadSecrets();
    expect(parseSecretToken('\n  sk-or-v1-abc123  \n')).toEqual({ ok: true, token: 'sk-or-v1-abc123' });
  });

  it('rejects CRLF-joined output as multi-line', async () => {
    const { parseSecretToken } = await loadSecrets();
    const parsed = parseSecretToken('line-one\r\nline-two');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain('2 lines');
  });

  it('rejects tab-separated tokens', async () => {
    const { parseSecretToken } = await loadSecrets();
    const parsed = parseSecretToken('aaa\tbbb');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain('whitespace');
  });
});
