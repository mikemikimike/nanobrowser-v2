// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { click, getBox, hover, press, resetPointerForTests, scroll, select, type } from '@/src/page/actions';
import { resolveRef, snapshot } from '@/src/page/snapshot';

/**
 * Take a snapshot (the only thing that mints refs) and hand back the ref for `selector`.
 * Every action test goes through this, which also proves refs are the only handle actions
 * accept — there is no selector back door.
 */
function refOf(selector: string): string {
  const text = snapshot({ maxNodes: 10000 }).text;
  const target = document.querySelector(selector);
  if (!target) throw new Error(`no element matched ${selector}`);
  for (const match of text.matchAll(/\[ref=(e\d+)\]/g)) {
    const ref = match[1] ?? '';
    if (ref && resolveRef(ref) === target) return ref;
  }
  throw new Error(`no ref for ${selector}`);
}

/** `refOf` for an element no selector reaches (e.g. inside a shadow root). */
function refOfElement(target: Element): string {
  const text = snapshot({ maxNodes: 10000 }).text;
  for (const match of text.matchAll(/\[ref=(e\d+)\]/g)) {
    const ref = match[1] ?? '';
    if (ref && resolveRef(ref) === target) return ref;
  }
  throw new Error('no ref for element');
}

/** Record every event type a set of elements sees, in dispatch order. */
function recorder(target: EventTarget, types: string[]): string[] {
  const seen: string[] = [];
  for (const t of types) target.addEventListener(t, () => seen.push(t));
  return seen;
}

beforeEach(() => {
  document.body.innerHTML = '';
  // The pointer is module state (where the last click landed); without this,
  // arrival-path moves from one test leak into the next test's cortège.
  resetPointerForTests();
});

const CLICK_TYPES = [
  'pointerover',
  'pointerenter',
  'mouseover',
  'mouseenter',
  'pointermove',
  'mousemove',
  'pointerdown',
  'mousedown',
  'focus',
  'pointerup',
  'mouseup',
  'click',
];

