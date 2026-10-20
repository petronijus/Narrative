import { describe, expect, it } from 'vitest'
import { installHtmlTextBoundsMemo, invalidateHtmlTextMeasurements } from './htmlTextBoundsMemo.js'

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
