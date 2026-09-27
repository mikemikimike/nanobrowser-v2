import { describe, expect, it } from 'vitest';
import { jitterInBox, planPath, sampleHold, sampleInterKey } from '@/src/input/humanize';
import { seededRng } from './support/rng';

describe('jitterInBox', () => {
  const box = { x: 100, y: 200, width: 80, height: 40 };

  it('stays inside the box across many draws', () => {
    const rng = seededRng(11);
    for (let i = 0; i < 500; i++) {
      const p = jitterInBox(box, rng);
      expect(p.x).toBeGreaterThanOrEqual(box.x);
      expect(p.x).toBeLessThanOrEqual(box.x + box.width);
      expect(p.y).toBeGreaterThanOrEqual(box.y);
      expect(p.y).toBeLessThanOrEqual(box.y + box.height);
    }
  });

  it('never lands exactly on the center the old code always aimed at', () => {
    const rng = seededRng(12);
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    let offCenter = 0;
    for (let i = 0; i < 200; i++) {
      const p = jitterInBox(box, rng);
      if (p.x !== cx || p.y !== cy) offCenter += 1;
    }
    // Uniform over a non-degenerate range: every draw in practice misses center.
    expect(offCenter).toBe(200);
  });

  it('stays within 35% of each half-extent around the center', () => {
    const rng = seededRng(13);
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    for (let i = 0; i < 500; i++) {
      const p = jitterInBox(box, rng);
      expect(Math.abs(p.x - cx)).toBeLessThanOrEqual((box.width / 2) * 0.35 + 1e-9);
      expect(Math.abs(p.y - cy)).toBeLessThanOrEqual((box.height / 2) * 0.35 + 1e-9);
    }
  });

  it('is deterministic for a given seed', () => {
    const a = jitterInBox(box, seededRng(42));
    const b = jitterInBox(box, seededRng(42));
    expect(a).toEqual(b);
  });
});

describe('planPath (WindMouse)', () => {
  it('starts exactly at `from`', () => {
    const path = planPath({ x: 10, y: 20 }, { x: 400, y: 300 }, { rng: seededRng(1) });
    expect(path[0]).toMatchObject({ x: 10, y: 20, t: 0 });
  });

  it('ends within the target radius', () => {
    const targetArea = 10;
    const to = { x: 400, y: 300 };
    for (let seed = 1; seed <= 10; seed++) {
      const path = planPath({ x: 5, y: 5 }, to, { rng: seededRng(seed), targetArea });
      const last = path[path.length - 1]!;
      const d = Math.hypot(last.x - to.x, last.y - to.y);
      expect(d).toBeLessThanOrEqual(targetArea);
    }
  });

  it('produces strictly monotonic timestamps', () => {
    const path = planPath({ x: 0, y: 0 }, { x: 500, y: 500 }, { rng: seededRng(2) });
    for (let i = 1; i < path.length; i++) {
      expect(path[i]!.t).toBeGreaterThan(path[i - 1]!.t);
    }
  });

  it('never jumps farther between consecutive points than maxStep allows (bounded noise)', () => {
    const maxStep = 12;
    const path = planPath({ x: 0, y: 0 }, { x: 600, y: 450 }, { rng: seededRng(3), maxStep });
    // Bounded noise contribution: clamp(+/-3 sigma) per axis at `noise` stdev (default 0.6),
    // so worst-case extra distance is sqrt(2) * 3 * noise ~= 2.55px. Give a little headroom.
    const bound = maxStep + 4;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]!;
      const b = path[i]!;
      const jump = Math.hypot(b.x - a.x, b.y - a.y);
      expect(jump).toBeLessThanOrEqual(bound);
    }
  });

  it('introduces noise on both axes (not a straight line)', () => {
    const path = planPath({ x: 0, y: 0 }, { x: 800, y: 0 }, { rng: seededRng(4) });
    // A pure gravity pull toward a target with the same y would keep every
    // point at y === 0; wind + gaussian noise should move it off-axis.
    const offAxis = path.some(p => Math.abs(p.y) > 0.01);
    expect(offAxis).toBe(true);
  });

  it('handles from === to without looping', () => {
    const path = planPath({ x: 50, y: 50 }, { x: 50, y: 50 }, { rng: seededRng(5) });
    expect(path).toEqual([{ x: 50, y: 50, t: 0 }]);
  });

  it('is deterministic for a given seed', () => {
    const a = planPath({ x: 0, y: 0 }, { x: 300, y: 200 }, { rng: seededRng(42) });
    const b = planPath({ x: 0, y: 0 }, { x: 300, y: 200 }, { rng: seededRng(42) });
    expect(a).toEqual(b);
  });
});

describe('sampleHold', () => {
  it('stays within the requested bounds across many draws', () => {
    const rng = seededRng(7);
    for (let i = 0; i < 500; i++) {
      const v = sampleHold({ minMs: 40, maxMs: 120, rng });
      expect(v).toBeGreaterThanOrEqual(40);
      expect(v).toBeLessThanOrEqual(120);
    }
  });

  it('respects a narrower range (key hold 40-80ms)', () => {
    const rng = seededRng(8);
    for (let i = 0; i < 500; i++) {
      const v = sampleHold({ minMs: 40, maxMs: 80, rng });
      expect(v).toBeGreaterThanOrEqual(40);
      expect(v).toBeLessThanOrEqual(80);
    }
  });
});

describe('sampleInterKey', () => {
  it('is always positive and centres near the requested mean', () => {
    const rng = seededRng(9);
    const samples = Array.from({ length: 2000 }, () => sampleInterKey({ meanMs: 90, sigmaMs: 30, rng }));
    for (const s of samples) {
      expect(s).toBeGreaterThan(0);
    }
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    expect(mean).toBeGreaterThan(70);
    expect(mean).toBeLessThan(110);
  });
});
