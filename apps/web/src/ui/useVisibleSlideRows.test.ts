/**
 * ui/useVisibleSlideRows.test.ts — RowVisibility: each row hears only about
 * its own visibility changing (performance.md → B3).
 */

import { describe, expect, it, vi } from 'vitest'
import { RowVisibility } from './useVisibleSlideRows.js'

describe('RowVisibility', () => {
  it('starts with no row near the view, and tells only the rows that changed', () => {
    const v = new RowVisibility()
    const a = vi.fn()
    const b = vi.fn()
    const c = vi.fn()
    v.subscribe('a', a)
    v.subscribe('b', b)
    v.subscribe('c', c)
    expect(v.has('a')).toBe(false)

    v.set(new Set(['a', 'b']))
    expect([v.has('a'), v.has('b'), v.has('c')]).toEqual([true, true, false])
    expect([a.mock.calls.length, b.mock.calls.length, c.mock.calls.length]).toEqual([1, 1, 0])

    // A scroll: b leaves, c comes; a stays and hears nothing.
    v.set(new Set(['a', 'c']))
    expect([a.mock.calls.length, b.mock.calls.length, c.mock.calls.length]).toEqual([1, 2, 1])
  })

  it('counts every row as visible where nothing can measure', () => {
    const v = new RowVisibility()
    const a = vi.fn()
    v.subscribe('a', a)
    v.set(null)
    expect(v.has('a')).toBe(true)
    expect(v.has('anything')).toBe(true)
    expect(a).toHaveBeenCalledTimes(1)
  })

  it('keeps its own copy of the set it is given, and forgets a row that unsubscribed', () => {
    const v = new RowVisibility()
    const shown = new Set(['a'])
    v.set(shown)
    shown.add('b')
    expect(v.has('b')).toBe(false)
    const a = vi.fn()
    const off = v.subscribe('a', a)
    off()
    v.set(new Set())
    expect(a).not.toHaveBeenCalled()
  })
})