describe('click', () => {
  it('dispatches the full cortège in spec order, with focus between down and up', () => {
    document.body.innerHTML = '<button>Go</button>';
    const button = document.querySelector('button') as HTMLButtonElement;
    const seen = recorder(button, CLICK_TYPES);
    expect(click(refOf('button'))).toEqual({ ok: true });
    // Arrival moves precede it (even the first action walks); the cortège itself
    // keeps spec order at the tail.
    expect(seen.length).toBeGreaterThan(CLICK_TYPES.length);
    expect(seen.slice(-CLICK_TYPES.length)).toEqual(CLICK_TYPES);
  });

  it('lands inside the box but never dead-center (center is a bot tell)', () => {
    document.body.innerHTML = '<button>Go</button>';
    const button = document.querySelector('button') as HTMLButtonElement;
    button.getBoundingClientRect = () =>
      ({ x: 100, y: 200, width: 80, height: 40, top: 200, left: 100, right: 180, bottom: 240, toJSON: () => ({}) }) as DOMRect;
    const points: { clientX: number; clientY: number }[] = [];
    button.addEventListener('click', (e) => {
      points.push({ clientX: (e as MouseEvent).clientX, clientY: (e as MouseEvent).clientY });
    });
    const ref = refOf('button');
    for (let i = 0; i < 50; i++) click(ref);
    expect(points).toHaveLength(50);
    for (const point of points) {
      expect(point.clientX).toBeGreaterThanOrEqual(100);
      expect(point.clientX).toBeLessThanOrEqual(180);
      expect(point.clientY).toBeGreaterThanOrEqual(200);
      expect(point.clientY).toBeLessThanOrEqual(240);
    }
    // The jitter is uniform over a non-degenerate range, so 50 draws never all
    // land on the exact centre the old code always aimed at.
    expect(points.some((p) => p.clientX !== 140 || p.clientY !== 220)).toBe(true);
  });

  it('arrives along a path on a moved pointer instead of teleporting', () => {
    document.body.innerHTML = '<button>Go</button>';
    const button = document.querySelector('button') as HTMLButtonElement;
    const rectAt = (x: number, y: number) =>
      ({ x, y, width: 100, height: 50, top: y, left: x, right: x + 100, bottom: y + 50, toJSON: () => ({}) }) as DOMRect;
    button.getBoundingClientRect = () => rectAt(500, 500);
    const ref = refOf('button');
    click(ref);
    // The box jumps across the viewport; the next click must walk there.
    button.getBoundingClientRect = () => rectAt(100, 100);
    const seen: string[] = [];
    for (const t of ['pointermove', 'mousemove', 'pointerdown']) {
      button.addEventListener(t, () => seen.push(t));
    }
    click(ref);
    const downAt = seen.indexOf('pointerdown');
    expect(downAt).toBeGreaterThan(0);
    const movesBefore = seen.slice(0, downAt).filter((t) => t === 'pointermove' || t === 'mousemove');
    // Arrival path samples plus the hover pair — strictly more than a teleport's one pair.
    expect(movesBefore.length).toBeGreaterThan(2);
  });

  it('stamps movementX/Y as the delta from the previous dispatched position', () => {
    document.body.innerHTML = '<button>Go</button>';
    const button = document.querySelector('button') as HTMLButtonElement;
    const rectAt = (x: number, y: number) =>
      ({ x, y, width: 100, height: 50, top: y, left: x, right: x + 100, bottom: y + 50, toJSON: () => ({}) }) as DOMRect;
    button.getBoundingClientRect = () => rectAt(500, 500);
    const ref = refOf('button');
    click(ref);
    button.getBoundingClientRect = () => rectAt(100, 100);

    const moves: { x: number; y: number; dx: number; dy: number }[] = [];
    button.addEventListener('mousemove', (e) => {
      const m = e as MouseEvent;
      moves.push({ x: m.clientX, y: m.clientY, dx: m.movementX ?? 0, dy: m.movementY ?? 0 });
    });
    click(ref);

    // The arrival path moved, so some sample carries a nonzero delta...
    expect(moves.length).toBeGreaterThan(2);
    expect(moves.some((m) => m.dx !== 0 || m.dy !== 0)).toBe(true);
    // ...and every delta matches the coordinate stream (first event: no previous).
    for (let i = 1; i < moves.length; i++) {
      expect(moves[i]!.dx).toBeCloseTo(moves[i]!.x - moves[i - 1]!.x, 9);
      expect(moves[i]!.dy).toBeCloseTo(moves[i]!.y - moves[i - 1]!.y, 9);
    }
  });

  it('walks an arrival path even on the first action (no teleport signature)', () => {
    document.body.innerHTML = '<button>Go</button>';
    const button = document.querySelector('button') as HTMLButtonElement;
    const seen: string[] = [];
    for (const t of ['pointermove', 'mousemove', 'pointerdown']) {
      button.addEventListener(t, () => seen.push(t));
    }
    // Fresh module state (beforeEach reset): no previous point anywhere.
    click(refOf('button'));
    const downAt = seen.indexOf('pointerdown');
    const movesBefore = seen.slice(0, downAt).filter((t) => t === 'pointermove' || t === 'mousemove');
    expect(movesBefore.length).toBeGreaterThan(2);
  });

  it('fires boundary events when the arrival path crosses elements', () => {
    document.body.innerHTML = '<button id="a">A</button><button id="b">B</button>';
    const a = document.querySelector('#a') as HTMLElement;
    const b = document.querySelector('#b') as HTMLElement;
    const rectAt = (x: number, y: number) =>
      ({ x, y, width: 100, height: 50, top: y, left: x, right: x + 100, bottom: y + 50, toJSON: () => ({}) }) as DOMRect;
    a.getBoundingClientRect = () => rectAt(100, 100);
    b.getBoundingClientRect = () => rectAt(300, 100);
    click(refOf('#a'));

    // A continuous path from ~150 to ~350 must cross x=250.
    const docTarget = document as unknown as { elementFromPoint: unknown };
    docTarget.elementFromPoint = (x: number) => (x < 250 ? a : b);
    const seenA = recorder(a, ['pointerout', 'pointerleave', 'pointerover']);
    const seenB = recorder(b, ['pointerover', 'pointerenter']);
    let outRelated: EventTarget | null = null;
    let overRelated: EventTarget | null = null;
    a.addEventListener('pointerout', (e) => {
      outRelated = (e as PointerEvent).relatedTarget;
    });
    b.addEventListener('pointerover', (e) => {
      if (!overRelated) overRelated = (e as PointerEvent).relatedTarget;
    });
    try {
      expect(click(refOf('#b'))).toEqual({ ok: true });
    } finally {
      delete (document as unknown as { elementFromPoint?: unknown }).elementFromPoint;
    }
    expect(seenA).toContain('pointerout');
    expect(seenA).toContain('pointerleave');
    // Entered mid-path exactly once (the destination hover does not re-enter),
    // with related targets pointing across the transition both ways.
    expect(seenB.filter((t) => t === 'pointerover')).toHaveLength(1);
    expect(outRelated).toBe(b);
    expect(overRelated).toBe(a);
  });

  it('refuses when hover arrival opens an overlay over the landing point', () => {
    document.body.innerHTML = '<button>Go</button><div>menu</div>';
    const button = document.querySelector('button') as HTMLButtonElement;
    const cover = document.querySelector('div') as HTMLElement;
    const ref = refOf('button');
    let overlayOpen = false;
    button.addEventListener('mouseover', () => {
      overlayOpen = true;
    });
    const docTarget = document as unknown as { elementFromPoint: unknown };
    docTarget.elementFromPoint = () => (overlayOpen ? cover : button);
    try {
      expect(click(ref)).toEqual({
        ok: false,
        error: 'element became occluded at its click point during hover arrival',
      });
    } finally {
      delete (document as unknown as { elementFromPoint?: unknown }).elementFromPoint;
    }
  });

  it('refuses when the live document reports nothing under the point', () => {
    document.body.innerHTML = '<button>Go</button>';
    const ref = refOf('button');
    const docTarget = document as unknown as { elementFromPoint: unknown };
    docTarget.elementFromPoint = () => null;
    try {
      expect(click(ref)).toEqual({
        ok: false,
        error: 'element is outside the viewport at its click point',
      });
    } finally {
      delete (document as unknown as { elementFromPoint?: unknown }).elementFromPoint;
    }
  });

  it('does not walk paths across documents (iframe coordinates differ)', () => {
    document.body.innerHTML = '<button>Top</button><iframe></iframe>';
    const top = document.querySelector('button') as HTMLButtonElement;
    const iframe = document.querySelector('iframe') as HTMLIFrameElement;
    const idoc = iframe.contentDocument as Document;
    idoc.body.innerHTML = '<button>Inner</button>';
    const inner = idoc.querySelector('button') as HTMLButtonElement;
    const rectAt = (x: number, y: number) =>
      ({ x, y, width: 100, height: 50, top: y, left: x, right: x + 100, bottom: y + 50, toJSON: () => ({}) }) as DOMRect;
    top.getBoundingClientRect = () => rectAt(500, 500);
    inner.getBoundingClientRect = () => rectAt(50, 50);
    click(refOf('button'));

    // The iframe click must arrive from nearby in its own frame — not trek from
    // the top frame's (500,500), which is a different coordinate space entirely.
    const moves: { x: number; y: number }[] = [];
    inner.addEventListener('mousemove', (e) => {
      const m = e as MouseEvent;
      moves.push({ x: m.clientX, y: m.clientY });
    });
    expect(click(refOfElement(inner))).toEqual({ ok: true });
    expect(moves.length).toBeGreaterThan(0);
    expect(Math.abs(moves[0]!.x - 100)).toBeLessThan(200);
    expect(Math.abs(moves[0]!.y - 75)).toBeLessThan(200);
  });

  it('adds containing frame offsets to screen coordinates inside iframes', () => {
    document.body.innerHTML = '<iframe></iframe>';
    const iframe = document.querySelector('iframe') as HTMLIFrameElement;
    const idoc = iframe.contentDocument as Document;
    idoc.body.innerHTML = '<button>Inner</button>';
    const inner = idoc.querySelector('button') as HTMLButtonElement;
    const rectAt = (x: number, y: number) =>
      ({ x, y, width: 100, height: 50, top: y, left: x, right: x + 100, bottom: y + 50, toJSON: () => ({}) }) as DOMRect;
    iframe.getBoundingClientRect = () => rectAt(50, 60);
    inner.getBoundingClientRect = () => rectAt(10, 20);
    const win = iframe.contentWindow as unknown as { screenX: number; screenY: number };
    const origX = win.screenX;
    const origY = win.screenY;
    Object.defineProperty(iframe.contentWindow, 'screenX', { value: 100, configurable: true });
    Object.defineProperty(iframe.contentWindow, 'screenY', { value: 50, configurable: true });
    let observed: { clientX: number; clientY: number; screenX: number; screenY: number } | null = null;
    inner.addEventListener('mousedown', (e) => {
      const m = e as MouseEvent;
      observed = { clientX: m.clientX, clientY: m.clientY, screenX: m.screenX, screenY: m.screenY };
    });
    try {
      expect(click(refOfElement(inner))).toEqual({ ok: true });
    } finally {
      Object.defineProperty(iframe.contentWindow, 'screenX', { value: origX, configurable: true });
      Object.defineProperty(iframe.contentWindow, 'screenY', { value: origY, configurable: true });
    }
    // Frame-local point + iframe offset + window origin. Close-to, not exact:
    // coordinate arithmetic in floats can round-trip as 110.00000000000001.
    expect(observed!.screenX - observed!.clientX).toBeCloseTo(150, 9);
    expect(observed!.screenY - observed!.clientY).toBeCloseTo(110, 9);
  });

  it('offsets screenX/screenY by the window origin instead of echoing clientX', () => {
    document.body.innerHTML = '<button>Go</button>';
    const button = document.querySelector('button') as HTMLButtonElement;
    const origX = (window as unknown as { screenX: number }).screenX;
    const origY = (window as unknown as { screenY: number }).screenY;
    Object.defineProperty(window, 'screenX', { value: 100, configurable: true });
    Object.defineProperty(window, 'screenY', { value: 50, configurable: true });
    try {
      let observed: { clientX: number; clientY: number; screenX: number; screenY: number } | null = null;
      button.addEventListener('click', (e) => {
        const me = e as MouseEvent;
        observed = { clientX: me.clientX, clientY: me.clientY, screenX: me.screenX, screenY: me.screenY };
      });
      click(refOf('button'));
      expect(observed).not.toBeNull();
      expect(observed!.screenX - observed!.clientX).toBe(100);
      expect(observed!.screenY - observed!.clientY).toBe(50);
    } finally {
      Object.defineProperty(window, 'screenX', { value: origX, configurable: true });
      Object.defineProperty(window, 'screenY', { value: origY, configurable: true });
    }
  });

  it('refuses the click when another element covers both the jittered point and the center', () => {
    document.body.innerHTML = '<button>Go</button><div>cover</div>';
    const cover = document.querySelector('div') as HTMLElement;
    const ref = refOf('button');
    const had = 'elementFromPoint' in document;
    const orig = (document as unknown as { elementFromPoint?: unknown }).elementFromPoint;
    (document as unknown as { elementFromPoint: unknown }).elementFromPoint = () => cover;
    try {
      // `cover` is a sibling the button does not contain, so neither aim point verifies.
      expect(click(ref)).toEqual({
        ok: false,
        error: 'element is occluded at its click point by another element',
      });
    } finally {
      if (had) (document as unknown as { elementFromPoint: unknown }).elementFromPoint = orig;
      else delete (document as unknown as { elementFromPoint?: unknown }).elementFromPoint;
    }
  });

  it('clicks into an open shadow root instead of mistaking the host for an occluder', () => {
    document.body.innerHTML = '<div id="host"></div>';
    const host = document.querySelector('#host') as HTMLElement;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button>Go</button>';
    const inner = shadow.querySelector('button') as HTMLElement;
    const ref = refOfElement(inner);

    // Document hit testing retargets to the host; the shadow root resolves inward.
    const docTarget = document as unknown as { elementFromPoint: unknown };
    const hadDoc = 'elementFromPoint' in document;
    const origDoc = docTarget.elementFromPoint;
    docTarget.elementFromPoint = () => host;
    const shadowTarget = shadow as unknown as { elementFromPoint: unknown };
    const hadShadow = 'elementFromPoint' in shadow;
    const origShadow = shadowTarget.elementFromPoint;
    shadowTarget.elementFromPoint = () => inner;
    try {
      expect(click(ref)).toEqual({ ok: true });
    } finally {
      if (hadDoc) docTarget.elementFromPoint = origDoc;
      else delete (document as unknown as { elementFromPoint?: unknown }).elementFromPoint;
      if (hadShadow) shadowTarget.elementFromPoint = origShadow;
      else delete (shadow as unknown as { elementFromPoint?: unknown }).elementFromPoint;
    }
  });

  it('accepts a host hit for a shadow-rooted target (the closed-root shape) rather than vetoing it', () => {
    // A closed root is unreachable in jsdom (no chrome.dom.openOrClosedShadowRoot),
    // so simulate exactly what the verifier sees there: the target's root is a
    // ShadowRoot and the hit lands on its host.
    document.body.innerHTML = '<button>Go</button><div id="h2"></div>';
    const other = document.querySelector('#h2') as HTMLElement;
    const root = other.attachShadow({ mode: 'open' });
    const button = document.querySelector('button') as HTMLButtonElement;
    const ref = refOf('button');
    const docTarget = document as unknown as { elementFromPoint: unknown };
    const hadDoc = 'elementFromPoint' in document;
    const origDoc = docTarget.elementFromPoint;
    docTarget.elementFromPoint = () => other;
    const rootStub = vi.spyOn(button, 'getRootNode').mockReturnValue(root);
    try {
      expect(click(ref)).toEqual({ ok: true });
    } finally {
      rootStub.mockRestore();
      if (hadDoc) docTarget.elementFromPoint = origDoc;
      else delete (document as unknown as { elementFromPoint?: unknown }).elementFromPoint;
    }
  });

  it('sets realistic pointer fields: non-zero id, mouse type, primary, pressure while down', () => {
    document.body.innerHTML = '<button>Go</button>';
    const button = document.querySelector('button') as HTMLButtonElement;
    const captured: Record<string, PointerEvent> = {};
    for (const t of ['pointerdown', 'pointerup']) {
      button.addEventListener(t, (e) => {
        captured[t] = e as PointerEvent;
      });
    }
    click(refOf('button'));
    const down = captured.pointerdown as PointerEvent;
    const up = captured.pointerup as PointerEvent;
    expect(down.pointerId).not.toBe(0);
    expect(down.pointerType).toBe('mouse');
    expect(down.isPrimary).toBe(true);
    expect(down.pressure).toBe(0.5);
    expect(down.buttons).toBe(1);
    expect(up.pressure).toBe(0);
    expect(up.buttons).toBe(0);
  });

  it('every event it emits is isTrusted:false — the R-13 tier-1 tell', () => {
    document.body.innerHTML = '<button>Go</button>';
    const button = document.querySelector('button') as HTMLButtonElement;
    const trust: boolean[] = [];
    // `focus` is excluded: that one comes from calling the real `HTMLElement.focus()` API,
    // so it is genuinely trusted. Every event this module *synthesises* is not, and no
    // amount of care changes that — it is why R-13's escalation tier exists.
    const dispatched = CLICK_TYPES.filter((t) => t !== 'focus');
    for (const t of dispatched) button.addEventListener(t, (e) => trust.push(e.isTrusted));
    click(refOf('button'));
    // Arrival moves plus the cortège: strictly more than the cortège alone.
    expect(trust.length).toBeGreaterThan(dispatched.length);
    expect(trust.every((v) => v === false)).toBe(true);
  });

  it('scrolls the element into view only when it is outside the viewport', () => {
    document.body.innerHTML = '<button id="a">A</button><button id="b">B</button>';
    const inView = document.getElementById('a') as HTMLElement;
    const outOfView = document.getElementById('b') as HTMLElement;
    inView.getBoundingClientRect = () =>
      ({ x: 0, y: 0, width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10, toJSON: () => ({}) }) as DOMRect;
    outOfView.getBoundingClientRect = () =>
      ({ x: 0, y: 9000, width: 10, height: 10, top: 9000, left: 0, right: 10, bottom: 9010, toJSON: () => ({}) }) as DOMRect;
    inView.scrollIntoView = vi.fn();
    outOfView.scrollIntoView = vi.fn();
    click(refOf('#a'));
    click(refOf('#b'));
    expect(inView.scrollIntoView).not.toHaveBeenCalled();
    expect(outOfView.scrollIntoView).toHaveBeenCalledWith({
      block: 'center',
      inline: 'nearest',
      behavior: 'instant',
    });
  });

  it('reports an error for an unknown or stale ref instead of throwing', () => {
    document.body.innerHTML = '<button>Go</button>';
    snapshot();
    expect(click('e999')).toEqual({ ok: false, error: 'unknown or stale ref: e999' });
  });

  it('attaches nothing to the document or window', () => {
    document.body.innerHTML = '<button>Go</button>';
    const ref = refOf('button');
    const onDocument = vi.spyOn(document, 'addEventListener');
    const onWindow = vi.spyOn(window, 'addEventListener');
    click(ref);
    hover(ref);
    scroll({ ref });
    expect(onDocument).not.toHaveBeenCalled();
    expect(onWindow).not.toHaveBeenCalled();
  });

  it('leaves no listener, timer or observer in the source at all', () => {
    // A grep, not a spy: the invariant is that this tier is synchronous and stateless, and
    // a spy only proves it for the paths one test happens to walk (R-02).
    for (const file of ['src/page/actions.ts', 'src/page/snapshot.ts', 'src/page/accname.ts']) {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8');
      expect(source).not.toMatch(/setTimeout|setInterval|requestAnimationFrame/);
      expect(source).not.toMatch(/addEventListener/);
      expect(source).not.toMatch(/MutationObserver|IntersectionObserver/);
      // And no page mutation: no attribute/style writes, no node insertion.
      expect(source).not.toMatch(/setAttribute|\.style\.|appendChild|insertBefore|innerHTML\s*=/);
    }
  });
});

