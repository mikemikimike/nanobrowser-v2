// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { refCount, resolveRef, shadowRootOf, snapshot } from '@/src/page/snapshot';

function mount(html: string): void {
  document.body.innerHTML = html;
}

function lines(text: string): string[] {
  return text.length ? text.split('\n') : [];
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

describe('snapshot format', () => {
  it('emits one node per line as `- role "name" [ref=eNN] {attrs}`', () => {
    mount('<button>Add to cart</button>');
    const result = snapshot();
    expect(lines(result.text)).toEqual(['- button "Add to cart" [ref=e1]']);
    expect(result.nodes).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it('indents by emitted tree depth', () => {
    mount('<nav aria-label="Main"><ul><li><a href="/a">Alpha</a></li></ul></nav>');
    expect(lines(snapshot().text)).toEqual([
      '- navigation "Main" [ref=e1]',
      '  - list [ref=e2]',
      '    - listitem [ref=e3]',
      '      - link "Alpha" [ref=e4] {href=/a}',
    ]);
  });

  it('carries form-control attributes and collapses whitespace in text', () => {
    mount('<input type="email" placeholder="you@example.com"><p>  hello \n  world  </p>');
    const text = snapshot().text;
    expect(text).toContain('- textbox "you@example.com" [ref=e1] {type=email placeholder="you@example.com"}');
    expect(text).toContain('- text "hello world"');
  });

  it('reports the live value of a text input', () => {
    mount('<input type="text" aria-label="Query">');
    (document.querySelector('input') as HTMLInputElement).value = 'shoes';
    expect(snapshot().text).toContain('{type=text value="shoes"}');
  });

  it('withholds the value of a filled password input (R-12)', () => {
    mount('<input type="password" aria-label="Password">');
    (document.querySelector('input') as HTMLInputElement).value = 's3cr3t-hunter2';
    const text = snapshot().text;
    expect(text).toContain('- textbox "Password" [ref=e1] {type=password}');
    expect(text).not.toContain('s3cr3t-hunter2');
  });

  it('marks disabled controls without dropping them', () => {
    mount('<button disabled>Pay now</button>');
    expect(snapshot().text).toBe('- button "Pay now" [ref=e1] {disabled=true}');
  });

  it('escapes quotes in names', () => {
    mount('<button>Say "hi"</button>');
    expect(snapshot().text).toBe('- button "Say \\"hi\\"" [ref=e1]');
  });

  it('interactiveOnly drops landmarks and free text', () => {
    mount('<main><h2>Threads</h2><p>Some prose</p><button>Refresh</button></main>');
    const full = snapshot();
    const lean = snapshot({ interactiveOnly: true });
    expect(full.nodes).toBeGreaterThan(lean.nodes);
    expect(lines(lean.text)).toEqual(['- button "Refresh" [ref=e1]']);
  });
});

describe('hidden elements', () => {
  it('skips display:none, visibility:hidden, [hidden] and aria-hidden subtrees', () => {
    mount(`
      <button style="display:none">Gone A</button>
      <button style="visibility:hidden">Gone B</button>
      <button hidden>Gone C</button>
      <div aria-hidden="true"><button>Gone D</button></div>
      <input type="hidden" value="x">
      <script>var a = 1;</script>
      <style>.x{}</style>
      <button>Visible</button>
    `);
    expect(lines(snapshot().text)).toEqual(['- button "Visible" [ref=e1]']);
  });

  it('skipOffscreen drops zero-size and out-of-viewport elements', () => {
    mount('<button id="a">On</button><button id="b">Off</button>');
    const off = document.getElementById('b') as HTMLElement;
    off.getBoundingClientRect = () => ({ x: 0, y: 5000, width: 10, height: 10, top: 5000, left: 0, right: 10, bottom: 5010, toJSON: () => ({}) }) as DOMRect;
    const on = document.getElementById('a') as HTMLElement;
    on.getBoundingClientRect = () => ({ x: 0, y: 10, width: 10, height: 10, top: 10, left: 0, right: 10, bottom: 20, toJSON: () => ({}) }) as DOMRect;
    expect(lines(snapshot({ skipOffscreen: true }).text)).toEqual(['- button "On" [ref=e1]']);
    // Without the flag both survive.
    expect(snapshot().nodes).toBe(2);
  });
});

describe('refs', () => {
  it('gives one element exactly one ref within a snapshot, and resolves it', () => {
    mount('<button>A</button><button>B</button>');
    const result = snapshot();
    expect(result.text).toContain('[ref=e1]');
    expect(result.text).toContain('[ref=e2]');
    expect(refCount()).toBe(2);
    expect(resolveRef('e1')).toBe(document.querySelectorAll('button')[0]);
    expect(resolveRef('e2')).toBe(document.querySelectorAll('button')[1]);
  });

  it('restarts numbering on every snapshot and re-derives the mapping', () => {
    mount('<button>A</button>');
    snapshot();
    const first = resolveRef('e1');
    mount('<button>Different</button>');
    const second = snapshot();
    expect(second.text).toBe('- button "Different" [ref=e1]');
    expect(resolveRef('e1')).not.toBe(first);
    expect(resolveRef('e2')).toBeNull();
  });

  it('resolves a ref to null once its element leaves the document', () => {
    mount('<button>A</button>');
    snapshot();
    const el = resolveRef('e1');
    expect(el).not.toBeNull();
    el?.remove();
    expect(resolveRef('e1')).toBeNull();
  });

  it('writes nothing to the DOM while assigning refs', () => {
    mount('<button id="keep" class="c">A</button>');
    const before = document.body.innerHTML;
    snapshot();
    expect(document.body.innerHTML).toBe(before);
    const button = document.getElementById('keep') as HTMLElement;
    expect(button.getAttributeNames().sort()).toEqual(['class', 'id']);
    expect(document.querySelectorAll('style').length).toBe(0);
  });
});

describe('shadow roots', () => {
  it('traverses an open shadow root with no chrome.dom present', () => {
    mount('<div id="host"></div>');
    const host = document.getElementById('host') as HTMLElement;
    host.attachShadow({ mode: 'open' }).innerHTML = '<button>Inside open</button>';
    expect(snapshot().text).toContain('- button "Inside open" [ref=e1]');
  });

  it('uses chrome.dom.openOrClosedShadowRoot for a closed root when available', () => {
    mount('<div id="host"></div>');
    const host = document.getElementById('host') as HTMLElement;
    const closed = host.attachShadow({ mode: 'closed' });
    closed.innerHTML = '<button>Inside closed</button>';
    expect(host.shadowRoot).toBeNull();
    (globalThis as unknown as { chrome: unknown }).chrome = {
      dom: { openOrClosedShadowRoot: (el: Element) => (el === host ? closed : null) },
    };
    expect(shadowRootOf(host)).toBe(closed);
    expect(snapshot().text).toContain('- button "Inside closed" [ref=e1]');
  });

  it('falls back to element.shadowRoot when chrome.dom throws or is missing', () => {
    mount('<div id="host"></div>');
    const host = document.getElementById('host') as HTMLElement;
    const open = host.attachShadow({ mode: 'open' });
    open.innerHTML = '<button>Fallback</button>';
    (globalThis as unknown as { chrome: unknown }).chrome = {
      dom: {
        openOrClosedShadowRoot: () => {
          throw new Error('not available in this world');
        },
      },
    };
    expect(shadowRootOf(host)).toBe(open);
    expect(snapshot().text).toContain('- button "Fallback" [ref=e1]');
  });

  it('leaves a closed root opaque when there is no extension API to open it', () => {
    mount('<div id="host"></div><button>Outside</button>');
    const host = document.getElementById('host') as HTMLElement;
    host.attachShadow({ mode: 'closed' }).innerHTML = '<button>Unreachable</button>';
    const text = snapshot().text;
    expect(text).toContain('Outside');
    expect(text).not.toContain('Unreachable');
  });
});

describe('iframes', () => {
  it('lists a cross-origin frame as opaque', () => {
    mount('<iframe title="Ad"></iframe>');
    const frame = document.querySelector('iframe') as HTMLIFrameElement;
    Object.defineProperty(frame, 'contentDocument', {
      get() {
        throw new Error('SecurityError');
      },
    });
    expect(snapshot().text).toBe('- iframe [ref=e1] (cross-origin)');
  });

  it('descends a same-origin frame inline', () => {
    mount('<iframe></iframe>');
    const frame = document.querySelector('iframe') as HTMLIFrameElement;
    const doc = frame.contentDocument as Document;
    doc.body.innerHTML = '<button>Confirm</button>';
    expect(lines(snapshot().text)).toEqual([
      '- iframe [ref=e1] (same-origin)',
      '  - button "Confirm" [ref=e2]',
    ]);
  });
});

describe('budget', () => {
  it('sets truncated when maxNodes is hit', () => {
    mount(Array.from({ length: 20 }, (_, i) => `<button>B${i}</button>`).join(''));
    const capped = snapshot({ maxNodes: 5 });
    expect(capped.nodes).toBe(5);
    expect(capped.truncated).toBe(true);
    expect(snapshot({ maxNodes: 100 }).truncated).toBe(false);
  });

  it('truncates over-long names to maxTextLength', () => {
    mount(`<button>${'x'.repeat(500)}</button>`);
    const name = /"([^"]*)"/.exec(snapshot({ maxTextLength: 40 }).text)?.[1] ?? '';
    expect(name).toHaveLength(40);
    expect(name.endsWith('…')).toBe(true);
  });

  it('keeps a synthetic 500-element page inside the 500-2000 token budget', () => {
    const rows = Array.from(
      { length: 500 },
      (_, i) =>
        `<li><a href="/thread/${i}">Thread number ${i}</a><span class="badge">open</span></li>`,
    ).join('');
    mount(`<main><h1>Inbox</h1><ul>${rows}</ul></main>`);

    const unbounded = snapshot({ maxNodes: 100000 });
    expect(unbounded.nodes).toBeGreaterThan(1000);

    // Default options must land in budget on the same page.
    const budgeted = snapshot({ interactiveOnly: true, maxNodes: 120 });
    expect(budgeted.truncated).toBe(true);
    expect(budgeted.approxTokens).toBeGreaterThan(200);
    expect(budgeted.approxTokens).toBeLessThan(2000);
  });
});
