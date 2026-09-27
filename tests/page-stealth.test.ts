// @vitest-environment jsdom
/**
 * Behavioral self-check locking M3 (stealth measurement, not assertion).
 *
 * Three properties the in-page tier must hold on every click, asserted against
 * the real module rather than a fake: no click lands on the exact box center,
 * hover states always precede the press, and consecutive clicks never land on
 * the same point (no fixed-point cortège a detector can anchor on). If a future
 * edit reintroduces teleports-to-center, this file goes red.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { click, resetPointerForTests } from '@/src/page/actions';
import { resolveRef, snapshot } from '@/src/page/snapshot';

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

function centerBox(x: number, y: number) {
  return () =>
    ({ x, y, width: 120, height: 60, top: y, left: x, right: x + 120, bottom: y + 60, toJSON: () => ({}) }) as DOMRect;
}

beforeEach(() => {
  document.body.innerHTML = '';
  resetPointerForTests();
});

describe('in-page stealth self-check (locks M3)', () => {
  it('never lands on the exact box center, on any element', () => {
    document.body.innerHTML = '<button id="a">A</button><button id="b">B</button><button id="c">C</button>';
    const buttons = ['#a', '#b', '#c'].map((s) => document.querySelector(s) as HTMLButtonElement);
    buttons[0]!.getBoundingClientRect = centerBox(100, 100);
    buttons[1]!.getBoundingClientRect = centerBox(400, 100);
    buttons[2]!.getBoundingClientRect = centerBox(100, 400);

    for (const [i, sel] of ['#a', '#b', '#c'].entries()) {
      const button = buttons[i]!;
      const points: string[] = [];
      button.addEventListener('click', (e) => {
        points.push(`${(e as MouseEvent).clientX},${(e as MouseEvent).clientY}`);
      });
      const ref = refOf(sel);
      for (let n = 0; n < 10; n++) click(ref);
      const cx = (i === 0 ? 100 : 400) + 60;
      const cy = (i === 2 ? 400 : 100) + 30;
      expect(points).toHaveLength(10);
      // Inside the box, and never the dead center the old code always aimed at.
      for (const p of points) {
        const [x, y] = p.split(',').map(Number) as [number, number];
        expect(x).toBeGreaterThanOrEqual(i === 0 ? 100 : i === 1 ? 400 : 100);
        expect(y).toBeGreaterThanOrEqual(i === 2 ? 400 : 100);
      }
      expect(points).not.toContain(`${cx},${cy}`);
    }
  });

  it('always hovers before pressing, on every click', () => {
    document.body.innerHTML = '<button>Go</button>';
    const button = document.querySelector('button') as HTMLButtonElement;
    button.getBoundingClientRect = centerBox(50, 50);
    const ref = refOf('button');
    for (let n = 0; n < 5; n++) {
      const seen: string[] = [];
      const listener = (t: string) => () => seen.push(t);
      const types = ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointerdown', 'mousedown'];
      const removers = types.map((t) => {
        const fn = listener(t);
        button.addEventListener(t, fn);
        return () => button.removeEventListener(t, fn);
      });
      click(ref);
      for (const remove of removers) remove();
      const downAt = Math.min(seen.indexOf('pointerdown'), seen.indexOf('mousedown'));
      expect(downAt).toBeGreaterThan(0);
      for (const hover of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter']) {
        expect(seen.indexOf(hover)).toBeGreaterThanOrEqual(0);
        expect(seen.indexOf(hover)).toBeLessThan(downAt);
      }
    }
  });

  it('never lands two consecutive clicks on the same point', () => {
    document.body.innerHTML = '<button>Go</button>';
    const button = document.querySelector('button') as HTMLButtonElement;
    button.getBoundingClientRect = centerBox(200, 200);
    const points: string[] = [];
    button.addEventListener('click', (e) => {
      points.push(`${(e as MouseEvent).clientX},${(e as MouseEvent).clientY}`);
    });
    const ref = refOf('button');
    for (let n = 0; n < 20; n++) click(ref);
    expect(points).toHaveLength(20);
    for (let i = 1; i < points.length; i++) {
      expect(points[i]).not.toBe(points[i - 1]);
    }
  });
});