describe('hover', () => {
  it('emits the enter cortège without any press', () => {
    document.body.innerHTML = '<div tabindex="0">Menu</div>';
    const el = document.querySelector('div') as HTMLElement;
    const seen = recorder(el, [...CLICK_TYPES]);
    expect(hover(refOf('div'))).toEqual({ ok: true });
    // Arrival moves precede it; the enter cortège itself keeps order at the tail,
    // and no press ever appears.
    const cortège = ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove'];
    expect(seen.length).toBeGreaterThan(cortège.length);
    expect(seen.slice(-cortège.length)).toEqual(cortège);
    expect(seen).not.toContain('pointerdown');
  });
});

describe('type', () => {
  it('goes through the prototype value setter so a React-style tracker sees the change', () => {
    document.body.innerHTML = '<input type="text">';
    const input = document.querySelector('input') as HTMLInputElement;

    // Stand in for React's instance-level value tracker: an own `value` property that
    // swallows plain assignment. Only the prototype setter gets past it.
    let tracked = '';
    const protoSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    const protoGetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.get;
    Object.defineProperty(input, 'value', {
      configurable: true,
      get() {
        return protoGetter?.call(this) ?? '';
      },
      set() {
        tracked = 'swallowed';
      },
    });

    const events: string[] = [];
    for (const t of ['input', 'change']) input.addEventListener(t, () => events.push(t));

    expect(type(refOf('input'), 'hello@example.com')).toEqual({ ok: true });
    expect(tracked).toBe('');
    expect(protoGetter?.call(input)).toBe('hello@example.com');
    expect(protoSetter).toBeTypeOf('function');
    expect(events).toEqual(['input', 'change']);
  });

  it('fires input then change, both bubbling', () => {
    document.body.innerHTML = '<form><input type="text"></form>';
    const seen: string[] = [];
    const form = document.querySelector('form') as HTMLFormElement;
    for (const t of ['input', 'change']) form.addEventListener(t, () => seen.push(t));
    type(refOf('input'), 'abc');
    expect(seen).toEqual(['input', 'change']);
  });

  it('replaces by default and appends when clear is false', () => {
    document.body.innerHTML = '<input type="text">';
    const input = document.querySelector('input') as HTMLInputElement;
    input.value = 'seed ';
    type(refOf('input'), 'more');
    expect(input.value).toBe('more');
    type(refOf('input'), '!', { clear: false });
    expect(input.value).toBe('more!');
  });

  it('focuses the field before writing', () => {
    document.body.innerHTML = '<input type="text">';
    const input = document.querySelector('input') as HTMLInputElement;
    type(refOf('input'), 'x');
    expect(document.activeElement).toBe(input);
  });

  it('works on a textarea', () => {
    document.body.innerHTML = '<textarea></textarea>';
    const area = document.querySelector('textarea') as HTMLTextAreaElement;
    expect(type(refOf('textarea'), 'note')).toEqual({ ok: true });
    expect(area.value).toBe('note');
  });

  it('uses execCommand("insertText") for contenteditable', () => {
    document.body.innerHTML = '<div contenteditable="true" tabindex="0"></div>';
    const calls: Array<[string, unknown]> = [];
    (document as unknown as { execCommand: unknown }).execCommand = (cmd: string, _ui: boolean, value?: string) => {
      calls.push([cmd, value]);
      return true;
    };
    expect(type(refOf('div'), 'rich text')).toEqual({ ok: true });
    expect(calls).toEqual([
      ['selectAll', undefined],
      ['delete', undefined],
      ['insertText', 'rich text'],
    ]);
  });

  it('refuses a non-text element rather than pretending', () => {
    document.body.innerHTML = '<button>Go</button>';
    expect(type(refOf('button'), 'x')).toEqual({ ok: false, error: 'element <button> is not a text field' });
  });
});

