/**
 * Grounding (M5): the math between screenshot pixels and the viewport points
 * the input tiers act on (R-08 `pixels`/`both`, R-13 escalation).
 *
 * A vision model sees a *sent* image that may be smaller than the captured one
 * (budgeting below), and reports coordinates in that sent space. Everything it
 * returns must be rescaled back up before it reaches `InputTier` coordinates,
 * which are CSS pixels in the tab viewport — never device pixels, never sent
 * image pixels. This module is pure so the conversions are unit-testable; the
 * actual downscaling at the send site and any `click_at` tool built on top are
 * later work gated on the eval (§scoring) saying a free model's coordinates
 * can be trusted at all.
 */
import type { ObserveMode } from '@/src/storage';

export interface ImageSize {
  width: number;
  height: number;
}

export interface GroundPoint {
  x: number;
  y: number;
}

/**
 * Scale (<= 1) so the longest edge of `natural` fits `maxDimension`.
 * Returns 1 when the image already fits — never upscales, so coordinates
 * taken from an unscaled screenshot map 1:1.
 */
export function displayScale(natural: ImageSize, maxDimension: number): number {
  const longest = Math.max(natural.width, natural.height);
  if (!(longest > 0) || !(maxDimension > 0)) return 1;
  return Math.min(1, maxDimension / longest);
}

/** The size actually sent to the model for a capture of `natural` size. */
export function displaySize(natural: ImageSize, maxDimension: number): ImageSize {
  const scale = displayScale(natural, maxDimension);
  return { width: Math.max(1, Math.round(natural.width * scale)), height: Math.max(1, Math.round(natural.height * scale)) };
}

/**
 * Maps a model-reported point in *sent* image space back to natural CSS-pixel
 * space. Both sizes are required because the model only ever sees the sent
 * one: without the declared sent size the rescale factor is a guess.
 */
export function toNaturalPoint(sent: ImageSize, natural: ImageSize, p: GroundPoint): GroundPoint {
  if (!(sent.width > 0) || !(sent.height > 0)) return { ...p };
  return { x: (p.x * natural.width) / sent.width, y: (p.y * natural.height) / sent.height };
}

/** The inverse: a known viewport point expressed in sent image space. */
export function toSentPoint(natural: ImageSize, sent: ImageSize, p: GroundPoint): GroundPoint {
  if (!(natural.width > 0) || !(natural.height > 0)) return { ...p };
  return { x: (p.x * sent.width) / natural.width, y: (p.y * sent.height) / natural.height };
}

/* ------------------------------------------------------------------------- */
/* Screenshot budgeting                                                       */
/* ------------------------------------------------------------------------- */

/**
 * How large a sent screenshot may be along its longest edge.
 *
 * Full PNG every step (resent up to 3x via trimmed history) is the run's
 * biggest context cost. Deliberately a pixel count, not a token count: image
 * token pricing is provider-specific, but pixels are what we control before
 * the provider ever sees the bytes.
 */
export const MAX_SENT_DIMENSION = 1280;

/** True when sending `natural` at full size would exceed the budget. */
export function shouldDownscale(natural: ImageSize, maxDimension: number = MAX_SENT_DIMENSION): boolean {
  return displayScale(natural, maxDimension) < 1;
}

/* ------------------------------------------------------------------------- */
/* Vision-capability validation (O-06)                                        */
/* ------------------------------------------------------------------------- */

/**
 * Refusal reason when `observe` needs vision the Follower does not have, or
 * `undefined` when the combination is fine.
 *
 * `followerVision` unknown (`undefined`) is allowed through: the runs that
 * exist today carry no vision flag, and refusing them would break working
 * setups to fix a broken one. The silent-broken case this closes is the
 * *known* text-only Follower plus `pixels`/`both` — currently a run that
 * screenshots into a void and never says why.
 */
export function validateObserveForVision(
  observe: ObserveMode,
  followerVision: boolean | undefined,
): string | undefined {
  if (observe !== 'pixels' && observe !== 'both') return undefined;
  if (followerVision === false) {
    return (
      `observe mode "${observe}" needs a vision-capable Follower model, but the selected ` +
      'Follower cannot see images: pick a vision model or switch observe to "dom"'
    );
  }
  return undefined;
}

/* ------------------------------------------------------------------------- */
/* Grounding-accuracy eval scoring                                            */
/* ------------------------------------------------------------------------- */

export interface GroundTarget {
  label: string;
  box: { x: number; y: number; width: number; height: number };
}

/** True when a (rescaled) predicted point lands inside the target's box. */
export function pointHitsBox(p: GroundPoint, target: GroundTarget): boolean {
  return (
    p.x >= target.box.x &&
    p.x <= target.box.x + target.box.width &&
    p.y >= target.box.y &&
    p.y <= target.box.y + target.box.height
  );
}

export interface GroundingScore {
  hits: number;
  total: number;
  accuracy: number;
}

/**
 * Scores one prediction per target, in order. The live eval (model +
 * target-site screenshots) is still to run; this is its scoring half, so the
 * eval's verdict is arithmetic, not vibes, when the screenshots exist.
 */
export function scoreGrounding(predictions: GroundPoint[], targets: GroundTarget[]): GroundingScore {
  let hits = 0;
  const total = targets.length;
  for (let i = 0; i < total; i++) {
    const p = predictions[i];
    const target = targets[i]!;
    if (p && pointHitsBox(p, target)) hits += 1;
  }
  return { hits, total, accuracy: total === 0 ? 0 : hits / total };
}
