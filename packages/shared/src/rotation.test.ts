import { describe, expect, it } from 'vitest'
import { rotationFromDegrees, rotationToDegrees } from './rotation.js'

describe('rotationFromDegrees', () => {
  it('converts to radians', () => {
    expect(rotationFromDegrees(90)).toBeCloseTo(Math.PI / 2, 12)
    expect(rotationFromDegrees(0)).toBe(0)
  })

  it('normalises into (−π, π] so a small counter-clockwise tilt reads as negative', () => {
    // PPTX rot="21178237" → 352.97°, a 7° counter-clockwise tilt.
    expect(rotationFromDegrees(352.9706)).toBeCloseTo((-7.0294 * Math.PI) / 180, 9)
    expect(rotationFromDegrees(180)).toBeCloseTo(Math.PI, 12)
    expect(rotationFromDegrees(-180)).toBeCloseTo(Math.PI, 12)
    expect(rotationFromDegrees(720 + 45)).toBeCloseTo(Math.PI / 4, 12)
  })

  it('treats non-finite input as upright', () => {
    expect(rotationFromDegrees(Number.NaN)).toBe(0)
  })
})

describe('rotationToDegrees', () => {
  it('returns degrees in [0, 360)', () => {
    expect(rotationToDegrees(Math.PI / 2)).toBeCloseTo(90, 9)
    expect(rotationToDegrees(-Math.PI / 2)).toBeCloseTo(270, 9)
    expect(rotationToDegrees(2 * Math.PI)).toBeCloseTo(0, 9)
  })

  it('round-trips with rotationFromDegrees', () => {
    for (const deg of [0, 7, 90, 179.5, 181, 270, 352.97]) {
      expect(rotationToDegrees(rotationFromDegrees(deg))).toBeCloseTo(deg, 9)
    }
  })
})
