/**
 * renderer/mediaFit.ts
 *
 * Shared fit helpers for media object renderers (image, video).
 *
 * Extracted from imageRenderer.ts so videoRenderer can reuse without duplication.
 * imageRenderer behavior is unchanged — it now imports from here.
 *
 * Fit modes (within width × height bounding box):
 * - 'cover'  : scale = max(boxW/texW, boxH/texH). Sprite is masked to box size.
 * - 'contain': scale = min(boxW/texW, boxH/texH). Centered, no mask needed.
 */

import { Graphics, type Container, type Sprite, type Texture } from 'pixi.js'

/**
 * Applies cover or contain fit to a Sprite within a bounding box.
 * The sprite's position is relative to the box origin (0,0).
 */
export function applyFit(
  sprite: Sprite,
  texture: Texture,
  box: { w: number; h: number },
  fit: 'cover' | 'contain',
): void {
  const tw = texture.width
  const th = texture.height

  // Guard against zero-size textures.
  if (tw === 0 || th === 0) return

  const scale =
    fit === 'cover' ? Math.max(box.w / tw, box.h / th) : Math.min(box.w / tw, box.h / th)

  sprite.width = tw * scale
  sprite.height = th * scale
  sprite.x = (box.w - sprite.width) / 2
  sprite.y = (box.h - sprite.height) / 2
}

/**
 * Updates or creates the cover mask Graphics on the sprite wrap container.
 * The mask is a simple rectangle sized to the bounding box.
 */
export function applyCoverMask(
  spriteWrap: Container,
  existingMask: Graphics | undefined,
  box: { w: number; h: number },
): Graphics {
  const mask = existingMask ?? new Graphics()
  mask.clear()
  mask.rect(0, 0, box.w, box.h)
  mask.fill({ color: 0xffffff, alpha: 1 })

  if (existingMask === undefined) {
    spriteWrap.addChild(mask)
    spriteWrap.mask = mask
  }

  return mask
}
