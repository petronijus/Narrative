/**
 * state/thumbnailRetry.ts
 *
 * When a failed thumbnail render is tried again (useSlideThumbnails).
 *
 * A render can fail for a frame and work on the next — Pixi throwing on a
 * node destroyed mid-batch, a token repaint racing the frame
 * (renderer/thumbnails.ts reports `[ThumbnailRenderer] render failed: …`).
 * Without a retry the thumbnail stayed stale until the slide was edited
 * again. Two limits keep the retry from hammering:
 *
 * - **Per slide**: a few attempts with exponential backoff, then it gives
 *   up. The budget starts over when the slide's content changes (a new
 *   render request) — new content is a new chance.
 * - **Per renderer**: when renders keep failing whatever the slide (a run of
 *   consecutive failures with no success between them), the renderer itself
 *   looks gone — a lost context, released pools. Retrying every slide would
 *   only multiply the failures, so they are parked instead, and re-queued
 *   once a render succeeds again (a later edit proves the renderer works).
 */

export interface ThumbnailRetryPolicy {
  /** Retries of one slide after its first failure, before giving up. */
  maxRetries: number
  /** Delay before the first retry; doubles for each one after. */
  baseDelayMs: number
  /** Upper bound of a single delay. */
  maxDelayMs: number
  /** Consecutive failures (any slide, no success between) that mark the renderer as gone. */
  rendererFailureLimit: number
}

export const THUMBNAIL_RETRY_POLICY: ThumbnailRetryPolicy = {
  maxRetries: 4,
  baseDelayMs: 1_000,
  maxDelayMs: 8_000,
  rendererFailureLimit: 6,
}

export type ThumbnailRetryDecision =
  /** Render the slide again after `delayMs`. */
  | { kind: 'retry'; delayMs: number }
  /** The renderer looks gone: hold the slide until a render succeeds. */
  | { kind: 'park' }
  /** This slide has used its budget: leave it until its content changes. */
  | { kind: 'give-up' }

export interface ThumbnailFailureState {
  /** Failed renders of this slide since its content last changed (≥ 1: includes this one). */
  slideFailures: number
  /** Failed renders in a row across all slides (≥ 1: includes this one). */
  consecutiveFailures: number
}

/** What to do after a failed render. */
export function decideThumbnailRetry(
  state: ThumbnailFailureState,
  policy: ThumbnailRetryPolicy = THUMBNAIL_RETRY_POLICY,
): ThumbnailRetryDecision {
  if (state.consecutiveFailures >= policy.rendererFailureLimit) return { kind: 'park' }
  if (state.slideFailures > policy.maxRetries) return { kind: 'give-up' }
  const exponent = Math.max(0, state.slideFailures - 1)
  return { kind: 'retry', delayMs: Math.min(policy.baseDelayMs * 2 ** exponent, policy.maxDelayMs) }
}
