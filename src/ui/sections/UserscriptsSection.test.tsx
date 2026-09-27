// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Userscript, UserscriptRunResult } from '@/src/messaging';
import { UserscriptsSection } from './UserscriptsSection';

afterEach(cleanup);

const SCRIPT: Userscript = {
  id: 'script-a',
  name: 'title probe',
  matches: ['*://example.com/*'],
  code: 'return document.title;',
  updatedAt: 10,
};

function setup(over: Partial<Parameters<typeof UserscriptsSection>[0]> = {}) {
  const handlers = {
    onSave: vi.fn(),
    onRun: vi.fn(),
    onDelete: vi.fn(),
    onRefresh: vi.fn(),
  };
  render(
    <UserscriptsSection
      scripts={[SCRIPT]}
      scriptsStatus="ready"
      runStatus="idle"
      {...handlers}
      {...over}
    />,
  );
  return handlers;
}

describe('UserscriptsSection editor', () => {
  it('loads the stored script into the editor', () => {
    setup();
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('title probe');
    expect((screen.getByLabelText('Matches') as HTMLInputElement).value).toBe('*://example.com/*');
    expect((screen.getByLabelText('Code') as HTMLTextAreaElement).value).toBe('return document.title;');
  });

  it('sends the live editor code on Run, without saving first (O-03)', async () => {
    const user = userEvent.setup();
    const handlers = setup();

    const code = screen.getByLabelText('Code');
    await user.clear(code);
    await user.type(code, 'return 1 + 1;');

    await user.click(screen.getByRole('button', { name: 'Run' }));

    expect(handlers.onRun).toHaveBeenCalledExactlyOnceWith('script-a', 'return 1 + 1;');
    expect(handlers.onSave).not.toHaveBeenCalled();
    expect(screen.getByText(/Run still uses exactly what is in the editor/)).toBeTruthy();
  });

  it('saves name, matches and code together', async () => {
    const user = userEvent.setup();
    const handlers = setup();

    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'probe 2');
    await user.clear(screen.getByLabelText('Matches'));
    await user.type(screen.getByLabelText('Matches'), '*://a.test/* *://b.test/*');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(handlers.onSave).toHaveBeenCalledOnce();
    const saved = handlers.onSave.mock.calls[0]?.[0] as Userscript;
    expect(saved.id).toBe('script-a');
    expect(saved.name).toBe('probe 2');
    expect(saved.matches).toEqual(['*://a.test/*', '*://b.test/*']);
    expect(saved.code).toBe('return document.title;');
  });

  it('starts a blank script without disturbing the stored one', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'new' }));
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('new script');
    expect(screen.getByRole('button', { name: /title probe/ })).toBeTruthy();
  });
});

describe('UserscriptsSection delete', () => {
  it('needs an inline confirm and never calls window.confirm', async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, 'confirm');
    const handlers = setup();

    await user.click(screen.getByRole('button', { name: 'delete' }));
    expect(handlers.onDelete).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Sure?' }));
    expect(handlers.onDelete).toHaveBeenCalledExactlyOnceWith('script-a');
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('can be backed out of', async () => {
    const user = userEvent.setup();
    const handlers = setup();

    await user.click(screen.getByRole('button', { name: 'delete' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(handlers.onDelete).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'delete' })).toBeTruthy();
  });
});

describe('UserscriptsSection results', () => {
  const result: UserscriptRunResult = {
    scriptId: 'script-a',
    ok: false,
    value: { title: 'Example' },
    error: 'TypeError: x is not a function',
    console: [
      { level: 'log', text: 'starting', at: 1 },
      { level: 'warn', text: 'slow selector', at: 2 },
      { level: 'error', text: 'boom', at: 3 },
    ],
    durationMs: 42,
  };

  it('shows the return value, the error and console lines by level', () => {
    setup({ result, runStatus: 'ready' });

    expect(screen.getByTestId('script-value').textContent).toBe(
      JSON.stringify({ title: 'Example' }, null, 2),
    );
    expect(screen.getByTestId('script-error').textContent).toContain('TypeError');

    const lines = screen.getByTestId('script-console').children;
    expect(lines).toHaveLength(3);
    expect(lines[1]?.className).toContain('amber');
    expect(lines[2]?.className).toContain('rose');
  });

  it('waits visibly while the worker has not answered', () => {
    setup({ runStatus: 'waiting' });
    expect(screen.getByText(/Waiting for the worker to run the script/)).toBeTruthy();
  });

  it('degrades when the worker has not sent the script list', () => {
    setup({ scripts: [], scriptsStatus: 'waiting' });
    expect(screen.getByText(/Waiting for the worker to send the script list/)).toBeTruthy();
  });
});

describe('editor error line and save', () => {
  it('moves the editor to the error line', () => {
    const code = Array.from({ length: 20 }, (_, index) => `const line${index} = ${index};`).join('\n');
    setup({
      scripts: [{ ...SCRIPT, code }],
      result: {
        scriptId: SCRIPT.id,
        ok: false,
        error: 'SyntaxError: Unexpected token (line 12, column 1)',
        console: [],
        durationMs: 4,
      },
    });

    const area = screen.getByLabelText('Code') as HTMLTextAreaElement;
    expect(area.scrollTop).toBe(11 * 16);
    expect(screen.getByTestId('script-lines').textContent).toContain('12');
    expect(area.value).toBe(code);
    expect(area.selectionStart).toBe(code.indexOf('const line11 '));
  });

  it('says where Save JSON wrote the file once the host confirms it', () => {
    setup({
      result: { scriptId: SCRIPT.id, ok: true, value: { rows: [] }, console: [], durationMs: 4 },
      saved: { filename: 'userscript.json', path: '/artifacts/panel/userscript.json', bytes: 12 },
    });

    expect(screen.getByTestId('script-saved').textContent).toContain('/artifacts/panel/userscript.json');
  });

  it('saves the result value when Save JSON is clicked', async () => {
    const onSaveResult = vi.fn();
    const value = { summary: [{ n: 1 }], rows: [{ id: 'a' }] };
    setup({
      onSaveResult,
      result: { scriptId: SCRIPT.id, ok: true, value, console: [], durationMs: 4 },
    });

    await userEvent.click(screen.getByRole('button', { name: 'Save JSON' }));
    expect(onSaveResult).toHaveBeenCalledWith(value);
  });
});

describe('who wrote each script (O-03)', () => {
  it('marks a script the agent wrote and leaves the user\'s own unmarked', () => {
    setup({
      scripts: [
        SCRIPT,
        { ...SCRIPT, id: 'script-b', name: 'agent probe', author: 'agent' as const },
      ],
    });

    // The agent authoring scripts into the user's catalog is only acceptable if
    // the user can see at a glance which ones are the agent's.
    const marks = screen.getAllByTitle('Written by the agent during a run');
    expect(marks).toHaveLength(1);
    expect(marks[0]!.textContent).toBe('agent');
  });
});