describe('press', () => {
  it('sends keydown, keypress and keyup with matching key and code', () => {
    document.body.innerHTML = '<input type="text">';
    const input = document.querySelector('input') as HTMLInputElement;
    input.focus();
    const seen: Array<{ type: string; key: string; code: string }> = [];
    for (const t of ['keydown', 'keypress', 'keyup']) {
      input.addEventListener(t, (e) => {
        const ke = e as KeyboardEvent;
        seen.push({ type: t, key: ke.key, code: ke.code });
      });
    }
    expect(press('Enter')).toEqual({ ok: true });
    expect(seen).toEqual([
      { type: 'keydown', key: 'Enter', code: 'Enter' },
      { type: 'keypress', key: 'Enter', code: 'Enter' },
      { type: 'keyup', key: 'Enter', code: 'Enter' },
    ]);
  });

  it('omits keypress for non-character keys and maps letters and digits to codes', () => {
    document.body.innerHTML = '<input type="text">';
    const input = document.querySelector('input') as HTMLInputElement;
    input.focus();
    const seen: string[] = [];
    const codes: string[] = [];
    for (const t of ['keydown', 'keypress', 'keyup']) {
      input.addEventListener(t, (e) => {
        seen.push(t);
        codes.push((e as KeyboardEvent).code);
      });
    }
    press('Escape');
    expect(seen).toEqual(['keydown', 'keyup']);
    seen.length = 0;
    codes.length = 0;
    press('a');
    expect(seen).toEqual(['keydown', 'keypress', 'keyup']);
    expect(codes.every((c) => c === 'KeyA')).toBe(true);
    codes.length = 0;
    press('7');
    expect(codes.every((c) => c === 'Digit7')).toBe(true);
  });

  it('inserts no character — real typing is the R-13 escalation, not this', () => {
    document.body.innerHTML = '<input type="text">';
    const input = document.querySelector('input') as HTMLInputElement;
    input.focus();
    press('a');
    expect(input.value).toBe('');
  });
});

