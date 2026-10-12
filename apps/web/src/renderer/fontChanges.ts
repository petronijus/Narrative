/**
 * renderer/fontChanges.ts — the fonts HTMLText can draw with, and the
 * announcements that make every canvas redraw its text when they change.
 *
 * HTMLText draws text inside an SVG image, which sees no page fonts — only
 * the `@font-face` rules Pixi puts into that SVG, taken from its
 * `FontStylePromiseCache` (one CSS string per family, `getFontCss`) for the
 * names in `style.fontFamily`. So:
 *
 *   - **Faces.** The folder and deck fonts register their faces here with
 *     the bytes the loader already downloaded (`setHtmlTextFace`); the
 *     family's CSS is built from those bytes as `data:` URLs and handed to
 *     Pixi directly. Pixi never downloads a face itself — it would use the
 *     presigned URL from when the font was listed, dead an hour later — and
 *     never builds a family's CSS from only the faces that had loaded when
 *     its first text asked. (The bundled Inter keeps Pixi's own path: its
 *     URLs are the app's static files.)
 *   - **Announcements.** Text rasterised before its face landed keeps the
 *     fallback glyphs until it is rasterised again, so a change of a family's
 *     faces is announced and every SceneGraph redraws its text in that
 *     family (SceneGraph.refreshTextNodesUsingFamily) — wherever the canvas
 *     sits in the React tree and whenever it was created. (The font loader
 *     sits above the canvas and never saw it through context: on any page
 *     where text painted before the folder fonts finished — the render page
 *     every time — it stayed in the fallback face, invisible on a machine
 *     with the font installed, wrong everywhere else.) Announcements made
 *     together are delivered once per family, as tracked render work, so the
 *     render page's settle loop waits for the redraw.
 *   - **Names.** A family name reaches Pixi's SVG unescaped (its
 *     `font-family: A,B` rule, inside a `<style>` set through innerHTML), so
 *     only names made of letters, digits, spaces, hyphens and underscores
 *     are given to it (`isEmbeddableFamilyName`); any other name — a quote,
 *     a brace, `</style>` — paints in the fallback face instead of breaking
 *     out of the CSS or the markup.
 */

import { Cache, FontStylePromiseCache } from 'pixi.js'
import { quoteCssFamilyName } from '@narrative/slide-model'
import { trackRenderWork } from './renderWork.js'

type Listener = (family: string) => void

const listeners = new Set<Listener>()
const pending = new Set<string>()
let flushScheduled = false

interface Face {
  family: string
  weight: string
  style: string
  /** `font-stretch` of the rule: a width or a variable range (A4.2c). */
  stretch: string
  dataUrl: string
}

/** Registered faces by key (the font asset id). */
const faces = new Map<string, Face>()

const EMBEDDABLE_FAMILY = /^[A-Za-z0-9_-]+(?: [A-Za-z0-9_-]+)*$/

/** Can `name` be handed to Pixi as a family (a cache key it writes into its SVG unescaped)? */
export function isEmbeddableFamilyName(name: string): boolean {
  return name.length <= 200 && EMBEDDABLE_FAMILY.test(name)
}

function flush(): void {
  flushScheduled = false
  const families = [...pending]
  pending.clear()
  for (const family of families) {
    // A family Pixi builds the CSS for itself (from its asset Cache: the
    // bundled Inter) is rebuilt on the next raster with the faces it has now.
    if (![...faces.values()].some((face) => face.family === family)) {
      FontStylePromiseCache.delete(family)
    }
    for (const listener of [...listeners]) listener(family)
  }
}

/** Tell every canvas that `family`'s faces changed (delivered together with others made at once). */
export function announceFontFamilyChanged(family: string): void {
  if (family === '') return
  pending.add(family)
  if (flushScheduled) return
  flushScheduled = true
  // Tracked: the render page does not call a slide settled before the
  // canvases have redrawn (and the rasters that starts are waited for too).
  void trackRenderWork(
    new Promise<void>((resolve) => {
      setTimeout(() => {
        flush()
        resolve()
      }, 0)
    }),
  )
}

