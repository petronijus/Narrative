/**
 * slide-model/src/richText.ts
 *
 * Pure helpers for the Y.Text-backed rich-text body of TextObject.
 *
 * Responsibilities:
 * - Build a fresh Y.Text seeded with an initial string.
 * - Apply / clear inline format attributes on a range.
 * - Convert a Y.Text into a Quill-style delta (the canonical wire
 *   format for inline formatting).
 * - Convert a delta into an HTML string for Pixi.HTMLText.
 *
 * Constraints:
 * - No DOM, no Pixi, no React imports.
 * - Box-wide defaults (italic / underline / fontWeight / color) layer
 *   underneath per-run attributes: a run with `italic: true` is italic
 *   even when the default is upright; a run with `italic: false`
 *   suppresses an italic default.
 */

import * as Y from 'yjs'

export interface RichAttrs {
  italic?: boolean
  underline?: boolean
  fontWeight?: number
  color?: number
  fontFamily?: string
  fontSize?: number
}

export interface RichDeltaOp {
  insert: string
  attributes?: RichAttrs
}

export interface HtmlDefaults {
  italic?: boolean
  underline?: boolean
  fontWeight?: number
  color?: number
}

/** Allocate a fresh Y.Text containing `initial`. */
export function createTextValue(initial: string): Y.Text {
  const yt = new Y.Text()
  if (initial.length > 0) yt.insert(0, initial)
  return yt
}

/** Convenience reader for the plain-text content. */
export function getPlainString(yt: Y.Text): string {
  return yt.toString()
}

/**
 * Returns the formatting attributes of the run that contains `index` — used
 * to inherit the run's format when inserting at that position (so typing
 * inside a bold word stays bold). Returns an empty object when the insertion
 * lands in an unformatted run, or before the first run.
 */
export function richAttrsAtIndex(yt: Y.Text, index: number): Record<string, unknown> {
  const delta = yt.toDelta() as Array<{ insert: unknown; attributes?: Record<string, unknown> }>
  let pos = 0
  for (const op of delta) {
    const insert = typeof op.insert === 'string' ? op.insert : ''
    const next = pos + insert.length
    if (index <= next) {
      return { ...(op.attributes ?? {}) }
    }
    pos = next
  }
  return {}
}

/** Apply (or override) the given attributes on the range [start, start+length). */
export function applyFormat(yt: Y.Text, start: number, length: number, attrs: RichAttrs): void {
  if (length <= 0) return
  yt.format(start, length, attrs as Record<string, unknown>)
}

/** Drop the named attribute keys from the range, restoring box-wide defaults. */
export function clearFormat(
  yt: Y.Text,
  start: number,
  length: number,
  keys: ReadonlyArray<keyof RichAttrs>,
): void {
  if (length <= 0) return
  const erase: Record<string, null> = {}
  for (const k of keys) erase[k] = null
  yt.format(start, length, erase as Record<string, unknown>)
}

/**
 * Project a Y.Text to the subset of Quill delta we render — only
 * string inserts (we never insert embeds) and only the attributes we
 * care about. Foreign attributes are dropped silently so an experimental
 * Yjs format from another client can't break rendering.
 */