describe('select', () => {
  it('sets the value by option value and fires input then change', () => {
    document.body.innerHTML =
      '<select aria-label="Size"><option value="s">Small</option><option value="m">Medium</option></select>';
    const el = document.querySelector('select') as HTMLSelectElement;
    const seen: string[] = [];
    for (const t of ['input', 'change']) el.addEventListener(t, () => seen.push(t));
    expect(select(refOf('select'), 'm')).toEqual({ ok: true });
    expect(el.value).toBe('m');
    expect((el.options[1] as HTMLOptionElement).selected).toBe(true);
    expect(seen).toEqual(['input', 'change']);
  });

  it('falls back to matching the visible option label', () => {
    document.body.innerHTML =
      '<select aria-label="Size"><option value="s">Small</option><option value="m">Medium</option></select>';
    expect(select(refOf('select'), 'Medium')).toEqual({ ok: true });
    expect((document.querySelector('select') as HTMLSelectElement).value).toBe('m');
  });

  it('reports a missing option and a non-select target', () => {
    document.body.innerHTML = '<select aria-label="Size"><option value="s">Small</option></select><button>b</button>';
    expect(select(refOf('select'), 'xl')).toEqual({ ok: false, error: 'no option with value or label "xl"' });
    expect(select(refOf('button'), 'x')).toEqual({ ok: false, error: 'element <button> is not a <select>' });
  });
});

