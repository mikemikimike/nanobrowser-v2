/**
 * Pure kinematics and timing samplers shared by any coordinate-based
 * `InputTier`. No browser or CDP dependency here — this module is testable
 * without a DOM. See docs/research/bot-detection-research.md §Recommendation
 * (row 3/6: dense, non-uniform trajectories beat curve beauty) and
 * docs/research/trusted-input-and-stealth.md §6 (WindMouse over Bézier).
 */

/** A source of uniform randomness in [0, 1). Inject a seeded one in tests. */
export type Rng = () => number;

export interface Point {
  x: number;
  y: number;
}

/** Anything with a viewport box: a DOMRect, a `Box`, a getBox result. */
export interface BoxLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A click point inside `box`: the centre plus a uniform offset of up to 35% of
 * each half-extent — never dead-center (a bot tell per
 * docs/research/trusted-input-and-stealth.md §4) and never outside the clickable
 * area. Shared by the in-page tier (`src/page/actions.ts`) and the coordinate
 * tiers (`refToPoint` below) so every tier aims the same way.
 */
export function jitterInBox(box: BoxLike, rng: Rng = Math.random): Point {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const jitterX = (rng() * 2 - 1) * (box.width / 2) * 0.35;
  const jitterY = (rng() * 2 - 1) * (box.height / 2) * 0.35;
  return { x: cx + jitterX, y: cy + jitterY };
}

/** One planned pointer sample: a viewport point with a wall-clock offset in ms. */
export interface PathPoint extends Point {
  /** Milliseconds since the first point (t=0 for the start point). */
  t: number;
}

export interface PlanPathOptions {
  /** Gravity: pull toward the target per step. Default 9. */
  gravity?: number;
  /** Wind: lateral randomness while far from target. Default 3. */
  wind?: number;
  /** Max speed (px/step) before clipping. Default 12. */
  maxStep?: number;
  /** Radius (px) within which wind decays and the path settles. Default 10. */
  targetArea?: number;
  /** Standard deviation (px) of the isotropic Gaussian noise added per step. Default 0.6. */
  noise?: number;
  /** Base time between planned samples, ms. Default 8 (~120Hz). Jittered +/-30%. */
  stepMs?: number;
  /** Random source. Default Math.random. */
  rng?: Rng;
  /** Safety cap on iterations so a degenerate input can't loop forever. Default 500. */
  maxIterations?: number;
}

const SQRT3 = Math.sqrt(3);
const SQRT5 = Math.sqrt(5);

