/**
 * M9 policy modes: read-only tool boundary, the advisory userscript scan, and
 * #14's explicitly all-allow-by-default decisions.
 */
import { describe, expect, it } from 'vitest';
import { TOOL_NAMES } from './tools';
import { allowedInReadOnly, decisionFor, isReadOnlyScript, READ_ONLY_BLOCKED_TOOL_NAMES } from './policy';

describe('allowedInReadOnly (#13)', () => {
  it('keeps every read, navigation, save, and terminal tool, and nothing else', () => {
    const allowed = TOOL_NAMES.filter(allowedInReadOnly);
    expect(allowed.sort()).toEqual(
      ['snapshot', 'screenshot', 'extract_text', 'get_box', 'scroll', 'navigate', 'run_userscript', 'list_userscripts', 'read_userscript', 'save_file', 'wait', 'done', 'blocked'].sort(),
    );
  });

  it('blocks acting tools including hover and the catalog write', () => {
    for (const name of ['click', 'hover', 'type', 'press', 'select', 'download', 'write_userscript']) {
      expect(READ_ONLY_BLOCKED_TOOL_NAMES.has(name)).toBe(true);
      expect(allowedInReadOnly(name)).toBe(false);
    }
  });
});

describe('isReadOnlyScript (#13 advisory scan)', () => {
  it('passes a pure reader, including a GET self-read like the bundled probe', () => {
    expect(
      isReadOnlyScript('const r = await fetch(location.href); return (await r.text()).length;'),
    ).toEqual({ ok: true });
    expect(isReadOnlyScript('return [...document.querySelectorAll("h1")].map((h) => h.textContent);')).toEqual({
      ok: true,
    });
  });

  it('refuses DOM writes, submits, clicks, POSTs, and storage writes, naming the reason', () => {
    const cases = [
      'el.innerHTML = rows;',
      'document.write("x");',
      'form.submit();',
      'button.click();',
      'el.dispatchEvent(new Event("input"));',
      'await fetch("/api", { method: "POST", body });',
      'localStorage.setItem("k", "v");',
      'new XMLHttpRequest();',
      'node.textContent = "x";',
      'node.innerText = "x";',
      'input.value = "x";',
      'node.remove();',
      'form.requestSubmit();',
      'await fetch("/api/1", { method: "DELETE" });',
      'await fetch("/api/1", { method: "PUT", body });',
    ];
    for (const code of cases) {
      const result = isReadOnlyScript(code);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('read-only run');
    }
  });

  it('still passes reads and comparisons shaped like writes', () => {
    expect(isReadOnlyScript('return el.textContent === "ready";')).toEqual({ ok: true });
    expect(isReadOnlyScript('if (el.innerHTML == "") return null;')).toEqual({ ok: true });
    expect(isReadOnlyScript('return form.querySelector("input");')).toEqual({ ok: true });
  });
});

describe('decisionFor (#14 revised direction: autonomous by default)', () => {
  it('allows every category when nothing is configured', () => {
    for (const category of ['authentication', 'submit', 'commerce', 'communication', 'destructive'] as const) {
      expect(decisionFor(category)).toBe('allow');
      expect(decisionFor(category, {})).toBe('allow');
    }
  });

  it('honors an explicit deny and leaves the rest allowed', () => {
    expect(decisionFor('commerce', { commerce: 'deny' })).toBe('deny');
    expect(decisionFor('submit', { commerce: 'deny' })).toBe('allow');
  });

  it('has no confirm/pause state: the only decisions are allow or deny', () => {
    expect(decisionFor('destructive', { destructive: 'deny' })).toBe('deny');
    expect(decisionFor('destructive', { destructive: 'allow' })).toBe('allow');
  });
});