describe('scroll', () => {
  it('scrolls a ref into view instantly', () => {
    document.body.innerHTML = '<button>Go</button>';
    const button = document.querySelector('button') as HTMLButtonElement;
    button.scrollIntoView = vi.fn();
    expect(scroll({ ref: refOf('button') })).toEqual({ ok: true });
    expect(button.scrollIntoView).toHaveBeenCalledWith({
      block: 'center',
      inline: 'nearest',
      behavior: 'instant',
    });
  });

  it('scrolls the window by direction, defaulting to ~80% of the viewport', () => {
    const scrollBy = vi.fn();
    (window as unknown as { scrollBy: unknown }).scrollBy = scrollBy;
    Object.defineProperty(window, 'innerHeight', { value: 1000, configurable: true });
    Object.defineProperty(window, 'innerWidth', { value: 500, configurable: true });
    expect(scroll({ direction: 'down' })).toEqual({ ok: true });
    expect(scrollBy).toHaveBeenCalledWith({ left: 0, top: 800, behavior: 'instant' });
    scroll({ direction: 'up', amount: 120 });
    expect(scrollBy).toHaveBeenLastCalledWith({ left: 0, top: -120, behavior: 'instant' });
    scroll({ direction: 'right' });
    expect(scrollBy).toHaveBeenLastCalledWith({ left: 400, top: 0, behavior: 'instant' });
  });
});

