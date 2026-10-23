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
 * SHARED BETWEEN NODES (performance.md → E4). Pixi's measurement reads the
 * node's markup and style and nothing else of the node
 * (`measureHtmlText(this.text, this._style)`), so two nodes with the same
 * inputs measure the same. The last {@link SHARED_MEASUREMENTS_LIMIT}
 * measurements are kept by their inputs, and a node that misses its own memo
 * takes one of those before measuring. The case it is for: the editor's
 * autofit (ui/AutofitHeights) lays a person's growing box out on a node of
 * its own in the tick of the keystroke, so the stored height joins the
 * keystroke's undo step; the canvas's node lays the same box out a frame
 * later — the same markup and CSS — and now takes that layout instead of a
 * second synchronous one. The write-back's own re-measure (a changed
 * `height` is not in the CSS) hits as well. A hit gives the very numbers the
 * measurement gave, so the canvas and the stored height cannot disagree.
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

/** How many measurements are shared between nodes (the most recent ones). */
export const SHARED_MEASUREMENTS_LIMIT = 256

/**
 * Measurements by their inputs (anchor, CSS, markup), oldest first; every
 * entry is of the current generation (cleared when it moves on).
 */
const shared = new Map<string, Entry>()

/**
 * The `<!--n:uid-->` comment a node's markup starts with (textRenderer
 * `buildHtmlForNode`: Pixi's texture cache per node). It does not lay out, so
 * it is not part of what is shared — with it in the key, two nodes never
 * shared anything (performance.md → E4; runText/layoutCache.ts keys the same).
 */
const NODE_PREFIX = /^<!--n:\d+-->/u

function sharedKey(text: string, css: string, anchorX: number, anchorY: number): string {
  // The CSS's length keeps the key unambiguous: the markup follows it, whole.
  return `${anchorX}|${anchorY}|${css.length}|${css}|${text.replace(NODE_PREFIX, '')}`
}

function share(key: string, entry: Entry): void {
  shared.delete(key)
  shared.set(key, entry)
  if (shared.size > SHARED_MEASUREMENTS_LIMIT) {
    const oldest = shared.keys().next().value
    if (oldest !== undefined) shared.delete(oldest)
  }
}

/** Every measurement taken so far is void (the page's faces changed). */
export function invalidateHtmlTextMeasurements(): void {
  generation++
  shared.clear()
}

/**
 * The page's face generation: a measurement or layout taken in another one
 * is void (the run-text layout cache keys on it, runText/layoutCache.ts).
 */
export function htmlTextMeasureGeneration(): number {
  return generation
}

/** What a node's size is measured from: its markup and its style. */
export interface MeasurableText {
  text: string
  _style: { cssStyle: string; padding: number }
}

/** Measures a node's content size in CSS px, as Pixi's `measureHtmlText` reports it. */
export type HtmlTextMeasurer = (text: MeasurableText) => { width: number; height: number }

let measurer: HtmlTextMeasurer | null = null

/**
 * Measure every HTMLText with `next` instead of Pixi's `measureHtmlText`
 * (null: Pixi's again). The run-text engine (ADR 0018) measures with the
 * layout its raster is painted from, so a text's bounds and its pixels come
 * from one layout. Set once, before the first text is measured.
 */
export function setHtmlTextMeasurer(next: HtmlTextMeasurer | null): void {
  if (next === measurer) return
  measurer = next
  invalidateHtmlTextMeasurements()
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
    const text = this.text
    const key = sharedKey(text, css, anchor._x, anchor._y)
    const known = shared.get(key)
    if (known !== undefined) {
      bounds.minX = known.minX
      bounds.maxX = known.maxX
      bounds.minY = known.minY
      bounds.maxY = known.maxY
      share(key, known)
      // Its own memo names its own markup (the comment may differ).
      this[MEMO] = known.text === text ? known : { ...known, text }
      return
    }
    if (measurer === null) {
      ;(original as (this: MeasuredText) => void).call(this)
    } else {
      // Pixi's `updateBounds` with the measurement swapped (HTMLText.updateBounds).
      const { width, height } = measurer(this as unknown as MeasurableText)
      bounds.minX = -anchor._x * width
      bounds.maxX = bounds.minX + width
      bounds.minY = -anchor._y * height
      bounds.maxY = bounds.minY + height
    }
    const entry: Entry = {
      generation,
      text,
      css,
      anchorX: anchor._x,
      anchorY: anchor._y,
      minX: bounds.minX,
      maxX: bounds.maxX,
      minY: bounds.minY,
      maxY: bounds.maxY,
    }
    this[MEMO] = entry
    share(key, entry)
  }
  proto[INSTALLED] = true
}

installHtmlTextBoundsMemo()
