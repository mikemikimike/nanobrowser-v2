import { execFile } from 'node:child_process';
import { protectSecret } from './log.ts';

/**
 * One narrow seam for credential lookup (C-06: Doppler now, OpenBao or the OS
 * keychain later). Swapping the backend must never touch the protocol or the
 * extension. Values are held in process memory only -- never written, logged or
 * echoed anywhere.
 *
 * A lookup that yields no key carries a reason (never the secret itself, never
 * stdout verbatim): `SecretStore` surfaces it via `status()`/`missingReason`,
 * which is what `nb-status` and `key.status` report. A bare null with no reason
 * falls back to "<NAME> not available from <provider>".
 */
export interface SecretLookup {
  value: string | null;
  reason?: string;
}

export interface SecretProvider {
  readonly name: string;
  /**
   * Looks up one secret. A null value carries a reason that lands in host.log
   * and nb-status — so reasons must be categorical (exit codes, signals, shapes),
   * never child-process output or anything secret-shaped. See `describeDopplerError`.
   */
  get(name: string): Promise<SecretLookup>;
}

/**
 * Issue #5: `doppler secrets get --plain` should print exactly the secret, but a
 * misconfigured wrapper can prefix a banner/deprecation notice on stdout ahead of
 * the real value. The old code `trim()`ed that whole blob and used it verbatim as
 * the bearer token, so a live `GET /key` went out with `Authorization: Bearer
 * <banner>\n<real key>` and came back 401 (or was rejected as an invalid header
 * value before it ever left). Parse out a single token instead: anything that is
 * not exactly one whitespace-free token is rejected, and the reason names the
 * shape (line count, embedded whitespace) -- never the content.
 */
export function parseSecretToken(stdout: unknown): { ok: true; token: string } | { ok: false; reason: string } {
  const trimmed = String(stdout).trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty output' };
  const lines = trimmed.split(/\r?\n/);
  if (lines.length > 1) return { ok: false, reason: `expected a single token but got ${lines.length} lines` };
  if (/\s/.test(trimmed)) return { ok: false, reason: 'expected a single token but got embedded whitespace' };
  return { ok: true, token: trimmed };
}

/**
 * Names a Doppler exec failure without repeating anything the child wrote. Node folds
 * the child's stderr into `err.message`, so the message is untrusted input that could
 * carry secret material into the reason (which lands in host.log and nb-status) —
 * only categorical fields (exit code, signal, errno, maxBuffer) are ever relayed.
 */
function describeDopplerError(err: unknown): string {
  const { code, signal, killed } = err as { code?: unknown; signal?: unknown; killed?: unknown };
  if (code === 'ERR_CHILD_PROCESS_STDOUT_MAXBUFFER') {
    return 'stdout exceeded 1 MiB maxBuffer (output too large to be a key)';
  }
  if (code === 'ENOENT') return 'doppler binary not found on PATH';
  if (killed === true) {
    return `doppler killed${typeof signal === 'string' && signal ? ` by signal ${signal}` : ''} (no key read)`;
  }
  if (typeof code === 'number') {
    return `doppler exited with code ${code}${typeof signal === 'string' && signal ? ` (signal ${signal})` : ''}`;
  }
  if (typeof code === 'string' && code.length > 0) return `doppler failed (${code})`;
  return 'doppler failed';
}

const DOPPLER_PROJECT = process.env.NANOBROWSER_DOPPLER_PROJECT || 'ai-automation';
const DOPPLER_CONFIG = process.env.NANOBROWSER_DOPPLER_CONFIG || 'dev';

export class DopplerSecretProvider implements SecretProvider {
  readonly name = 'doppler';

