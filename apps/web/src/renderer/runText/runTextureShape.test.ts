// @vitest-environment node
/**
 * The texture a run raster gets (runTextSystem.ts → RunTextureShape,
 * mipmapsFor): exact-size where the canvas draws the page, mipmaps only on
 * a raster drawn resampled in the editor. The crowded slide at DPR 2 held
 * 1.86 GB of textures at 544 % with power-of-two pooled, mipmapped run
 * rasters (ADR 0020 → texture memory); the counts are budgeted in
 * memory.zoom.cycle (MEMORY_TEXT_WORK), these are the decisions behind them.
 */
import { describe, expect, it } from 'vitest'
import { mipmapsFor, paintSizeFor, textureSizeFor } from './runTextSystem.js'

describe('run-text texture shape', () => {
  it('paints an exact texture at the raster size, a pooled one at the pool size', () => {
    const raster = { width: 1030, height: 300 }
    expect(paintSizeFor({ kind: 'exact', mipmaps: false }, raster, 5.44)).toEqual(raster)
    const pooled = paintSizeFor({ kind: 'pooled' }, raster, 5.44)
    expect(pooled).toEqual(textureSizeFor(raster, 5.44))
    // The pool rounds each side up to a power of two: here 2048 × 512, 3.4× the raster.
    expect(pooled.width * pooled.height).toBeGreaterThanOrEqual(2 * raster.width * raster.height)
  })

  it('gives no mipmaps to a raster on the device grid in the editor', () => {
    expect(mipmapsFor('resampled', true, 5.44, 5.44)).toBe(false)
    // Held at the off-screen cap below the canvas's resolution: magnified, none.
    expect(mipmapsFor('resampled', false, 2.2, 5.44)).toBe(false)
    // Drawn smaller than painted (a group scaled down): mipmaps.
    expect(mipmapsFor('resampled', false, 2, 1)).toBe(true)
    // Turned at its own scale: none.
    expect(mipmapsFor('resampled', false, 2, 2)).toBe(false)
  })

  it('keeps them on every raster where texts are scaled while they play (present, render page)', () => {
    expect(mipmapsFor('always', true, 2, 2)).toBe(true)
    expect(mipmapsFor('always', false, 2.2, 5.44)).toBe(true)
  })
})
