// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://hyperagent.com/threads" }
import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { RunEvent } from '@/src/messaging';
import { listUserscripts, saveUserscript } from './catalog';
import { BUNDLED_USERSCRIPTS } from './examples';
import { handleUserscriptMessage, type UserscriptMessageContext } from './index';
import { resetWorldConfiguration } from './runner';
import { vmUserScriptsApi } from './testing';

const URL_IN_SCOPE = 'https://hyperagent.com/threads';

describe('handleUserscriptMessage', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    resetWorldConfiguration();
  });

  it('seeds every bundled example the first time the panel lists scripts', async () => {
    const reply = await handleUserscriptMessage({ type: 'userscript.list', payload: {} });

    expect(reply?.type).toBe('userscript.list');
    const scripts = (reply as { payload: { scripts: Array<{ name: string }> } }).payload.scripts;
    expect(scripts.map((script) => script.name)).toEqual(BUNDLED_USERSCRIPTS.map((seed) => seed.name));
  });

  it('fills an empty name and matches from the header and ignores @grant', async () => {
    const reply = await handleUserscriptMessage({
      type: 'userscript.save',
      payload: {
        id: 'pasted',
        name: 'new script',
        matches: ['*://*/*'],
        code: `// ==UserScript==
// @name ebay ram
// @match https://www.ebay.com/*
// @grant none
// ==/UserScript==
return 1;`,
        updatedAt: 0,
      },
    });

    expect(reply?.type).toBe('userscript.list');
    const [saved] = await listUserscripts();
    expect(saved?.name).toBe('ebay ram');
    expect(saved?.matches).toEqual(['https://www.ebay.com/*']);
    expect(saved?.code).not.toContain('@grant');
    expect(saved?.code.trim()).toBe('return 1;');

    const api = vmUserScriptsApi();
    const run = await handleUserscriptMessage(
      { type: 'userscript.run', payload: { scriptId: 'pasted' } },
      { tabId: 4, url: 'https://www.ebay.com/sch/i.html', api },
    );
    expect(run).toMatchObject({ type: 'userscript.result', payload: { ok: true, value: 1 } });
    expect(api.injections[0]?.world).toBe('USER_SCRIPT');
  });

  it('saves a script and replies with the refreshed list', async () => {
    const reply = await handleUserscriptMessage({
      type: 'userscript.save',
      payload: { id: 'given-id', name: 'mine', matches: ['*://hyperagent.com/*'], code: 'return 1;', updatedAt: 0 },
    });

    expect(reply?.type).toBe('userscript.list');
    await expect(listUserscripts()).resolves.toMatchObject([{ id: 'given-id', name: 'mine' }]);
  });

  it('replies with an error, and stores nothing, when a save is invalid', async () => {
    const reply = await handleUserscriptMessage({
      type: 'userscript.save',
      payload: { id: 'x', name: '', matches: ['nonsense'], code: '', updatedAt: 0 },
    });

    expect(reply).toEqual({
      type: 'error',
      payload: { message: expect.stringContaining('invalid userscript'), inReplyTo: 'userscript.save' },
    });
    await expect(listUserscripts()).resolves.toEqual([]);
  });

  it('deletes and replies with the refreshed list', async () => {
    const saved = await saveUserscript({ name: 'mine', matches: ['*://hyperagent.com/*'], code: 'return 1;' });

    const reply = await handleUserscriptMessage({ type: 'userscript.delete', payload: { id: saved.id } });

    expect(reply).toEqual({ type: 'userscript.list', payload: { scripts: [] } });
  });

  it('runs a stored script, replies with the result, and emits its console to the run log', async () => {
    const saved = await saveUserscript({
      name: 'mine',
      matches: ['*://hyperagent.com/*'],
      code: "console.log('running');\nreturn 'ok';",
    });
    const events: RunEvent[] = [];
    const context: UserscriptMessageContext = {
      tabId: 4,
      url: URL_IN_SCOPE,
      api: vmUserScriptsApi(),
      emit: (event) => events.push(event),
    };

    const reply = await handleUserscriptMessage(
      { type: 'userscript.run', payload: { scriptId: saved.id } },
      context,
    );

    expect(reply).toMatchObject({
      type: 'userscript.result',
      payload: { scriptId: saved.id, ok: true, value: 'ok' },
    });
    expect(events).toEqual([
      { kind: 'userscript.output', scriptId: saved.id, level: 'log', text: 'running', at: expect.any(Number) },
    ]);
  });

  it('runs the panel’s edited code without persisting it (R-10)', async () => {
    const saved = await saveUserscript({
      name: 'mine',
      matches: ['*://hyperagent.com/*'],
      code: 'return 1;',
    });

    const reply = await handleUserscriptMessage(
      { type: 'userscript.run', payload: { scriptId: saved.id, code: 'return 2;' } },
      { tabId: 4, url: URL_IN_SCOPE, api: vmUserScriptsApi() },
    );

    expect(reply).toMatchObject({ type: 'userscript.result', payload: { value: 2 } });
    await expect(listUserscripts()).resolves.toMatchObject([{ code: 'return 1;' }]);
  });

  it('errors on an unknown script id and on a missing tab', async () => {
    await expect(
      handleUserscriptMessage({ type: 'userscript.run', payload: { scriptId: 'nope' } }, { tabId: 1 }),
    ).resolves.toEqual({
      type: 'error',
      payload: { message: 'unknown userscript: nope', inReplyTo: 'userscript.run' },
    });

    const saved = await saveUserscript({ name: 'mine', matches: ['*://hyperagent.com/*'], code: 'return 1;' });
    await expect(
      handleUserscriptMessage({ type: 'userscript.run', payload: { scriptId: saved.id } }, {}),
    ).resolves.toEqual({
      type: 'error',
      payload: { message: 'no target tab for the userscript run', inReplyTo: 'userscript.run' },
    });
  });

  it('resolves the tab through the context when no tabId is given', async () => {
    const saved = await saveUserscript({ name: 'mine', matches: ['*://hyperagent.com/*'], code: 'return 1;' });

    const reply = await handleUserscriptMessage(
      { type: 'userscript.run', payload: { scriptId: saved.id } },
      { resolveTabId: async () => 9, url: URL_IN_SCOPE, api: vmUserScriptsApi() },
    );

    expect(reply).toMatchObject({ type: 'userscript.result', payload: { ok: true } });
  });

  it('ignores messages it does not own', async () => {
    await expect(
      handleUserscriptMessage({ type: 'readiness.get', payload: {} }),
    ).resolves.toBeUndefined();
  });
});

describe('who owns a script after the user saves it', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  /**
   * A save from the panel is the user saving. Without this the `author: 'agent'`
   * stamp survived the user's own edit, so the agent could overwrite work the user
   * had put into a script it originally wrote.
   */
  it('makes an agent-written script the user\'s once they save it themselves', async () => {
    const agentScript = await saveUserscript({
      name: 'agent thing',
      matches: ['*://example.com/*'],
      code: 'return 1;',
      author: 'agent',
    });
    expect(agentScript.author).toBe('agent');

    await handleUserscriptMessage({
      type: 'userscript.save',
      payload: { ...agentScript, code: 'return 2; // my edit' },
    });

    const [stored] = await listUserscripts();
    expect(stored!.author).toBeUndefined();
    expect(stored!.code).toBe('return 2; // my edit');
  });
});
