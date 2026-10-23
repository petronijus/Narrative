/**
 * renderer/fontChanges.ts — the fonts HTMLText can draw with, and the
 * announcements that make every canvas redraw its text when they change.
 *
 * HTMLText draws text inside an SVG image, which sees no page fonts — only
 * the `@font-face` rules Pixi puts into that SVG: for each name in
 * `style.fontFamily` that its asset Cache knows (`<name>-and-url`), the CSS
 * in its `FontStylePromiseCache` under that name (`getFontCss`). So:
 *
 *   - **Faces.** The folder and deck fonts and the bundled Inter register
 *     their faces here with the bytes already downloaded (`setHtmlTextFace`);
 *     the CSS is built from those bytes as `data:` URLs and handed to Pixi
 *     directly. Pixi never downloads a face itself — it would use the
 *     presigned URL from when the font was listed, dead an hour later.
 *   - **Only the faces a text uses** (docs/plans/performance.md → E2). Pixi
 *     embeds what it is given into every raster's SVG, base64 and then
 *     URI-encoded, and the browser parses and decodes it per raster: a
 *     family's four 240 kB faces were ~1 MB per text, ~26 ms per raster in
 *     Chromium against ~8 ms for the one face it drew with. So the names in
 *     `style.fontFamily` are not families but keys (`htmlTextFontKeys`):
 *     one per family a text uses, standing for the faces of that family its
 *     weights and slopes match (renderer/fontFaceMatch.ts — the browser's own
 *     algorithm, so the embedded subset holds the face it would have picked
 *     from the whole family, and it picks the same one). The rules behind a
 *     key still declare the real family name: the text's CSS (its quoted
 *     `font-family` stack, `cssOverrides` in the text renderer) and every
 *     fallback stay as they were. A family with no registered face gets no
 *     key: Pixi then embeds nothing, and in WebKit skips its fixed 100 ms
 *     wait before the raster (`isSafari() && families.length > 0`, W1).
 *   - **Announcements.** Text rasterised before its face landed keeps the
 *     fallback glyphs until it is rasterised again, so a change of a family's
 *     faces is announced and every SceneGraph redraws its text in that
 *     family (SceneGraph.refreshTextNodesUsingFamily, which also gives the
 *     text the keys of the faces there are now) — wherever the canvas sits
 *     in the React tree and whenever it was created. (The font loader sits
 *     above the canvas and never saw it through context: on any page where
 *     text painted before the folder fonts finished — the render page every
 *     time — it stayed in the fallback face.) Announcements made together
 *     are delivered once per family, as tracked render work, so the render
 *     page's settle loop waits for the redraw.
 *   - **Names.** A family name reaches the SVG inside the `@font-face`
 *     rules, set through innerHTML, so only names made of letters, digits,
 *     spaces, hyphens and underscores are registered
 *     (`isEmbeddableFamilyName`); any other name — a quote, a brace,
 *     `</style>` — paints in the fallback face instead of breaking out of the
 *     CSS or the markup. Keys are `nrf-<n>`.
 *
 * This module does not import Pixi (docs/plans/performance.md → L1): the
 * folder pages and the app's boot register fonts here, and a static Pixi
 * import put the whole renderer on every route, login included. What Pixi is
 * told goes through a sink, `./pixiFontSink.ts`, which the text renderer
 * installs before any HTMLText exists; it is handed every key published so
 * far when it is installed.
 */

import { quoteCssFamilyName } from '@narrative/slide-model'
import { matchFaces, type FaceRequest, type FaceSlope } from './fontFaceMatch.js'
import { trackRenderWork } from './renderWork.js'

/**
 * Where HTMLText's font state lives (Pixi's asset `Cache` and its
 * `FontStylePromiseCache`), as the registry below needs to write it.
 */
export interface HtmlTextFontSink {
  /** Make `key` a name Pixi embeds, with these `@font-face` rules. */
  setCss(key: string, css: string): void
  /** Forget `key`: Pixi embeds nothing for it. */
  dropCss(key: string): void
}

let sink: HtmlTextFontSink | null = null

type Listener = (family: string) => void

const listeners = new Set<Listener>()
const pending = new Set<string>()
let flushScheduled = false

interface Face {
  key: string
  family: string
  weight: string
  style: FaceSlope
  /** `font-stretch` of the rule: a width or a variable range (A4.2c). */
  stretch: string
  dataUrl: string
  /** The font file as registered (the canvas text workers get a copy each, ADR 0018). */
  bytes: ArrayBuffer
}

/** Registered faces by key (the font asset id). */
const faces = new Map<string, Face>()
/** Who hears of every face (`subscribeHtmlTextFaces`). */
const faceFeeds = new Set<HtmlTextFaceFeed>()
/** The same faces by family, in registration order. */
const facesByFamily = new Map<string, Map<string, Face>>()

