// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const read = vi.hoisted(() => ({ calls: [] as string[] }))
vi.mock('./readRuns.js', () => ({
  readRuns: (markup: string, style: { cssStyle: string; padding: number }) => {
    read.calls.push(markup)
    return {
      width: markup.length,
      height: style.cssStyle.length,
      padding: style.padding,
      runs: [],
      decorations: [],
    }
  },
}))

import { invalidateHtmlTextMeasurements } from '../htmlTextBoundsMemo.js'
import {
  _clearRunLayoutsForTests,
  LAYOUT_CACHE_LIMIT,
  measureWithRunLayout,
  runLayoutFor,
} from './layoutCache.js'

const style = (css = 'foreignObject > div { font-size: 10px }', padding = 4) => ({
  cssStyle: css,
  padding,
})

beforeEach(() => {
  read.calls = []
  _clearRunLayoutsForTests()
})

describe('runLayoutFor', () => {
  it('lays a text out once for its bounds, its raster and every repaint', () => {
    const a = runLayoutFor('<!--n:12-->Hello', style())
    const b = runLayoutFor('<!--n:12-->Hello', style())
    expect(b).toBe(a)
    expect(read.calls).toEqual(['<!--n:12-->Hello'])
  })

  it('shares a layout between nodes with the same text (the per-node comment does not lay out)', () => {
    runLayoutFor('<!--n:1-->Same', style())
    runLayoutFor('<!--n:2-->Same', style())
    expect(read.calls).toHaveLength(1)
  })

  it('lays out again for other CSS, another padding or once the faces changed', () => {
    runLayoutFor('x', style())
    runLayoutFor('x', style('foreignObject > div { font-size: 12px }'))
    runLayoutFor('x', style(undefined, 6))
    invalidateHtmlTextMeasurements()
    runLayoutFor('x', style())
    expect(read.calls).toHaveLength(4)
  })

  it('keeps a bounded number of layouts, dropping the least recently used', () => {
    for (let i = 0; i < LAYOUT_CACHE_LIMIT; i++) runLayoutFor(`t${i}`, style())
    runLayoutFor('t0', style()) // used again: the most recent now
    runLayoutFor('new', style()) // drops t1
    read.calls = []
    runLayoutFor('t0', style())
    expect(read.calls).toEqual([])
    runLayoutFor('t1', style())
    expect(read.calls).toEqual(['t1'])
  })
})

describe('measureWithRunLayout', () => {
  it('measures a node from its layout', () => {
    expect(measureWithRunLayout({ text: 'abcd', _style: style('css', 2) })).toEqual({
      width: 4,
      height: 3,
    })
  })
})