export function toDelta(yt: Y.Text): RichDeltaOp[] {
  const raw = yt.toDelta() as Array<{ insert: unknown; attributes?: Record<string, unknown> }>
  const out: RichDeltaOp[] = []
  for (const op of raw) {
    if (typeof op.insert !== 'string') continue
    const e: RichDeltaOp = { insert: op.insert }
    if (op.attributes !== undefined) {
      const a: RichAttrs = {}
      if (op.attributes['italic'] === true) a.italic = true
      else if (op.attributes['italic'] === false) a.italic = false
      if (op.attributes['underline'] === true) a.underline = true
      else if (op.attributes['underline'] === false) a.underline = false
      if (typeof op.attributes['fontWeight'] === 'number') {
        a.fontWeight = op.attributes['fontWeight']
      }
      if (typeof op.attributes['color'] === 'number') a.color = op.attributes['color']
      if (typeof op.attributes['fontFamily'] === 'string' && op.attributes['fontFamily'] !== '') {
        a.fontFamily = op.attributes['fontFamily']
      }
      if (typeof op.attributes['fontSize'] === 'number' && op.attributes['fontSize'] > 0) {
        a.fontSize = op.attributes['fontSize']
      }
      if (Object.keys(a).length > 0) e.attributes = a
    }
    out.push(e)
  }
  return out
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function colorHex(n: number): string {
  // Clamp to a valid 24-bit RGB int so the result is ALWAYS exactly 6 hex
  // digits. Without this, a negative int (`-1` → "-1" → "#0000-1") or an
  // out-of-range int (`0x1000000` → "1000000" → "#1000000") produces invalid
  // CSS that breaks the whole style attribute. NaN/non-finite → black.
  const clamped = Number.isFinite(n) ? Math.max(0, Math.min(0xffffff, Math.trunc(n))) : 0
  return '#' + clamped.toString(16).padStart(6, '0')
}

// ---------------------------------------------------------------------------
// Style-value sanitisation
// ---------------------------------------------------------------------------
// toHtml output lands in two innerHTML sinks (the TextEditOverlay preview
// and Pixi HTMLText's SVG <foreignObject>), so any string interpolated
// into the style="" attribute must not be able to close the attribute or
// open a new CSS declaration. Numeric attributes (fontWeight / color /
// fontSize) are formatted by us and are inert; fontFamily is the only
// user-controlled string (settable by any collaborator via
// Y.Text.format() and by PPTX import) and must pass the allowlist below.

/**
 * Characters allowed in a font-family value. Deliberately tight: letters,
 * digits, space, underscore, comma (stack separator), apostrophe, hyphen.
 * Everything else — `"`, `;`, `<`, `>`, `\`, `(`, `)`, `{`, `}`, `:`,
 * `&`, … — is stripped so the value can't terminate the style attribute,
 * smuggle markup, or inject extra CSS declarations.
 */
const FONT_FAMILY_DISALLOWED = /[^A-Za-z0-9 _,'-]/g

/**
 * Sanitise a user-controlled font-family value by stripping every
 * character outside the allowlist. Returns undefined when nothing
 * survives. Exported for reuse at other trust boundaries (PPTX import
 * sanitises `<p:font typeface>` through this same allowlist).
 */
export function sanitizeFontFamily(raw: string): string | undefined {
  const cleaned = raw.replace(FONT_FAMILY_DISALLOWED, '').trim()
  return cleaned === '' ? undefined : cleaned
}

/**
 * Render a delta into an HTML string suitable for Pixi.HTMLText.
 *
 * Per-run attributes override the box-wide defaults; an explicit
 * `false` on a run suppresses an inherited `true`.
 */
export function toHtml(delta: RichDeltaOp[], defaults: HtmlDefaults): string {
  const parts: string[] = []
  for (const op of delta) {
    const a = op.attributes ?? {}
    const italic = a.italic ?? defaults.italic ?? false
    const underline = a.underline ?? defaults.underline ?? false
    const weight = a.fontWeight ?? defaults.fontWeight
    const color = a.color ?? defaults.color
    const styleBits: string[] = []
    if (typeof weight === 'number' && weight !== 400) styleBits.push(`font-weight:${weight}`)
    if (typeof color === 'number') styleBits.push(`color:${colorHex(color)}`)
    if (typeof a.fontFamily === 'string' && a.fontFamily !== '') {
      // Emit the sanitised value UNQUOTED — it goes inside a double-quoted
      // style="" attribute, and the allowlist guarantees no `"` (which
      // would break the attribute) and no `;`/`<`/`>` (which would inject
      // CSS or markup). Quoting it would put `"` back into a `"`-delimited
      // attribute and break multi-word families.
      const family = sanitizeFontFamily(a.fontFamily)
      if (family !== undefined) styleBits.push(`font-family:${family}`)
    }
    if (typeof a.fontSize === 'number' && a.fontSize > 0) {
      styleBits.push(`font-size:${a.fontSize}px`)
    }
    // Two break flavors land here:
    //   '\n'      soft line break (PPTX <a:br>, Shift-Enter in the
    //             editor) - renders as plain <br>. Inside a bulleted
    //             list this is a continuation line under the bullet,
    //             NOT a new bullet.
    //   '\u2029'  PARAGRAPH SEPARATOR (PPTX <a:p> boundary) - emits
    //             a <br data-pb="1"> sentinel that the renderer's
    //             prependListMarkersHtml uses to split bullet
    //             segments. Browsers render it as a plain line
    //             break (data attrs are inert).
    let body = escapeHtml(op.insert)
      .replace(/\u2029/g, '<br data-pb="1">')
      .replace(/\n/g, '<br>')
    if (italic) body = `<i>${body}</i>`
    if (underline) body = `<u>${body}</u>`
    if (styleBits.length > 0) body = `<span style="${styleBits.join(';')}">${body}</span>`
    parts.push(body)
  }
  return parts.join('')
}