/** Box-Muller: one standard-normal sample from two uniforms. */
function gaussian(rng: Rng): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function dist(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Gaussian clamped to +/-3 sigma so a per-step noise contribution stays bounded
 * (real pointer jitter has no meaningful tail past that anyway). */
function clampedGaussian(rng: Rng): number {
  const g = gaussian(rng);
  return Math.max(-3, Math.min(3, g));
}

/**
 * Plans a humanized pointer path from `from` to `to` using the WindMouse
 * force model (gravity pulls toward the target, wind adds lateral drift that
 * decays inside `targetArea`), plus isotropic Gaussian noise per step and an
 * occasional small corrective sub-movement once the path has settled near
 * the target — real pointer motion rarely lands exactly once.
 *
 * Guarantees: first point equals `from` (t=0); returns within `targetArea`
 * of `to`; timestamps are strictly increasing; no consecutive points are
 * farther apart than `maxStep` (+ noise, bounded below).
 */
export function planPath(from: Point, to: Point, opts: PlanPathOptions = {}): PathPoint[] {
  const gravity = opts.gravity ?? 9;
  const wind = opts.wind ?? 3;
  let maxStep = opts.maxStep ?? 12;
  const targetArea = opts.targetArea ?? 10;
  const noise = opts.noise ?? 0.6;
  const stepMs = opts.stepMs ?? 8;
  const rng = opts.rng ?? Math.random;
  const maxIterations = opts.maxIterations ?? 500;

  const points: PathPoint[] = [{ x: from.x, y: from.y, t: 0 }];

  // Degenerate case: already there.
  if (dist(from, to) < 1) {
    return points;
  }

  let x = from.x;
  let y = from.y;
  let vx = 0;
  let vy = 0;
  let windX = 0;
  let windY = 0;
  let t = 0;

  for (let i = 0; i < maxIterations; i++) {
    const d = dist({ x, y }, to);
    if (d < 1) break;

    const windMag = Math.min(wind, d);
    if (d >= targetArea) {
      windX = windX / SQRT3 + ((rng() * 2 - 1) * windMag) / 3;
      windY = windY / SQRT3 + ((rng() * 2 - 1) * windMag) / 3;
    } else {
      windX /= SQRT3;
      windY /= SQRT3;
      maxStep = maxStep < 3 ? rng() * 3 + 3 : maxStep / SQRT5;
    }

    vx += windX + (gravity * (to.x - x)) / d;
    vy += windY + (gravity * (to.y - y)) / d;

    const vMag = Math.hypot(vx, vy);
    if (vMag > maxStep) {
      const clip = maxStep / 2 + rng() * (maxStep / 2);
      vx = (vx / vMag) * clip;
      vy = (vy / vMag) * clip;
    }

    x += vx + clampedGaussian(rng) * noise;
    y += vy + clampedGaussian(rng) * noise;

    t += Math.round(stepMs * (0.7 + rng() * 0.6));
    points.push({ x, y, t });
  }

  const nextT = (afterT: number) => afterT + Math.max(1, Math.round(stepMs * (0.7 + rng() * 0.6)));
  // Non-null: `points` always has at least the start point pushed above.
  const last = points[points.length - 1]!;

  if (last.x !== to.x || last.y !== to.y) {
    // Occasional corrective sub-movement: overshoot the target by a small,
    // bounded amount and settle exactly on it one sample later — real
    // pointer motion rarely lands in a single terminal step.
    if (rng() < 0.5) {
      const overshootMag = maxStep * (0.15 + rng() * 0.25); // stays < maxStep
      const angle = rng() * Math.PI * 2;
      const t1 = nextT(last.t);
      points.push({ x: to.x + Math.cos(angle) * overshootMag, y: to.y + Math.sin(angle) * overshootMag, t: t1 });
      points.push({ x: to.x, y: to.y, t: nextT(t1) });
    } else {
      points.push({ x: to.x, y: to.y, t: nextT(last.t) });
    }
  }

  return points;
}

export interface SampleRangeOptions {
  minMs?: number;
  maxMs?: number;
  rng?: Rng;
}

/**
 * Uniform hold duration (press-to-release, or key down-to-up) in ms.
 * Debugger click holds sample 40-120ms; key holds sample 40-80ms (pass a
 * narrower range) — see docs/research/trusted-input-and-stealth.md §6.
 */
export function sampleHold(opts: SampleRangeOptions = {}): number {
  const min = opts.minMs ?? 40;
  const max = opts.maxMs ?? 120;
  const rng = opts.rng ?? Math.random;
  return Math.round(min + rng() * (max - min));
}

export interface SampleInterKeyOptions {
  /** Desired mean, ms. Default 90. */
  meanMs?: number;
  /** Desired standard deviation, ms. Default 30. */
  sigmaMs?: number;
  rng?: Rng;
}

/**
 * Inter-keystroke delay in ms, drawn from a log-normal distribution with the
 * given mean and standard deviation (both in ms, not log-space) — reaction
 * times are right-skewed and never negative, unlike a Gaussian.
 */
export function sampleInterKey(opts: SampleInterKeyOptions = {}): number {
  const mean = opts.meanMs ?? 90;
  const sigma = opts.sigmaMs ?? 30;
  const rng = opts.rng ?? Math.random;

  const variance = sigma * sigma;
  const logSigma2 = Math.log(1 + variance / (mean * mean));
  const logSigma = Math.sqrt(logSigma2);
  const logMu = Math.log(mean) - logSigma2 / 2;

  const sample = Math.exp(logMu + logSigma * gaussian(rng));
  return Math.max(1, Math.round(sample));
}
