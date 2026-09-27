/**
 * The agent's own write path into the catalog (R-09/R-10, O-03).
 *
 * O-03 asked what "the agent can debug userscripts live" includes. The answer the
 * user gave on 2026-09-04 is *the agent writes and iterates scripts*: it authors
 * the code, runs it, reads the console and the error, and revises. Breakpoints are
 * explicitly out — they would need `chrome.debugger`, whose permanent infobar is a
 * hard failure of R-02.
 *
 * That makes this module the boundary where model-written code becomes something
 * that will execute in the user's real, logged-in browser, so the rails live here
 * rather than in the tool description, where a model may simply not comply:
 *
 *   1. **A named host, with no wildcard in it.** The agent has to write out where
 *      its code runs. `<all_urls>`, `*`, and `*.com` alike are refused — see
 *      {@link checkAgentMatches} for why the `*.` form has to go too. Without this
 *      the agent could write a script that runs on the user's bank.
 *   2. **http/https only.** No `file://`, so agent-written code cannot be aimed at
 *      the local filesystem.
 *   3. **Never overwrite a human's script.** Updating by id requires that the
 *      stored script was itself agent-written, checked once here and again inside
 *      the write against the same read that performs it, so a save that lands
 *      between the two cannot be clobbered. The user's own scripts are theirs, and
 *      a script the user saves from the panel becomes theirs from then on.
 *   4. **A ceiling on how many.** {@link MAX_AGENT_SCRIPTS} of them. Iterating on
 *      one script revises it in place, so hitting this means the agent is creating
 *      rather than fixing, and the catalog is the user's to read.
 *
 * Everything else — name, pattern grammar, code size — is the catalog's ordinary
 * validation, reused rather than restated.
 */
import type { Userscript } from '@/src/messaging';
import { getUserscript, listUserscripts, saveUserscript, validateUserscript, type UserscriptDraft } from './catalog';
import { parseMatchPattern } from './match-pattern';

/** Schemes an agent-authored script may target. */
export const AGENT_ALLOWED_SCHEMES = ['http', 'https'] as const;

/**
 * How many scripts the agent may leave in the catalog.
 *
 * The debug loop revises in place, so a run that is working normally holds at one
 * or two. Reaching this means something is creating instead of fixing, and every
 * one of them is a row the user has to read in their own panel. `MAX_CODE_BYTES`
 * bounds each script; nothing bounded the count.
 */
export const MAX_AGENT_SCRIPTS = 20;

export interface AgentScriptRequest {
  /** Omit to create. Give the id of an agent-written script to revise it. */
  scriptId?: string;
  name: string;
  matches: string[];
  code: string;
}

export type AgentWriteResult =
  | { ok: true; script: Userscript; created: boolean }
  | { ok: false; errors: string[] };

/**
 * Checks the allow-list an agent asked for against rails 1 and 2. Returns the
 * problems, empty when the patterns are acceptable.
 *
 * Grammar errors are left to {@link validateUserscript}: reporting "invalid match
 * pattern" twice, in two different wordings, helps nobody.
 *
 * **No wildcard in the host at all**, rather than the narrower "not a bare `*`".
 * The first version of this rail refused only `host === '*'`, which an adversarial
 * review broke in one character: `*://*.com/*` names a "concrete" host by that
 * test, and Chrome's `*.` form compiles to `/^(?:[^.]+\.)*com$/i`, so it matched
 * `chase.com`, `bankofamerica.com` and every other `.com` site — precisely the
 * outcome this rail exists to prevent. Telling `*.com` from `*.example.com` needs
 * the public suffix list (`*.co.uk` is a sweep too, and `*.github.io`, and so on),
 * which is a large data file that is wrong the moment it is out of date. Refusing
 * host wildcards outright needs no data, cannot drift, and costs the agent only
 * the effort of naming each host it means.
 *
 * An empty host is refused here as well as by the scheme rail. `file:///*` parses
 * with `host: ''` and a `null` host regex, i.e. it matches anything; rail 2 catches
 * it today, but a rail that is only safe because a *different* rail happens to
 * cover it is one scheme-list edit away from being a hole.
 */
