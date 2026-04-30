/**
 * renderer/objectRenderers/applyFlip.ts
 *
 * Tiny helper used by every object renderer to apply the optional
 * `flipH` / `flipV` mirror flags onto the Pixi container's scale.
 *
 * Pivot is already centred (each renderer sets pivot = w/2, h/2 so
 * rotation works around the centre), which means scale = ±1 mirrors
 * the contents around the centre axes without moving the AABB.
 * That keeps selection bounds, transform handles and hit-testing
 * untouched while the visual content flips.
 *
 * Idempotent — safe to call on every patch / update pass.
 */

import type { Container } from 'pixi.js'
import type { BaseSlideObject } from '@narrative/shared'

export function applyFlip(node: Container, data: Pick<BaseSlideObject, 'flipH' | 'flipV'>): void {
  node.scale.set(data.flipH === true ? -1 : 1, data.flipV === true ? -1 : 1)
}
