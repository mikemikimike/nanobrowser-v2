import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { cassetteDir } from './paths.ts';
import { KILO_BASE, OPENROUTER_BASE } from './protocol.ts';
import type { CassetteMode, LlmRequestMsg } from './protocol.ts';

/** Recursively key-sorted JSON so an identical request always hashes identically. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export class OffOriginError extends Error {}

/** The two model sources the host will proxy to and attach a credential for (docs/host-protocol.md). */
export type KnownOrigin = 'openrouter' | 'kilo';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const KNOWN_BASES: Record<KnownOrigin, { origin: string; prefix: string }> = {
  openrouter: { origin: new URL(OPENROUTER_BASE).origin, prefix: '/api/v1' },
  kilo: { origin: new URL(KILO_BASE).origin, prefix: '/api/gateway' },
};

function stripQueryAndSlashes(s: string): string {
  const q = s.indexOf('?');
  const query = q >= 0 ? s.slice(q) : '';
  const path = (q >= 0 ? s.slice(0, q) : s).replace(/^\/+/, '').replace(/\/+$/, '');
  return path + query;
}

/**
 * Splits a request target into its path (with no leading/trailing slash and no
 * known-origin prefix) and which known origin it named, if any. An absolute URL
 * is accepted only if it is on one of the known origins -- anything else throws
 * rather than being silently rewritten, so a client cannot aim the host at
 * another host and have a credential attached to it (C-06/security seam).
 *
 * A relative path (no scheme) has no origin of its own -- callers that need one
 * default it themselves (`resolveUrl` in llm.ts defaults to OpenRouter, for
 * backward compatibility with paths sent before Kilo existed).
 */
export function normalizeRequest(url: string): { path: string; origin: KnownOrigin | null } {
  const s = url.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || s.startsWith('//')) {
    const abs = new URL(s.startsWith('//') ? `https:${s}` : s);
    const entry = (Object.entries(KNOWN_BASES) as Array<[KnownOrigin, { origin: string; prefix: string }]>).find(
      ([, v]) => v.origin === abs.origin,
    );
    if (!entry) {
      throw new OffOriginError(`refusing to proxy off-origin url: ${abs.origin}`);
    }
    const [origin, { prefix }] = entry;
    const prefixRe = new RegExp(`^${escapeRegExp(prefix)}(?=/|$)`);
    const path = abs.pathname.replace(prefixRe, '') + abs.search;
    return { path: stripQueryAndSlashes(path), origin };
  }
  return { path: stripQueryAndSlashes(s), origin: null };
}

/**
 * The path alone, origin stripped. Cassette identity (`cassetteKey` below) never
 * included the origin even before Kilo existed, so this stays origin-agnostic.
 */
export function normalizePath(url: string): string {
  return normalizeRequest(url).path;
}

/**
 * Cassette identity is (url, model, messages) only. Sampling knobs, stream flags
 * and provider preferences deliberately do not participate, so a replay still
 * matches after an unrelated request-shape tweak.
 */
export function cassetteKey(msg: Pick<LlmRequestMsg, 'url' | 'body'>): string {
  const body = (msg.body ?? {}) as Record<string, unknown>;
  const canonical = stableStringify({
    url: normalizePath(msg.url),
    model: body['model'] ?? null,
    messages: body['messages'] ?? null,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export interface CassetteEntry {
  key: string;
  url: string;
  model: unknown;
  status: number;
  headers: Record<string, string>;
  /** base64 slices of the raw upstream body, in order. */
  chunks: string[];
}

export function cassetteMode(env: NodeJS.ProcessEnv = process.env): CassetteMode {
  const v = env['NANOBROWSER_CASSETTE'];
  return v === 'record' || v === 'replay' ? v : 'off';
}

export class CassetteStore {
  readonly #dir: string;

  constructor(dir: string = cassetteDir()) {
    this.#dir = dir;
  }

  /**
   * A key is a bare filename token (in practice a sha256 hex digest). Anything
   * with a separator or dot could climb out of the cassette directory, so it is
   * refused rather than joined.
   */
  fileFor(key: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(key)) {
      throw new Error(`refusing cassette key that is not a plain filename: ${JSON.stringify(key.slice(0, 80))}`);
    }
    return path.join(this.#dir, `${key}.json`);
  }

  async read(key: string): Promise<CassetteEntry | null> {
    try {
      const file = this.fileFor(key);
      if (!(await isPlainFileOrAbsent(file))) return null;
      return JSON.parse(await fs.readFile(file, 'utf8')) as CassetteEntry;
    } catch {
      return null;
    }
  }

  async write(entry: CassetteEntry): Promise<void> {
    await fs.mkdir(this.#dir, { recursive: true });
    const file = this.fileFor(entry.key);
    if (!(await isPlainFileOrAbsent(file))) {
      throw new Error(
        `refusing cassette write to a non-regular file: ${JSON.stringify(entry.key.slice(0, 80))}`,
      );
    }
    await fs.writeFile(file, JSON.stringify(entry, null, 2) + '\n', 'utf8');
  }
}

/**
 * True when `file` is absent or a plain file. A symlink inside the cassette
 * directory is never followed: a planted link would otherwise redirect a write
 * outside the directory or serve foreign bytes as a replayed response.
 */
async function isPlainFileOrAbsent(file: string): Promise<boolean> {
  const st = await fs.lstat(file).catch(() => null);
  return st === null || st.isFile();
}