export function checkAgentMatches(matches: string[]): string[] {
  const errors: string[] = [];
  for (const pattern of matches) {
    const parsed = parseMatchPattern(pattern);
    if (!parsed) continue;

    if (parsed.host === '' || parsed.host.includes('*')) {
      errors.push(
        `${JSON.stringify(pattern)} does not name one host. Write each host out in full, ` +
          'e.g. ["*://example.com/*", "*://www.example.com/*"] as two patterns. ' +
          'A wildcard host such as "*" or "*.com" matches sites you were not asked to touch.',
      );
      continue;
    }

    const disallowed = parsed.schemes.filter(
      (scheme) => !(AGENT_ALLOWED_SCHEMES as readonly string[]).includes(scheme),
    );
    if (disallowed.length > 0) {
      errors.push(
        `${JSON.stringify(pattern)} targets ${disallowed.join(', ')}; a script you write may only run on http or https.`,
      );
    }
  }
  return errors;
}

export interface AgentWriteDeps {
  read?: (id: string) => Promise<Userscript | undefined>;
  list?: () => Promise<Userscript[]>;
  write?: (draft: UserscriptDraft, now?: () => number, options?: { requireAuthor?: 'agent' }) => Promise<Userscript>;
  now?: () => number;
}

/**
 * Creates or revises an agent-authored script. Returns the problems rather than
 * throwing, because the caller is a tool whose whole purpose is to hand the model
 * something it can act on — a rejected write is one turn of the loop, not a crash.
 */
export async function writeAgentUserscript(
  request: AgentScriptRequest,
  deps: AgentWriteDeps = {},
): Promise<AgentWriteResult> {
  const read = deps.read ?? getUserscript;
  const list = deps.list ?? listUserscripts;
  const write = deps.write ?? saveUserscript;

  const matches = Array.isArray(request?.matches) ? request.matches : [];
  const draft: UserscriptDraft = {
    ...(request.scriptId ? { id: request.scriptId } : {}),
    name: request?.name ?? '',
    matches,
    code: request?.code ?? '',
    author: 'agent',
  };

  // Grammar and size first, so a nonsense pattern is reported as nonsense rather
  // than as a policy violation.
  const validated = validateUserscript(draft, deps.now);
  const errors = validated.ok ? [] : [...validated.errors];
  errors.push(...checkAgentMatches(matches));

  let created = true;
  if (request.scriptId) {
    const existing = await read(request.scriptId);
    if (!existing) {
      errors.push(
        `no userscript with id ${request.scriptId}. Omit scriptId to create a new one.`,
      );
    } else if (existing.author !== 'agent') {
      // Rail 3. The user's scripts are the user's; silently rewriting one would
      // destroy work with no record of what it used to be.
      errors.push(
        `${request.scriptId} ("${existing.name}") was written by the user and cannot be ` +
          'overwritten. Omit scriptId to create a copy of your own.',
      );
    } else {
      created = false;
    }
  }

  if (created) {
    const mine = (await list()).filter((script) => script.author === 'agent');
    if (mine.length >= MAX_AGENT_SCRIPTS) {
      errors.push(
        `you already have ${mine.length} scripts saved (the limit is ${MAX_AGENT_SCRIPTS}). ` +
          'Revise one of yours by passing its scriptId instead of creating another.',
      );
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  // `requireAuthor` re-checks ownership against the same read the write is built
  // from. The check above is separated from the write by an await, so on its own it
  // is a TOCTOU: a panel save landing in that window would be silently clobbered.
  try {
    return { ok: true, script: await write(draft, deps.now, { requireAuthor: 'agent' }), created };
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
}
