import { describe, expect, it } from 'vitest'
import { EXTERNAL_OPENS_PER_WINDOW, EXTERNAL_OPEN_WINDOW_MS, allowExternalOpen } from './guards.js'

describe('external opens', () => {
  it('lets a few through, then waits for the window to pass', () => {
    const recent: number[] = []
    for (let i = 0; i < EXTERNAL_OPENS_PER_WINDOW; i++)
      expect(allowExternalOpen(1000 + i, recent)).toBe(true)
    expect(allowExternalOpen(1100, recent)).toBe(false)
    expect(allowExternalOpen(1000 + EXTERNAL_OPEN_WINDOW_MS, recent)).toBe(true)
  })
})
