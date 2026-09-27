/**
 * M5 grounding math: rescaling between sent-image space and viewport space,
 * screenshot budgeting, vision validation, and eval scoring.
 *
 * Pure arithmetic throughout — the live half (a free vision model's actual
 * coordinates over target-site screenshots) is still to run, and when it does,
 * `scoreGrounding` is what turns its predictions into a verdict.
 */
import { describe, expect, it } from 'vitest';
import {
  displayScale,
  displaySize,
  MAX_SENT_DIMENSION,
  pointHitsBox,
  scoreGrounding,
  shouldDownscale,
  toNaturalPoint,
  toSentPoint,
  validateObserveForVision,
} from './grounding';

describe('displayScale / displaySize', () => {
  it('leaves a small screenshot at 1:1 so coordinates map unchanged', () => {
    expect(displayScale({ width: 800, height: 600 }, 1280)).toBe(1);
    expect(displaySize({ width: 800, height: 600 }, 1280)).toEqual({ width: 800, height: 600 });
  });

  it('fits the longest edge to the budget, preserving aspect', () => {
    expect(displayScale({ width: 2560, height: 1440 }, 1280)).toBe(0.5);
    expect(displaySize({ width: 2560, height: 1440 }, 1280)).toEqual({ width: 1280, height: 720 });
  });

  it('never upscales a small image', () => {
    expect(displayScale({ width: 100, height: 100 }, 1280)).toBe(1);
  });
});

describe('toNaturalPoint / toSentPoint', () => {
  it('rescales a downscaled prediction back up to viewport space', () => {
    // A 2560x1440 capture sent at 1280x720: the model reports (640, 360).
    const p = toNaturalPoint({ width: 1280, height: 720 }, { width: 2560, height: 1440 }, { x: 640, y: 360 });
    expect(p).toEqual({ x: 1280, y: 720 });
  });

  it('round-trips a point through sent space and back', () => {
    const natural = { width: 1920, height: 1080 };
    const sent = displaySize(natural, 1280);
    const p = { x: 1500, y: 900 };
    const back = toNaturalPoint(sent, natural, toSentPoint(natural, sent, p));
    expect(back.x).toBeCloseTo(p.x, 6);
    expect(back.y).toBeCloseTo(p.y, 6);
  });

  it('is the identity when nothing was downscaled', () => {
    const size = { width: 800, height: 600 };
    expect(toNaturalPoint(size, size, { x: 123, y: 456 })).toEqual({ x: 123, y: 456 });
  });
});

describe('shouldDownscale', () => {
  it('sends small captures full-size and downscales large ones', () => {
    expect(shouldDownscale({ width: 800, height: 600 })).toBe(false);
    expect(shouldDownscale({ width: 2560, height: 1440 })).toBe(true);
    expect(MAX_SENT_DIMENSION).toBe(1280);
  });
});

describe('validateObserveForVision (O-06)', () => {
  it('allows every mode when the follower sees images, or when vision is unknown', () => {
    for (const observe of ['dom', 'pixels', 'both'] as const) {
      expect(validateObserveForVision(observe, true)).toBeUndefined();
      expect(validateObserveForVision(observe, undefined)).toBeUndefined();
    }
    expect(validateObserveForVision('dom', false)).toBeUndefined();
  });

  it('refuses pixels/both for a known text-only follower, naming the fix', () => {
    for (const observe of ['pixels', 'both'] as const) {
      const reason = validateObserveForVision(observe, false);
      expect(reason).toContain(`observe mode "${observe}"`);
      expect(reason).toContain('vision');
    }
  });
});

describe('scoreGrounding', () => {
  const targets = [
    { label: 'search box', box: { x: 100, y: 200, width: 300, height: 40 } },
    { label: 'buy button', box: { x: 500, y: 600, width: 80, height: 30 } },
  ];

  it('counts a prediction inside its box as a hit', () => {
    expect(pointHitsBox({ x: 250, y: 220 }, targets[0]!)).toBe(true);
    expect(pointHitsBox({ x: 10, y: 10 }, targets[0]!)).toBe(false);
  });

  it('scores one prediction per target as accuracy', () => {
    expect(scoreGrounding([{ x: 250, y: 220 }, { x: 540, y: 615 }], targets)).toEqual({
      hits: 2,
      total: 2,
      accuracy: 1,
    });
    expect(scoreGrounding([{ x: 250, y: 220 }, { x: 10, y: 10 }], targets)).toEqual({
      hits: 1,
      total: 2,
      accuracy: 0.5,
    });
  });

  it('scores an empty set as zero, not NaN', () => {
    expect(scoreGrounding([], [])).toEqual({ hits: 0, total: 0, accuracy: 0 });
  });
});
