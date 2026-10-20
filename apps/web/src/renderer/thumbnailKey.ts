/**
 * renderer/thumbnailKey.ts — what a slide's thumbnail depends on, as one
 * string: two slides (or one slide at two moments) with the same key draw
 * the same picture, so a thumbnail is rendered only when its key is new
 * (renderer/thumbnailStore.ts).
 *
 * The inputs of a thumbnail render (renderer/thumbnails.ts) are:
 *
 *   - the slide's objects, its background and its surface (its layout's,
 *     A4.2d) — the document;
 *   - the slide's number, but only for a slide that shows it (a text leaf
 *     flagged `isSlideNumber`): every other slide draws the same picture
 *     wherever it sits, so a reorder or an added slide changes no key of
 *     theirs (performance.md → B2: a reorder re-rendered all ~100);
 *   - the colours its token references resolve to (renderer/colourResolver.ts)
 *     — the folder's tokens arrive after the first renders and can be edited;
 *   - the faces of the font families its text names (renderer/fontChanges.ts):
 *     a text rasterised before its face landed shows the fallback glyphs.
 *
 * Text bodies are `Y.Text` references in the plain objects (yMapToPlainObject
 * keeps them for collaborative typing); `JSON.stringify` would turn them into
 * their plain string through `toJSON` and lose every run's formatting, so the
 * serialiser reads the raw value and writes its delta. A key need not be
 * canonical (two orders of the same fields may give two keys — one render
 * too many), but it must never miss an input: two different pictures under
 * one key would show a wrong thumbnail.
 */

import * as Y from 'yjs'
import type { SlideBackground, SlideObject } from '@narrative/shared'

/** What a thumbnail is rendered from (the document side). */
export interface ThumbnailInputs {
  objects: readonly SlideObject[]
  background: SlideBackground | undefined
  /** The slide's surface (its layout's): its colour tokens resolve on it. */
  surface: string | undefined
  /** The slide's number in the deck (skipped slides not counted). */
  slideNumber: number | undefined
}

/** The page-wide inputs of a key: colour tokens and font faces. */
export interface ThumbnailEnvironment {
  /**
   * The resolved colours of every token reference in `value`, on `surface`,
   * as one string ('' when there are none).
   */
  tokenColours(value: unknown, surface: string | undefined): string
  /**
   * A version per font family whose faces changed since the page loaded (a
   * family absent here has had no announcement: version 0).
   */
  fontVersions(): ReadonlyMap<string, number>
}

/** The document part of the key: the inputs serialised (Y types read as their content). */
export function serialiseThumbnailInputs(
  inputs: Pick<ThumbnailInputs, 'objects' | 'background' | 'surface'>,
): string {
  return JSON.stringify(
    [inputs.objects, inputs.background ?? null, inputs.surface ?? null],
    function replacer(this: unknown, key: string, value: unknown): unknown {
      // The holder's raw value: `value` has been through toJSON already.
      const raw = (this as Record<string, unknown> | null)?.[key]
      if (raw instanceof Y.AbstractType) return yValue(raw)
      return value
    },
  )
}

function yValue(value: Y.AbstractType<unknown>): unknown {
  if (value instanceof Y.Text) return { $ytext: value.toDelta() as unknown }
  if (value instanceof Y.Map) return Object.fromEntries(value.entries())
  if (value instanceof Y.Array) return value.toArray()
  if (value instanceof Y.XmlFragment) return { $yxml: value.toString() }
  // Any other shared type: its JSON (no Y type of the slide model lands here).
  return value.toJSON()
}

const SLIDE_NUMBER_FLAG = '"isSlideNumber":true'

/** Does a slide serialised by serialiseThumbnailInputs show its own number? */
export function showsSlideNumber(serialised: string): boolean {
  return serialised.includes(SLIDE_NUMBER_FLAG)
}

/**
 * The font families of `fontVersions` named in the serialised slide, with
 * their versions ('' when none is). A name that only appears inside a text's
 * words costs one render too many, never a stale one. Also how present mode
 * tells a slide prepared before a face of its families arrived
 * (renderer/presentSlides.ts).
 */
export function fontSignature(serialised: string, versions: ReadonlyMap<string, number>): string {
  let out = ''
  for (const [family, version] of versions) {
    if (serialised.includes(family)) out += `|${family}:${version}`
  }
  return out
}

/**
 * A 64-bit hash of `text` (two independent 32-bit lanes, cyrb53's mixing)
 * and its length, in base 36 — compact enough to keep per slide and per
 * cached picture without holding the serialised slide.
 */
export function hashText(text: string): string {
  let h1 = 0xdeadbeef ^ text.length
  let h2 = 0x41c6ce57 ^ text.length
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return `${text.length.toString(36)}.${(h1 >>> 0).toString(36)}.${(h2 >>> 0).toString(36)}`
}

/** The key of a slide's thumbnail: equal keys, equal pictures. */
export function thumbnailKey(inputs: ThumbnailInputs, env: ThumbnailEnvironment): string {
  return thumbnailKeyOf(serialiseThumbnailInputs(inputs), inputs, env)
}

/** thumbnailKey with the inputs already serialised (serialiseThumbnailInputs). */
export function thumbnailKeyOf(
  serialised: string,
  inputs: ThumbnailInputs,
  env: ThumbnailEnvironment,
): string {
  let key = hashText(serialised)
  if (showsSlideNumber(serialised)) key += `#n${inputs.slideNumber ?? '-'}`
  const colours = env.tokenColours([inputs.objects, inputs.background ?? null], inputs.surface)
  if (colours !== '') key += `#c${hashText(colours)}`
  const fonts = fontSignature(serialised, env.fontVersions())
  if (fonts !== '') key += `#f${hashText(fonts)}`
  return key
}
