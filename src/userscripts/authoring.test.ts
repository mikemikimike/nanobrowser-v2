/**
 * The rails on the agent's write path (O-03). These matter more than most tests
 * here: past this point, code a model wrote runs in the user's real logged-in
 * browser, so each rail is stated as the thing it prevents.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { Userscript } from '@/src/messaging';
import { MAX_AGENT_SCRIPTS, checkAgentMatches, writeAgentUserscript } from './authoring';
import { getUserscript, listUserscripts, saveUserscript, seedDefaults } from './catalog';
import { EBAY_RAM_COMPS } from './examples';

const good = {
  name: 'chatgpt-thread-extract',
  matches: ['*://chatgpt.com/*'],
  code: 'return document.title;',
};

describe('checkAgentMatches', () => {
  it('accepts a host written out in full', () => {
    expect(checkAgentMatches(['*://chatgpt.com/*'])).toEqual([]);
    expect(checkAgentMatches(['https://chatgpt.com/c/*'])).toEqual([]);
    expect(checkAgentMatches(['*://chatgpt.com/*', '*://chat.openai.com/*'])).toEqual([]);
  });

  it('refuses a script that would run on every site the user visits', () => {
    expect(checkAgentMatches(['<all_urls>'])[0]).toContain('does not name one host');
    expect(checkAgentMatches(['*://*/*'])[0]).toContain('does not name one host');
  });

  /**
   * The regression this rail was rewritten for. It used to refuse only a bare `*`
   * host, so `*://*.com/*` read as "a concrete host" -- while Chrome compiles the
   * `*.` form to /^(?:[^.]+\.)*com$/i, which matches chase.com and every other
   * .com site. Telling a public suffix from a real domain needs the public suffix
   * list; refusing host wildcards outright does not.
   */
  it('refuses a public-suffix wildcard, which used to read as a concrete host', () => {
    for (const pattern of ['*://*.com/*', '*://*.co.uk/*', '*://*.org/*', '*://*.github.io/*']) {
      expect(checkAgentMatches([pattern])[0]).toContain('does not name one host');
    }
  });

  it('refuses a subdomain wildcard too, rather than guessing where the line is', () => {
    expect(checkAgentMatches(['*://*.chatgpt.com/*'])[0]).toContain('does not name one host');
  });

  it('refuses to aim agent-written code at anything but the web', () => {
    expect(checkAgentMatches(['file://localhost/*'])[0]).toContain('may only run on http or https');
    expect(checkAgentMatches(['ftp://files.example.com/*'])[0]).toContain('may only run on http or https');
  });

  // `file:///*` parses with an empty host and a null host regex, i.e. it matches
  // anything. The scheme rail catches it as well, but a rail that is only safe
  // because another rail happens to cover it is one edit away from being a hole.
  it('refuses an empty host on its own, not only via the scheme check', () => {
    expect(checkAgentMatches(['file:///*'])[0]).toContain('does not name one host');
  });

  it('leaves ungrammatical patterns to the catalog rather than double-reporting them', () => {
    expect(checkAgentMatches(['not a pattern'])).toEqual([]);
  });
});

