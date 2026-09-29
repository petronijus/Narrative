import { describe, expect, it } from 'vitest'
import { PARAGRAPH_SEP } from '@narrative/slide-model'
import { displayOf, displayRangeOf } from './body.js'

describe('displayRangeOf', () => {
  const raw = `Revenue${PARAGRAPH_SEP}up 12%${PARAGRAPH_SEP}`

  it('counts a paragraph break as the two characters queries show', () => {
    // "Revenue\n\nup 12%" — "up" starts at display 9, stored 8.
    expect(displayOf(raw).display).toBe('Revenue\n\nup 12%')
    expect(displayRangeOf(raw, 8, 10)).toEqual({ start: 9, length: 2 })
    // A range across the break covers both characters of it.
    expect(displayRangeOf(raw, 5, 10)).toEqual({ start: 5, length: 6 })
  })

  it('orders its ends and clamps past the last paragraph', () => {
    expect(displayRangeOf(raw, 10, 8)).toEqual({ start: 9, length: 2 })
    expect(displayRangeOf(raw, 0, raw.length)).toEqual({ start: 0, length: 15 })
  })
})