  get(name: string): Promise<SecretLookup> {
    return new Promise((resolve) => {
      execFile(
        'doppler',
        ['secrets', 'get', name, '--plain', '-p', DOPPLER_PROJECT, '-c', DOPPLER_CONFIG],
        { timeout: 20_000, maxBuffer: 1 << 20, env: process.env },
        (err, stdout) => {
          // stderr is deliberately dropped: doppler echoes context we do not need
          // and we will not risk relaying anything secret-shaped into the log.
          if (err) return resolve({ value: null, reason: `${name} from doppler failed: ${describeDopplerError(err)}` });
          const parsed = parseSecretToken(stdout);
          if (!parsed.ok) return resolve({ value: null, reason: `${name} from doppler invalid: ${parsed.reason}` });
          resolve({ value: parsed.token });
        },
      );
    });
  }
}

/** Test double. Never reaches the network or a real store. */
export class FakeSecretProvider implements SecretProvider {
  readonly name = 'fake';
  readonly #values: Record<string, string | null>;

  constructor(values: Record<string, string | null>) {
    this.#values = values;
  }

  async get(name: string): Promise<SecretLookup> {
    return { value: this.#values[name] ?? null };
  }
}

/** The two credentialed model sources (docs/host-protocol.md). Add here, not as a third seam. */
export type SecretSource = 'openrouter' | 'kilo';

const SECRET_ENV_NAMES: Record<SecretSource, string> = {
  openrouter: 'OPENROUTER_API_KEY',
  kilo: 'KILO_CODE_API_KEY',
};

interface SourceState {
  key: string | null;
  reason?: string;
}

function emptyState(): SourceState {
  return { key: null };
}

/**
 * Holds one credential per source. Loading both is independent: a Kilo key being
 * absent must not stop OpenRouter from working and vice versa (neither missing
 * secret may crash the host), so `load()` fetches them in parallel and each
 * source keeps its own present/absent state and its own reason when absent.
 */
export class SecretStore {
  #state: Record<SecretSource, SourceState> = { openrouter: emptyState(), kilo: emptyState() };

  readonly #provider: SecretProvider;

  constructor(provider: SecretProvider) {
    this.#provider = provider;
  }

  async load(): Promise<void> {
    await Promise.all((Object.keys(SECRET_ENV_NAMES) as SecretSource[]).map((source) => this.#loadSource(source)));
  }

  async #loadSource(source: SecretSource): Promise<void> {
    const envName = SECRET_ENV_NAMES[source];
    const lookup = await this.#provider.get(envName);
    if (!lookup.value) {
      this.#state[source] = {
        key: null,
        reason: lookup.reason ?? `${envName} not available from ${this.#provider.name}`,
      };
      return;
    }
    // Defence in depth: every provider's value is validated here, not just
    // Doppler's, so a future backend (OpenBao, keychain) cannot smuggle a
    // multi-line blob into an Authorization header either. The key stays null,
    // so `LlmProxy.keyStatus()` reports this reason without ever attempting
    // the live GET /key that used to 401.
    const parsed = parseSecretToken(lookup.value);
    if (!parsed.ok) {
      this.#state[source] = {
        key: null,
        reason: `${envName} from ${this.#provider.name} invalid: ${parsed.reason}`,
      };
      return;
    }
    protectSecret(parsed.token);
    this.#state[source] = { key: parsed.token };
  }

  /** The key for one source. Callers must only put it in an outbound Authorization header. */
  key(source: SecretSource): string | null {
    return this.#state[source].key;
  }

  /** Per-source readiness (R-11 pattern applied to credentials, C-06): loaded or not, and why not. */
  status(source: SecretSource): { ready: boolean; reason?: string } {
    const state = this.#state[source];
    return state.key ? { ready: true } : { ready: false, ...(state.reason ? { reason: state.reason } : {}) };
  }

  /**
   * Back-compat single-source accessors from before Kilo existed. `llm.ts`'s wire-level
   * `key.status` message still validates OpenRouter specifically (a live `GET /key`), so
   * these keep that call site unchanged.
   */
  get openRouterKey(): string | null {
    return this.key('openrouter');
  }

  get missingReason(): string | undefined {
    return this.#state.openrouter.reason;
  }
}