describe('writeAgentUserscript', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('stores a new script stamped as the agent\'s own', async () => {
    const result = await writeAgentUserscript(good);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(true);
    expect(result.script.author).toBe('agent');
    expect(await listUserscripts()).toHaveLength(1);
  });

  it('revises a script it wrote before, in place, keeping the id', async () => {
    const first = await writeAgentUserscript(good);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await writeAgentUserscript({
      scriptId: first.script.id,
      ...good,
      code: 'return document.querySelectorAll("article").length;',
    });

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.created).toBe(false);
    expect(second.script.id).toBe(first.script.id);
    expect(second.script.code).toContain('article');
    // Revised, not accumulated: iterating on a script must not fill the catalog.
    expect(await listUserscripts()).toHaveLength(1);
  });

  // The rail with real teeth: a user's script is work the agent did not do and
  // cannot reconstruct.
  it('refuses to write a bundled id and says to create a copy', async () => {
    await seedDefaults();
    const result = await writeAgentUserscript({
      scriptId: EBAY_RAM_COMPS.id,
      name: 'ebay-ram-comps',
      matches: ['*://www.ebay.com/*'],
      code: 'return 1;',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toContain('Omit scriptId to create a copy of your own');
  });

  it('can revise a new script that copies the bundled code', async () => {
    const created = await writeAgentUserscript({
      name: 'my-ram',
      matches: ['*://www.ebay.com/*'],
      code: EBAY_RAM_COMPS.code,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const revised = await writeAgentUserscript({
      scriptId: created.script.id,
      name: 'my-ram',
      matches: ['*://www.ebay.com/*'],
      code: 'return { summary: [], rows: [] };',
    });
    expect(revised.ok).toBe(true);
    if (!revised.ok) return;
    expect(revised.created).toBe(false);
    expect(revised.script.code).toContain('summary');
  });

  it('refuses to overwrite a script the user wrote', async () => {
    const mine = await saveUserscript({ name: 'mine', matches: ['*://chatgpt.com/*'], code: 'return 1;' });
    expect(mine.author).toBeUndefined();

    const result = await writeAgentUserscript({ scriptId: mine.id, ...good });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain('was written by the user');
    expect((await getUserscript(mine.id))?.code).toBe('return 1;');
  });

  it('refuses an all-sites allow-list and stores nothing', async () => {
    const write = vi.fn();
    const result = await writeAgentUserscript({ ...good, matches: ['<all_urls>'] }, { write });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toContain('does not name one host');
    expect(write).not.toHaveBeenCalled();
  });

  it('does not let a TLD wildcard reach the catalog', async () => {
    const result = await writeAgentUserscript({ ...good, matches: ['*://*.com/*'] });

    expect(result.ok).toBe(false);
    expect(await listUserscripts()).toEqual([]);
  });

  it('reports an unknown id instead of quietly creating a script under it', async () => {
    const result = await writeAgentUserscript({ scriptId: 'not-a-real-id', ...good });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain('no userscript with id not-a-real-id');
    expect(await listUserscripts()).toEqual([]);
  });

  it('passes the catalog\'s own validation through, and adds its rails to it', async () => {
    const result = await writeAgentUserscript({ name: '  ', matches: ['<all_urls>'], code: '' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const joined = result.errors.join(' | ');
    expect(joined).toContain('name must not be empty');
    expect(joined).toContain('code must not be empty');
    expect(joined).toContain('does not name one host');
  });

  it('does not read the catalog at all when creating', async () => {
    const read = vi.fn<(id: string) => Promise<Userscript | undefined>>();
    const result = await writeAgentUserscript(good, { read });

    expect(result.ok).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });
});

describe('writeAgentUserscript: the ceiling and the race', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('stops creating once the catalog holds MAX_AGENT_SCRIPTS of the agent\'s own', async () => {
    for (let i = 0; i < MAX_AGENT_SCRIPTS; i++) {
      const made = await writeAgentUserscript({ ...good, name: `script-${i}` });
      expect(made.ok).toBe(true);
    }

    const overflow = await writeAgentUserscript({ ...good, name: 'one-too-many' });

    expect(overflow.ok).toBe(false);
    if (overflow.ok) return;
    expect(overflow.errors[0]).toContain(`the limit is ${MAX_AGENT_SCRIPTS}`);
    expect(await listUserscripts()).toHaveLength(MAX_AGENT_SCRIPTS);
  });

  it('still lets it revise one of its own at the ceiling, because iterating is the point', async () => {
    let first = '';
    for (let i = 0; i < MAX_AGENT_SCRIPTS; i++) {
      const made = await writeAgentUserscript({ ...good, name: `script-${i}` });
      if (made.ok && i === 0) first = made.script.id;
    }

    const revised = await writeAgentUserscript({ scriptId: first, ...good, code: 'return 2;' });

    expect(revised.ok).toBe(true);
    expect(await listUserscripts()).toHaveLength(MAX_AGENT_SCRIPTS);
  });

  // The ownership check and the write are separated by an await. A panel save that
  // lands in that window used to be silently clobbered, and the script stayed
  // agent-owned; `requireAuthor` re-checks against the read the write is built from.
  it('does not clobber a user save that lands between the check and the write', async () => {
    const mine = await writeAgentUserscript(good);
    expect(mine.ok).toBe(true);
    if (!mine.ok) return;

    const result = await writeAgentUserscript(
      { scriptId: mine.script.id, ...good, code: 'AGENT CODE' },
      {
        // The agent's own script when the check reads it...
        read: async () => ({ ...mine.script }),
        // ...but the user has saved over it by the time the write runs.
        list: async () => [{ ...mine.script }],
        write: async (draft, now, options) => {
          await saveUserscript({ id: mine.script.id, name: 'mine now', matches: good.matches, code: 'USER CODE' });
          return saveUserscript(draft, now, options);
        },
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain('was written by the user and cannot be overwritten');
    expect((await getUserscript(mine.script.id))?.code).toBe('USER CODE');
  });
});