/** A key Pixi embeds: some faces of one family. */
interface FaceSet {
  key: string
  family: string
  faceKeys: readonly string[]
  /** The CSS last handed to the sink ('' = none). */
  css: string
}

/** Published keys by `family + faces` signature. */
const faceSets = new Map<string, FaceSet>()
let nextFaceSet = 0

const EMBEDDABLE_FAMILY = /^[A-Za-z0-9_-]+(?: [A-Za-z0-9_-]+)*$/

/** Can `name` be embedded (written into the SVG's CSS from a registered face)? */
export function isEmbeddableFamilyName(name: string): boolean {
  return name.length <= 200 && EMBEDDABLE_FAMILY.test(name)
}

function flush(): void {
  flushScheduled = false
  const families = [...pending]
  pending.clear()
  for (const family of families) {
    versions.set(family, (versions.get(family) ?? 0) + 1)
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

/** How many times each family's faces changed (absent: never) — part of a thumbnail's key. */
const versions = new Map<string, number>()

/** The version of every family announced so far (renderer/thumbnailKey.ts). */
export function fontFamilyVersions(): ReadonlyMap<string, number> {
  return versions
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

/** The `@font-face` rules of these faces (registered ones; the rest are gone). */
function facesCss(set: FaceSet): string {
  const quoted = quoteCssFamilyName(set.family)
  const out: string[] = []
  for (const key of set.faceKeys) {
    const face = faces.get(key)
    if (face === undefined || face.family !== set.family) continue
    out.push(
      `@font-face { font-family: ${quoted}; font-weight: ${face.weight}; ` +
        `font-style: ${face.style}; font-stretch: ${face.stretch}; src: url('${face.dataUrl}'); }`,
    )
  }
  return out.join('\n')
}

/** Hand Pixi the key's CSS as the faces are now (or forget the key with none left). */
function publishFaceSet(set: FaceSet): void {
  const css = facesCss(set)
  if (css === set.css) return
  set.css = css
  if (sink === null) return
  if (css === '') sink.dropCss(set.key)
  else sink.setCss(set.key, css)
}

/** Every key of `family` again: one of its faces was added, replaced or removed. */
function republishFamily(family: string): void {
  for (const set of faceSets.values()) if (set.family === family) publishFaceSet(set)
}

/**
 * What a text draws with (renderer/objectRenderers/textRenderer.ts →
 * `htmlTextFaceRequest`): the families its CSS names — the box's stack, each
 * run's and each list level's — and every weight, slope and width an element
 * of it asks for. A superset is safe (a face more is embedded); a request
 * left out is not (its face would be missing from the SVG).
 */
export interface HtmlTextFaceRequest {
  families: readonly string[]
  weights: readonly number[]
  styles: readonly FaceRequest['style'][]
  /** Percent. */
  stretch: number
}

/**
 * The names to give Pixi as `style.fontFamily` for `request`: per family
 * with registered faces, one key for the faces the request's weights and
 * slopes match (each face embedded once). Families with none get no key.
 * The same request gets the same keys while the faces stay; a face added or
 * removed can change them (`announceFontFamilyChanged` follows, and the
 * canvases ask again).
 */
export function htmlTextFontKeys(request: HtmlTextFaceRequest): string[] {
  const keys: string[] = []
  for (const family of request.families) {
    const own = facesByFamily.get(family)
    if (own === undefined || own.size === 0) continue
    const candidates = [...own.values()]
    const chosen = new Set<string>()
    for (const weight of request.weights) {
      for (const style of request.styles) {
        for (const face of matchFaces(candidates, { weight, style, stretch: request.stretch })) {
          chosen.add(face.key)
        }
      }
    }
    if (chosen.size === 0) continue
    // Registration order, so the same faces always make the same rules.
    const faceKeys = candidates.filter((f) => chosen.has(f.key)).map((f) => f.key)
    const signature = `${family}\u0000${faceKeys.join('\u0000')}`
    let set = faceSets.get(signature)
    if (set === undefined) {
      set = { key: `nrf-${++nextFaceSet}`, family, faceKeys, css: '' }
      faceSets.set(signature, set)
      publishFaceSet(set)
    }
    if (!keys.includes(set.key)) keys.push(set.key)
  }
  return keys
}

/** Does `family` have a registered face (would a text in it embed anything)? */
export function hasHtmlTextFaces(family: string): boolean {
  return (facesByFamily.get(family)?.size ?? 0) > 0
}

/**
 * Install where Pixi's font state lives (`./pixiFontSink.ts`, once, before any
 * HTMLText): every key published before is handed to it now.
 */
export function installHtmlTextFontSink(next: HtmlTextFontSink): void {
  sink = next
  for (const set of faceSets.values()) if (set.css !== '') next.setCss(set.key, set.css)
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

function forgetFace(face: Face): void {
  const own = facesByFamily.get(face.family)
  own?.delete(face.key)
  if (own !== undefined && own.size === 0) facesByFamily.delete(face.family)
}

/**
 * Register (or replace) a face HTMLText may draw with: `bytes` is the font
 * file the loader downloaded. A name that cannot be embedded safely
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
  const next: Face = {
    key: face.key,
    family: face.family,
    weight: WEIGHT.test(face.weight) ? face.weight : '400',
    style: STYLE.test(face.style) ? (face.style as FaceSlope) : 'normal',
    stretch: face.stretch !== undefined && STRETCH.test(face.stretch) ? face.stretch : '100%',
    dataUrl: `data:${fontMime(view)};base64,${base64(view)}`,
    bytes: face.bytes,
  }
  if (previous !== undefined) forgetFace(previous)
  faces.set(face.key, next)
  let own = facesByFamily.get(next.family)
  if (own === undefined) {
    own = new Map()
    facesByFamily.set(next.family, own)
  }
  own.set(next.key, next)
  for (const feed of [...faceFeeds]) feed.added(registeredFace(next))
  if (previous !== undefined && previous.family !== face.family) {
    republishFamily(previous.family)
    announceFontFamilyChanged(previous.family)
  }
  republishFamily(face.family)
  announceFontFamilyChanged(face.family)
}

/** Forget a face registered with `setHtmlTextFace`. */
export function removeHtmlTextFace(key: string): void {
  const face = faces.get(key)
  if (face === undefined) return
  faces.delete(key)
  forgetFace(face)
  for (const feed of [...faceFeeds]) feed.removed(key)
  republishFamily(face.family)
  announceFontFamilyChanged(face.family)
}

/** A registered face as the canvas text workers get it (renderer/runText, ADR 0018). */
export interface RegisteredFace {
  key: string
  family: string
  weight: string
  style: string
  stretch: string
  /** The font file; not to be transferred or modified (copy it). */
  bytes: ArrayBuffer
}

/** Hears every face registered or removed (`subscribeHtmlTextFaces`). */
export interface HtmlTextFaceFeed {
  /** A face was registered, or one under the same key replaced. */
  added(face: RegisteredFace): void
  /** The face under `key` was removed. */
  removed(key: string): void
}

function registeredFace(face: Face): RegisteredFace {
  return {
    key: face.key,
    family: face.family,
    weight: face.weight,
    style: face.style,
    stretch: face.stretch,
    bytes: face.bytes,
  }
}

/**
 * Hear about every face: the ones registered so far at once (in registration
 * order), then each one added, replaced or removed. The canvas text workers
 * keep their `FontFaceSet`s equal to the registry this way (ADR 0018,
 * decision 3). Returns the unsubscribe.
 */
export function subscribeHtmlTextFaces(feed: HtmlTextFaceFeed): () => void {
  faceFeeds.add(feed)
  for (const face of faces.values()) feed.added(registeredFace(face))
  return () => {
    faceFeeds.delete(feed)
  }
}

/** The family names that have a registered face. */
export function registeredFaceFamilies(): string[] {
  return [...facesByFamily.keys()]
}

/**
 * A filter for `document.fonts`' `loadingdone` events: true when the event
 * brought a face whose descriptors (family, weight, style, stretch, range)
 * had not loaded before — the only kind of load that can change how text
 * lays out.
 *
 * Pixi's HTMLText measures and rasterises with the family's `@font-face`
 * CSS put into the document, so every measurement of text in an embedded
 * family (the bundled Inter, every folder font) adds `FontFace` objects of
 * its own that load at once and end in `loadingdone` — the same faces
 * again. Treating each as news re-laid every autofit box out, which
 * measured and rasterised again, which loaded the faces again: the render
 * page never settled on a slide with an autofit box (2026-10-13).
 */
export function createFontLoadFilter(): (faces: Iterable<FontFace>) => boolean {
  const seen = new Set<string>()
  return (faces) => {
    let fresh = false
    for (const face of faces) {
      if (face.status !== 'loaded') continue
      const key = [face.family, face.weight, face.style, face.stretch, face.unicodeRange].join('|')
      if (seen.has(key)) continue
      seen.add(key)
      fresh = true
    }
    return fresh
  }
}

/** Test helper. */
export function _resetFontChangesForTests(): void {
  for (const set of faceSets.values()) if (set.css !== '') sink?.dropCss(set.key)
  faceSets.clear()
  nextFaceSet = 0
  faces.clear()
  facesByFamily.clear()
  pending.clear()
  flushScheduled = false
  listeners.clear()
}