describe('getBox', () => {
  it('returns viewport coordinates, the centre point, and the device pixel ratio', () => {
    document.body.innerHTML = '<button>Go</button>';
    const button = document.querySelector('button') as HTMLButtonElement;
    button.getBoundingClientRect = () =>
      ({ x: 10, y: 20, width: 100, height: 50, top: 20, left: 10, right: 110, bottom: 70, toJSON: () => ({}) }) as DOMRect;
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
    expect(getBox(refOf('button'))).toEqual({
      ok: true,
      box: { x: 10, y: 20, width: 100, height: 50, centerX: 60, centerY: 45 },
      devicePixelRatio: 2,
    });
  });

  it('reports an error for a stale ref', () => {
    document.body.innerHTML = '<button>Go</button>';
    snapshot();
    expect(getBox('e42')).toEqual({ ok: false, error: 'unknown or stale ref: e42' });
  });
});

describe('triage: arrival telemetry and aim honesty', () => {
  const rectAt = (x: number, y: number, w = 100, h = 50) =>
    ({ x, y, width: w, height: h, top: y, left: x, right: x + w, bottom: y + h, toJSON: () => ({}) }) as DOMRect;

  function mockHit(fn: (x: number, y: number) => Element | null): void {
    (document as unknown as { elementFromPoint: unknown }).elementFromPoint = fn;
  }

  function unmockHit(): void {
    delete (document as unknown as { elementFromPoint?: unknown }).elementFromPoint;
  }

  it('shares one sample delta across the whole crossing burst, so the final move is honest', () => {
    document.body.innerHTML = '<button id="a">A</button><button id="b">B</button>';
    const a = document.querySelector('#a') as HTMLElement;
    const b = document.querySelector('#b') as HTMLElement;
    a.getBoundingClientRect = () => rectAt(100, 100);
    b.getBoundingClientRect = () => rectAt(300, 100);
    click(refOf('#a'));

    // A continuous path from ~150 to ~350 must cross x=250.
    mockHit((x: number) => (x < 250 ? a : b));
    const moves: { x: number; dx: number }[] = [];
    let overX: number | null = null;
    b.addEventListener('pointerover', (e) => {
      if (overX === null) overX = (e as PointerEvent).clientX;
    });
    const record = (e: Event) => {
      const m = e as MouseEvent;
      moves.push({ x: m.clientX, dx: m.movementX ?? 0 });
    };
    // One ordered stream across both elements: the moves before the burst land
    // on `a`, so the sample delta is measured against the previous position.
    for (const t of ['pointermove', 'mousemove']) {
      a.addEventListener(t, record);
      b.addEventListener(t, record);
    }
    try {
      expect(click(refOf('#b'))).toEqual({ ok: true });
    } finally {
      unmockHit();
    }
    expect(overX).not.toBeNull();
    const atBurst = moves.filter((m) => m.x === overX);
    // pointermove + mousemove at the crossing sample: both carry the sample's
    // real delta. Before the fix the burst consumed it and both read zero.
    expect(atBurst).toHaveLength(2);
    for (const m of atBurst) expect(m.dx).not.toBe(0);
    const prev = [...moves.slice(0, moves.findIndex((m) => m.x === overX))].reverse().find((m) => m.x !== overX);
    expect(prev).toBeDefined();
    expect(atBurst[0]!.dx).toBeCloseTo(overX! - prev!.x, 9);
  });

  it('retries an occluded aim at a second off-center point, never dead-center', () => {
    document.body.innerHTML = '<button>Go</button><div>cover</div>';
    const button = document.querySelector('button') as HTMLButtonElement;
    const cover = document.querySelector('div') as HTMLElement;
    button.getBoundingClientRect = () => rectAt(100, 100);
    // First verification sees the cover, every later probe sees the button:
    // deterministic regardless of where the two jittered tries land.
    let calls = 0;
    mockHit(() => (++calls === 1 ? cover : button));
    let observed: { x: number; y: number } | null = null;
    button.addEventListener('mousedown', (e) => {
      const m = e as MouseEvent;
      observed = { x: m.clientX, y: m.clientY };
    });
    try {
      expect(click(refOf('button'))).toEqual({ ok: true });
    } finally {
      unmockHit();
    }
    expect(calls).toBeGreaterThan(1);
    expect(observed).not.toBeNull();
    // Box center is (150, 125): the retry must not be the deterministic center.
    expect(observed!.x).not.toBe(150);
    expect(observed!.y).not.toBe(125);
  });

  it('emits no leave on ancestors when the path moves into a descendant', () => {
    document.body.innerHTML = '<button id="a">A</button><button id="outer">O<span id="inner">I</span></button>';
    const a = document.querySelector('#a') as HTMLElement;
    const outer = document.querySelector('#outer') as HTMLElement;
    const inner = document.querySelector('#inner') as HTMLElement;
    a.getBoundingClientRect = () => rectAt(100, 100);
    outer.getBoundingClientRect = () => rectAt(300, 100);
    click(refOf('#a'));

    // Path from ~150 to ~350 crosses x=250, from the outer button into its span.
    mockHit((x: number) => (x < 250 ? outer : inner));
    const seenOuter = recorder(outer, ['pointerout', 'pointerleave', 'mouseout', 'mouseleave']);
    const seenInner = recorder(inner, ['pointerover', 'pointerenter', 'mouseover', 'mouseenter']);
    try {
      expect(click(refOf('#outer'))).toEqual({ ok: true });
    } finally {
      unmockHit();
    }
    // The pointer never left the outer button: no leave may fire on it, or a
    // hover-driven control could close mid-cortège.
    expect(seenOuter).not.toContain('pointerleave');
    expect(seenOuter).not.toContain('mouseleave');
    expect(seenOuter).not.toContain('pointerout');
    expect(seenInner).toContain('pointerover');
    expect(seenInner).toContain('pointerenter');
  });

  it('adds iframe borders to screen-coordinate offsets', () => {
    document.body.innerHTML = '<iframe></iframe>';
    const iframe = document.querySelector('iframe') as HTMLIFrameElement;
    const idoc = iframe.contentDocument as Document;
    idoc.body.innerHTML = '<button>Inner</button>';
    const inner = idoc.querySelector('button') as HTMLButtonElement;
    const rectAtLocal = (x: number, y: number) =>
      ({ x, y, width: 100, height: 50, top: y, left: x, right: x + 100, bottom: y + 50, toJSON: () => ({}) }) as DOMRect;
    iframe.getBoundingClientRect = () => rectAtLocal(50, 60);
    inner.getBoundingClientRect = () => rectAtLocal(10, 20);
    Object.defineProperty(iframe, 'clientLeft', { value: 2, configurable: true });
    Object.defineProperty(iframe, 'clientTop', { value: 2, configurable: true });
    const win = iframe.contentWindow as unknown as { screenX: number; screenY: number };
    const origX = win.screenX;
    const origY = win.screenY;
    Object.defineProperty(iframe.contentWindow, 'screenX', { value: 100, configurable: true });
    Object.defineProperty(iframe.contentWindow, 'screenY', { value: 50, configurable: true });
    let observed: { clientX: number; clientY: number; screenX: number; screenY: number } | null = null;
    inner.addEventListener('mousedown', (e) => {
      const m = e as MouseEvent;
      observed = { clientX: m.clientX, clientY: m.clientY, screenX: m.screenX, screenY: m.screenY };
    });
    try {
      expect(click(refOfElement(inner))).toEqual({ ok: true });
    } finally {
      Object.defineProperty(iframe.contentWindow, 'screenX', { value: origX, configurable: true });
      Object.defineProperty(iframe.contentWindow, 'screenY', { value: origY, configurable: true });
    }
    // Frame-local point + iframe offset + border + window origin (close-to:
    // float round-trip, see the test above).
    expect(observed!.screenX - observed!.clientX).toBeCloseTo(152, 9);
    expect(observed!.screenY - observed!.clientY).toBeCloseTo(112, 9);
  });
});

