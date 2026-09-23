import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import {
  MAX_STORED_IMAGE_PIXELS,
  MAX_STORED_IMAGE_SIDE,
  downscaleForStorage,
  exceedsStoredImageLimits,
  fitWithinStoredImageLimits,
} from './storedImageLimits.js'

/** A flat-colour image — compresses to almost nothing, so even a large one
 *  is cheap to build and decode in a test. */
function solid(width: number, height: number, format: 'png' | 'jpeg', alpha = 1): Promise<Buffer> {
  const img = sharp({
    create: { width, height, channels: 4, background: { r: 200, g: 30, b: 40, alpha } },
  })
  return (format === 'png' ? img.png() : img.jpeg()).toBuffer()
}

describe('fitWithinStoredImageLimits', () => {
  it('scales the Proseware deck background (9903×14853, 147 MP) under the pixel budget', () => {
    const fit = fitWithinStoredImageLimits(9903, 14853)
    expect(fit.width * fit.height).toBeLessThanOrEqual(MAX_STORED_IMAGE_PIXELS)
    // Aspect ratio survives to within a pixel.
    expect(Math.abs(fit.width / fit.height - 9903 / 14853)).toBeLessThan(1 / fit.height)
    // And it is not needlessly small: one more pixel per side would not fit.
    expect((fit.width + 1) * (fit.height + 1)).toBeGreaterThan(MAX_STORED_IMAGE_PIXELS)
  })

  it('caps the long side even when the pixel count is small', () => {
    const fit = fitWithinStoredImageLimits(40_000, 200)
    expect(fit.width).toBe(MAX_STORED_IMAGE_SIDE)
    expect(fit.height).toBe(81) // 200 × 16384 / 40000, floored
  })

  it('leaves an image that already fits alone', () => {
    expect(fitWithinStoredImageLimits(4000, 3000)).toEqual({ width: 4000, height: 3000 })
    expect(exceedsStoredImageLimits(4000, 3000)).toBe(false)
  })
})

describe('downscaleForStorage', () => {
  it('returns null for an image within the limits', async () => {
    expect(await downscaleForStorage(await solid(800, 600, 'png'), 'image/png')).toBeNull()
  })

  it('returns null for a format it cannot re-encode faithfully', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="20000" height="20000"/>',
    )
    expect(await downscaleForStorage(svg, 'image/svg+xml')).toBeNull()
  })

  it('brings an over-long PNG under the side limit and keeps it a PNG with alpha', async () => {
    const out = await downscaleForStorage(
      await solid(MAX_STORED_IMAGE_SIDE + 2000, 100, 'png', 0.5),
      'image/png',
    )
    expect(out).not.toBeNull()
    expect(out!.width).toBe(MAX_STORED_IMAGE_SIDE)
    const meta = await sharp(out!.bytes).metadata()
    expect(meta.format).toBe('png')
    expect(meta.hasAlpha).toBe(true)
    expect(meta.width).toBe(out!.width)
    expect(meta.height).toBe(out!.height)
  })

  it('keeps a downscaled JPEG a JPEG', async () => {
    // Over the side limit rather than the pixel budget: a 40 MP+ fixture
    // takes seconds to encode and decode and timed out under the parallel
    // suite. The budget arithmetic itself is covered by
    // fitWithinStoredImageLimits above; this only has to prove the format.
    const out = await downscaleForStorage(
      await solid(MAX_STORED_IMAGE_SIDE + 1000, 50, 'jpeg'),
      'image/jpeg',
    )
    expect(out).not.toBeNull()
    expect(out!.width).toBe(MAX_STORED_IMAGE_SIDE)
    expect((await sharp(out!.bytes).metadata()).format).toBe('jpeg')
  })

  it('applies EXIF orientation, reporting the size as displayed', async () => {
    // Stored landscape, tagged "rotate 90° CW" (orientation 6) → displayed portrait.
    const rotated = await sharp(await solid(MAX_STORED_IMAGE_SIDE + 1000, 50, 'jpeg'))
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer()
    const out = await downscaleForStorage(rotated, 'image/jpeg')
    expect(out).not.toBeNull()
    expect(out!.height).toBe(MAX_STORED_IMAGE_SIDE)
    expect(out!.width).toBeLessThan(out!.height)
    expect((await sharp(out!.bytes).metadata()).orientation ?? 1).toBe(1)
  })
})
