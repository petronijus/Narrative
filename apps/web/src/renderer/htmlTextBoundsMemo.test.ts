import { beforeEach, describe, expect, it } from 'vitest'
import {
  SHARED_MEASUREMENTS_LIMIT,
  installHtmlTextBoundsMemo,
  invalidateHtmlTextMeasurements,
} from './htmlTextBoundsMemo.js'

/** A stand-in for HTMLText: `updateBounds` "measures" 10 px per character and counts itself. */
class FakeText {
  static measured = 0
  text = 'abc'
  _style = { cssStyle: 'div { font-size: 10px }' }
  _anchor = { _x: 0, _y: 0 }
  _bounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 }
  updateBounds(): void {
    FakeText.measured++
    const w = this.text.length * 10
    this._bounds.minX = 0 - this._anchor._x * w
    this._bounds.maxX = this._bounds.minX + w
    this._bounds.minY = 0
    this._bounds.maxY = 20
  }
}
installHtmlTextBoundsMemo(FakeText.prototype)

describe('htmlTextBoundsMemo', () => {
  // Measurements are shared between nodes: every test starts from none.
  beforeEach(() => {
    invalidateHtmlTextMeasurements()
  })

  it('measures once while text, CSS, anchor and the faces are unchanged', () => {
    const t = new FakeText()
    FakeText.measured = 0
    t.updateBounds()
    t._bounds.maxX = -1 // whatever happened to the bounds in between
    t.updateBounds()
    expect(FakeText.measured).toBe(1)
    expect(t._bounds).toEqual({ minX: 0, maxX: 30, minY: 0, maxY: 20 })
  })

  it('measures again after any input changed', () => {
    const t = new FakeText()
    FakeText.measured = 0
    t.updateBounds()
    t.text = 'abcd'
    t.updateBounds()
    expect(t._bounds.maxX).toBe(40)
    t._style = { cssStyle: 'div { font-size: 12px }' }
    t.updateBounds()
    t._anchor = { _x: 0.5, _y: 0 }
    t.updateBounds()
    expect(t._bounds.minX).toBe(-20)
    expect(FakeText.measured).toBe(4)
  })

  it('measures again once the page faces changed', () => {
    const t = new FakeText()
    FakeText.measured = 0
    t.updateBounds()
    invalidateHtmlTextMeasurements()
    t.updateBounds()
    t.updateBounds()
    expect(FakeText.measured).toBe(2)
  })

  it('gives a node the measurement another node took of the same text, CSS and anchor', () => {
    // The editor's autofit measures a growing box on a node of its own in the
    // tick of the keystroke; the canvas's node lays out the same markup a
    // frame later (performance.md → E4).
    invalidateHtmlTextMeasurements()
    const own = new FakeText()
    own.text = 'shared'
    const canvas = new FakeText()
    canvas.text = 'shared'
    FakeText.measured = 0
    own.updateBounds()
    canvas.updateBounds()
    expect(FakeText.measured).toBe(1)
    expect(canvas._bounds).toEqual(own._bounds)
    // Identical to what a measurement of its own gives.
    const fresh = new FakeText()
    fresh.text = 'shared'
    invalidateHtmlTextMeasurements()
    fresh.updateBounds()
    expect(FakeText.measured).toBe(2)
    expect(fresh._bounds).toEqual(canvas._bounds)
  })

  it('shares nothing across another anchor, other CSS or changed faces', () => {
    invalidateHtmlTextMeasurements()
    const a = new FakeText()
    a.text = 'anchored'
    const b = new FakeText()
    b.text = 'anchored'
    b._anchor = { _x: 0.5, _y: 0 }
    const c = new FakeText()
    c.text = 'anchored'
    c._style = { cssStyle: 'div { font-size: 11px }' }
    FakeText.measured = 0
    a.updateBounds()
    b.updateBounds()
    c.updateBounds()
    expect(FakeText.measured).toBe(3)
    expect(b._bounds.minX).toBe(-40)
    invalidateHtmlTextMeasurements()
    const d = new FakeText()
    d.text = 'anchored'
    d.updateBounds()
    expect(FakeText.measured).toBe(4)
  })

  it('keeps a bounded number of shared measurements, the most recent ones', () => {
    invalidateHtmlTextMeasurements()
    FakeText.measured = 0
    const first = new FakeText()
    first.text = 'first'
    first.updateBounds()
    for (let i = 0; i < SHARED_MEASUREMENTS_LIMIT; i++) {
      const t = new FakeText()
      t.text = `filler ${i}`
      t.updateBounds()
    }
    const again = new FakeText()
    again.text = 'first'
    again.updateBounds()
    expect(FakeText.measured).toBe(SHARED_MEASUREMENTS_LIMIT + 2)
    const recent = new FakeText()
    recent.text = `filler ${SHARED_MEASUREMENTS_LIMIT - 1}`
    recent.updateBounds()
    expect(FakeText.measured).toBe(SHARED_MEASUREMENTS_LIMIT + 2)
  })

  it('keeps each node to its own measurement', () => {
    const a = new FakeText()
    const b = new FakeText()
    b.text = 'abcdef'
    a.updateBounds()
    b.updateBounds()
    a.updateBounds()
    expect(a._bounds.maxX).toBe(30)
    expect(b._bounds.maxX).toBe(60)
  })
})