describe('triage: bubbling boundary events fire once', () => {
  const rectAt = (x: number, y: number, w = 100, h = 50) =>
    ({ x, y, width: w, height: h, top: y, left: x, right: x + w, bottom: y + h, toJSON: () => ({}) }) as DOMRect;

  it('dispatches mouseout on the innermost exited node; ancestors get it bubbled, not direct', () => {
    document.body.innerHTML =
      '<div id="d"><button id="b">B<span id="s">S</span></button></div><button id="a">A</button>';
    const a = document.querySelector('#a') as HTMLElement;
    const b = document.querySelector('#b') as HTMLElement;
    const s = document.querySelector('#s') as HTMLElement;
    a.getBoundingClientRect = () => rectAt(100, 100);
    b.getBoundingClientRect = () => rectAt(300, 100);
    // Seed lastPoint near ~350 (the snapshot mints no ref for a bare span).
    click(refOf('#b'));

    // Two zones, no middle ground: samples jump from the span straight to the
    // far button, so one transition exits span and button together.
    (document as unknown as { elementFromPoint: unknown }).elementFromPoint = (x: number) => (x >= 300 ? s : a);
    const seen: { type: string; target: EventTarget | null }[] = [];
    b.addEventListener('mouseout', (e) => seen.push({ type: 'mouseout', target: e.target }));
    try {
      expect(click(refOf('#a'))).toEqual({ ok: true });
    } finally {
      delete (document as unknown as { elementFromPoint?: unknown }).elementFromPoint;
    }
    // One bubbled (target span) from leaving the span. Before the fix the
    // same transition also fired mouseout directly on the button, delivering
    // it twice with target button.
    expect(seen).toEqual([{ type: 'mouseout', target: s }]);
  });
});
