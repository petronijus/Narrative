import { describe, expect, it } from 'vitest'
import { parseAcceptArgs, takesSeries } from './acceptArgs.js'

describe('parseAcceptArgs', () => {
  it('takes every series without --series', () => {
    expect(parseAcceptArgs(['a.b', 'c'])).toEqual({ ids: ['a.b', 'c'], series: null })
  })

  it('takes the named series, comma-separated and repeated', () => {
    const { ids, series } = parseAcceptArgs([
      'a',
      '--series',
      'prod/chromium-browser,dev/chromium-browser',
      'b',
      '--series=prod/webkit-browser',
    ])
    expect(ids).toEqual(['a', 'b'])
    expect([...series!].sort()).toEqual([
      'dev/chromium-browser',
      'prod/chromium-browser',
      'prod/webkit-browser',
    ])
    expect(takesSeries(series, 'a@prod/webkit-browser')).toBe(true)
    expect(takesSeries(series, 'a@prod/webkit-tauri-2x')).toBe(false)
    expect(takesSeries(null, 'a@prod/webkit-tauri-2x')).toBe(true)
  })

  it('none: the budget only, no baseline', () => {
    const { series } = parseAcceptArgs(['a', '--series', 'none'])
    expect(series?.size).toBe(0)
    expect(takesSeries(series, 'a@dev/chromium-browser')).toBe(false)
  })

  it('refuses a malformed series or an unknown option', () => {
    expect(() => parseAcceptArgs(['a', '--series'])).toThrow(/needs a value/)
    expect(() => parseAcceptArgs(['a', '--series', 'chromium'])).toThrow(/mode\/runtime/)
    expect(() => parseAcceptArgs(['a', '--all'])).toThrow(/unknown option/)
  })
})
