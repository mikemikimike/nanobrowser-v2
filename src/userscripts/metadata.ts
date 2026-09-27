/**
 * Reads a Greasemonkey metadata block (`// ==UserScript==` … `// ==/UserScript==`).
 *
 * The behaviour we need — `@name` and `@match`, and the body after the block — follows
 * Violentmonkey's MIT `parseMeta` (`src/background/utils/script.js` in
 * violentmonkey/violentmonkey). This is that slice, not their injector. `@grant` and
 * `@inject-into` are ignored: every script here runs in the USER_SCRIPT world.
 */

export interface UserscriptMetadata {
  name?: string;
  matches: string[];
  /** Source with the metadata block removed. */
  body: string;
}

const BLOCK = /(?:^|\n)[ \t]*\/{1,2}[ \t]*==UserScript==[ \t]*\n([\s\S]*?)\n[ \t]*\/{1,2}[ \t]*==\/UserScript==[ \t]*/;

/** Pulls `@name` and `@match` out of a pasted userscript. Returns null when there is no block. */
export function parseUserscriptMetadata(source: string): UserscriptMetadata | null {
  // A paste from a Windows editor or an old Mac file can carry CRLF or bare CR.
  const code = source.replace(/\r\n?/g, '\n');
  const found = BLOCK.exec(code);
  if (!found) return null;
  const header = found[1] ?? '';
  let name: string | undefined;
  const matches: string[] = [];
  for (const line of header.split('\n')) {
    const meta = line.match(/^[ \t]*\/\/\s*@(\S+)\s*(.*?)\s*$/);
    if (!meta) continue;
    const key = meta[1];
    const value = meta[2] ?? '';
    if (key === 'name' && value) name = value;
    if (key === 'match' && value) matches.push(value);
  }
  const body = (code.slice(0, found.index) + code.slice(found.index + found[0].length)).replace(/^\n/, '');
  return { ...(name ? { name } : {}), matches, body };
}

/** A draft whose name or matches were never chosen picks them up from the header. */
export function applyUserscriptHeader<T extends { name: string; matches: string[]; code: string }>(draft: T): T {
  const parsed = parseUserscriptMetadata(draft.code);
  if (!parsed) return draft;
  const nameUnset = draft.name.trim() === '' || draft.name.trim() === 'new script';
  const matchesUnset =
    draft.matches.length === 0 || (draft.matches.length === 1 && draft.matches[0] === '*://*/*');
  return {
    ...draft,
    name: nameUnset && parsed.name ? parsed.name : draft.name,
    matches: matchesUnset && parsed.matches.length > 0 ? parsed.matches : draft.matches,
    code: parsed.body,
  };
}
