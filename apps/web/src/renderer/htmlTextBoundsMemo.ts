/**
 * renderer/htmlTextBoundsMemo.ts — an HTMLText is measured again only when
 * something its measurement depends on changed.
 *
 * Pixi measures an HTMLText's bounds (`HTMLText.updateBounds` →
 * `measureHtmlText`: its markup appended to the page for one synchronous
 * layout) on the first read after the node's view changed — and a change
 * of the text's `resolution` is such a change, though the measurement is in
 * CSS pixels and does not depend on it. After a zoom, the first reader of
 * every text's size — the realignment check that follows each re-raster
 * (textRenderer `realignIfMeasureMoved`), the selection overlay, hit
 * testing — would measure it again for the same numbers: ~0.2 ms a text
 * on a crowded slide, 200 texts a zoom. (Each raster measures on its own as
 * well, inside Pixi's raster: the 185 ms of `measureHtmlText` in a zoom's
 * profile, 2026-10-18, untouched by this.)
 *
 * What a measurement depends on: the markup (`text`), the style's CSS
 * (`cssStyle` — padding, shadow and every typographic field are in it), the
 * anchor (the bounds are placed by it), and the faces the page has. The
 * first three are compared per node; the faces are a generation that
 * `invalidateHtmlTextMeasurements()` bumps — when webfonts finish loading
 * (`loadingdone`) and when a face is installed or removed
 * (textRenderer `forgetFontMetrics`, from SceneGraph's font refresh). A
 * measurement taken while a face was still loading is therefore never
 * reused past its arrival.
 *
 * Installed on the prototype after the measurement counter
 * (htmlTextMeasureCounter.ts), so `text.measure.bounds` counts the
 * measurements actually made. Pixi's method runs unchanged on every miss.
 */

import { HTMLText } from 'pixi.js'

const INSTALLED = Symbol.for('narrative.htmlTextBoundsMemo')
const MEMO = Symbol('narrative.htmlTextBoundsMemo.entry')

interface Entry {
  generation: number
  text: string
  css: string
  anchorX: number
  anchorY: number
  minX: number
  maxX: number
  minY: number
  maxY: number
}

/** The part of Pixi's HTMLText the memo reads (internal fields in its typings). */
interface MeasuredText {
  [MEMO]?: Entry
  text: string
  _style: { cssStyle: string }
  _anchor: { _x: number; _y: number }
  _bounds: { minX: number; maxX: number; minY: number; maxY: number }
}

let generation = 0

/** Every measurement taken so far is void (the page's faces changed). */
export function invalidateHtmlTextMeasurements(): void {
  generation++
}

if (typeof document !== 'undefined' && typeof document.fonts?.addEventListener === 'function') {
  document.fonts.addEventListener('loadingdone', invalidateHtmlTextMeasurements)
}

/** Install on `target` (HTMLText's prototype; the unit test hands in a stand-in). */
export function installHtmlTextBoundsMemo(target: object = HTMLText.prototype): void {
  const proto = target as Record<PropertyKey, unknown>
  if (proto[INSTALLED] === true) return
  const original = proto['updateBounds']
  // Unit suites mock pixi.js with a bare HTMLText; there is nothing to wrap.
  if (typeof original !== 'function') return
  proto['updateBounds'] = function memoisedUpdateBounds(this: MeasuredText): void {
    const memo = this[MEMO]
    const css = this._style.cssStyle
    const anchor = this._anchor
    const bounds = this._bounds
    if (
      memo !== undefined &&
      memo.generation === generation &&
      memo.text === this.text &&
      memo.css === css &&
      memo.anchorX === anchor._x &&
      memo.anchorY === anchor._y
    ) {
      bounds.minX = memo.minX
      bounds.maxX = memo.maxX
      bounds.minY = memo.minY
      bounds.maxY = memo.maxY
      return
    }
    ;(original as (this: MeasuredText) => void).call(this)
    this[MEMO] = {
      generation,
      text: this.text,
      css,
      anchorX: anchor._x,
      anchorY: anchor._y,
      minX: bounds.minX,
      maxX: bounds.maxX,
      minY: bounds.minY,
      maxY: bounds.maxY,
    }
  }
  proto[INSTALLED] = true
}

installHtmlTextBoundsMemo()
