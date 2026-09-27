/**
 * Run policy modes (M9: issues #13 read-only, #14 sensitive-action gating).
 *
 * Two very different shapes live here on purpose:
 *
 * - Read-only mode (#13) is a coarse, predictable, auditable mode switch: the
 *   Follower toolset drops every acting tool and the runtime refuses them in
 *   depth. The blocked set is below ({@link READ_ONLY_BLOCKED_TOOL_NAMES}).
 * - Sensitive-action gating (#14) is, by the issue's own superseding direction,
 *   NOT a default-deny engine: ordinary authorized runs proceed without
 *   per-action approval ("I don't want to have to have any human in the loop
 *   gates here"). So this module is a pure classifier plus an explicit,
 *   all-allow-by-default decision function — no pause/confirm state is inserted
 *   into the run path, and with nothing configured behavior is exactly today's.
 *
 * Pure functions only, no chrome imports: unit-testable with fixtures.
 */

/**
 * Tools unavailable in a read-only run (#13). Reads, navigation, scrolling,
 * waiting, listing/running *read-only* userscripts, saving, and the terminal
 * tools stay. `hover` is out: it moves the pointer and opens hover-revealed
 * UI — not provably mutation-free. `get_box` stays: a pure read, in the spirit
 * of the snapshot. Future coordinate-click tools belong in this set.
 */
export const READ_ONLY_BLOCKED_TOOL_NAMES: ReadonlySet<string> = new Set([
  'click',
  'hover',
  'type',
  'press',
  'select',
  'download',
  'write_userscript',
]);

/** True when `name` may be bound in a read-only run. */
export function allowedInReadOnly(name: string): boolean {
  return !READ_ONLY_BLOCKED_TOOL_NAMES.has(name);
}

export type PolicyCategory = 'authentication' | 'submit' | 'commerce' | 'communication' | 'destructive';
export type PolicyDecision = 'allow' | 'deny';
export type OptionalPolicy = Partial<Record<PolicyCategory, PolicyDecision>>;

/**
 * The decision for one sensitive category under an explicit optional policy
 * (#14, revised direction). Unconfigured categories allow: there are no hidden
 * defaults, no mandatory approvals, and no blanket credential-adjacent denial
 * on the default path. Credential-destination matching and secret redaction
 * live in the authentication implementation and the log redactors — not here.
 */
export function decisionFor(category: PolicyCategory, configured: OptionalPolicy = {}): PolicyDecision {
  return configured[category] ?? 'allow';
}

/**
 * Best-effort static scan deciding whether a userscript is safe to run in a
 * read-only run (#13: "no DOM writes / form submits / fetch-POST" and the obvious
 * siblings: text/value assignment, node removal, requestSubmit, PUT/PATCH/DELETE).
 *
 * Advisory, not a guarantee — hence the name: exotic widgets and renamed
 * harnesses slip past any regex, and a plain GET fetch (like the bundled i03
 * probe's self-read) stays allowed because reading is what this mode is for.
 * Assignment patterns exclude `==`/`===` so comparing a property still passes.
 * When the source is unavailable the caller must refuse, not guess.
 */
export function isReadOnlyScript(code: string): { ok: boolean; reason?: string } {
  const patterns: Array<[RegExp, string]> = [
    [/\.innerHTML\s*=(?!=)/, 'assigns innerHTML'],
    [/\.outerHTML\s*=(?!=)/, 'assigns outerHTML'],
    [/\.textContent\s*=(?!=)/, 'assigns textContent'],
    [/\.innerText\s*=(?!=)/, 'assigns innerText'],
    [/\.outerText\s*=(?!=)/, 'assigns outerText'],
    [/\.value\s*=(?!=)/, 'assigns a value'],
    [/document\.write\s*\(/, 'calls document.write'],
    [/\.submit\s*\(/, 'submits a form'],
    [/requestSubmit\s*\(/, 'submits a form'],
    [/\.click\s*\(/, 'clicks an element'],
    [/\.remove\s*\(/, 'removes an element'],
    [/dispatchEvent\s*\(/, 'dispatches an event'],
    [/execCommand\s*\(/, 'runs execCommand'],
    [/method\s*:\s*['"](POST|PUT|PATCH|DELETE)/i, 'writes over fetch'],
    [/XMLHttpRequest/, 'uses XMLHttpRequest'],
    [/localStorage|sessionStorage|indexedDB/, 'writes web storage'],
  ];
  for (const [pattern, reason] of patterns) {
    if (pattern.test(code)) return { ok: false, reason: `script ${reason}, which a read-only run must not do` };
  }
  return { ok: true };
}
