// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

vi.mock('../renderer/devicePixelRatioWatch.js', () => ({ watchDevicePixelRatio: () => () => {} }))

import { thumbnailPixelWidth, WIDTH_STEP } from './useThumbnailPixelWidth.js'

describe('thumbnailPixelWidth', () => {
  it('is the frame in device pixels, rounded up to the step', () => {
    // The default panel's row at 1× and at 2×.
    expect(thumbnailPixelWidth(223, 1)).toBe(224)
    expect(thumbnailPixelWidth(223, 2)).toBe(448)
    expect(thumbnailPixelWidth(224, 1) % WIDTH_STEP).toBe(0)
  })

  it('never exceeds the slide, never falls below one step', () => {
    expect(thumbnailPixelWidth(400, 6)).toBe(1920)
    expect(thumbnailPixelWidth(0.5, 1)).toBe(WIDTH_STEP)
  })
})