/** Listen for font family changes; returns the unsubscribe. */
export function subscribeFontFamilyChanges(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const WEIGHT = /^\d{1,3}(?: \d{1,3})?$/
const STYLE = /^(?:normal|italic|oblique)$/
/** One width or a variable face's range (A4.2c): `100%`, `75% 125%`. */
const STRETCH = /^\d{1,3}(?:\.\d+)?%(?: \d{1,3}(?:\.\d+)?%)?$/

/** The `@font-face` rules for every registered face of `family`, as Pixi embeds them. */
function familyCss(family: string): string {
  const quoted = quoteCssFamilyName(family)
  return [...faces.values()]
    .filter((face) => face.family === family)
    .map(
      (face) =>
        `@font-face { font-family: ${quoted}; font-weight: ${face.weight}; ` +
        `font-style: ${face.style}; font-stretch: ${face.stretch}; src: url('${face.dataUrl}'); }`,
    )
    .join('\n')
}

/** Point Pixi at the family's faces as registered here (or forget it with none left). */
function publishFamily(family: string): void {
  const key = `${family}-and-url`
  const css = familyCss(family)
  if (css === '') {
    FontStylePromiseCache.delete(family)
    if (Cache.has(key)) Cache.remove(key)
    return
  }
  // Pixi embeds a family only if its asset Cache has this key; the CSS it
  // embeds is the promise below, so the entry lists no URLs to download.
  if (!Cache.has(key)) Cache.set(key, { entries: [] })
  FontStylePromiseCache.set(family, Promise.resolve(css))
}

function fontMime(bytes: Uint8Array): string {
  const tag = String.fromCharCode(...bytes.subarray(0, 4))
  if (tag === 'wOF2') return 'font/woff2'
  if (tag === 'wOFF') return 'font/woff'
  if (tag === 'OTTO') return 'font/otf'
  return 'font/ttf'
}

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

/**
 * Register (or replace) a face HTMLText may draw with: `bytes` is the font
 * file the loader downloaded. A name Pixi cannot be given safely
 * (`isEmbeddableFamilyName`) is not registered: its text paints in the
 * fallback face.
 */
export function setHtmlTextFace(face: {
  key: string
  family: string
  /** A weight, or a variable face's range ("100 900"). */
  weight: string
  style: string
  /** A width, or a variable face's range ("75% 125%"); absent = normal. */
  stretch?: string
  bytes: ArrayBuffer
}): void {
  if (!isEmbeddableFamilyName(face.family)) return
  const previous = faces.get(face.key)
  const view = new Uint8Array(face.bytes)
  faces.set(face.key, {
    family: face.family,
    weight: WEIGHT.test(face.weight) ? face.weight : '400',
    style: STYLE.test(face.style) ? face.style : 'normal',
    stretch: face.stretch !== undefined && STRETCH.test(face.stretch) ? face.stretch : '100%',
    dataUrl: `data:${fontMime(view)};base64,${base64(view)}`,
  })
  if (previous !== undefined && previous.family !== face.family) {
    publishFamily(previous.family)
    announceFontFamilyChanged(previous.family)
  }
  publishFamily(face.family)
  announceFontFamilyChanged(face.family)
}

/** Forget a face registered with `setHtmlTextFace`. */
export function removeHtmlTextFace(key: string): void {
  const face = faces.get(key)
  if (face === undefined) return
  faces.delete(key)
  publishFamily(face.family)
  announceFontFamilyChanged(face.family)
}

/** Test helper. */
export function _resetFontChangesForTests(): void {
  for (const family of new Set([...faces.values()].map((f) => f.family))) {
    FontStylePromiseCache.delete(family)
    if (Cache.has(`${family}-and-url`)) Cache.remove(`${family}-and-url`)
  }
  faces.clear()
  pending.clear()
  flushScheduled = false
  listeners.clear()
}
