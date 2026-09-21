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
import {
  MAX_LIST_LEVEL,
  type ListKind,
  type ListNumberFormat,
  type ParagraphAttrs,
  type ParagraphAttrKey,
  type TextListStyle,
} from '@narrative/shared'

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

// ===========================================================================
// Paragraph + list block model
// ===========================================================================
//
// A TextObject's body is a single flat Y.Text. Two control characters give
// it structure:
//
//   U+2029   PARAGRAPH SEPARATOR — terminates a paragraph (a list item or
//             a plain block). Per-paragraph *block* attributes (list kind,
//             nesting level, bullet glyph, numbering format, start-at) are
//             stored as Quill-style attributes on this character, exactly
//             the way Quill/Lexical hang block formatting off the newline.
//             The attribute travels with the character, so it survives
//             concurrent CRDT edits without any parallel index-keyed map.
//
//   '\n'      SOFT LINE BREAK — a wrapped continuation line *inside* one
//             paragraph (Shift-Enter in the editor, PPTX <a:br>). It does
//             NOT start a new list item.
//
// Invariant (maintained by `applyParagraphPatch`): once any paragraph
// carries block attributes the Y.Text ends with a trailing U+2029 that
// terminates — and stores the attrs of — the final paragraph. Plain decks
// with no list formatting are left without a trailing separator so legacy
// content and the diff-based editor keep behaving exactly as before. Both
// shapes are understood on read.

/** Paragraph separator character. PPTX `<a:p>` boundary. */
export const PARAGRAPH_SEP = '\u2029'

/** All keys a {@link ParagraphAttrs} contributes to the Y.Text run. */
const PARAGRAPH_ATTR_KEYS: readonly ParagraphAttrKey[] = [
  'list',
  'level',
  'bulletChar',
  'numberFormat',
  'startAt',
]

const NUMBER_FORMATS: readonly ListNumberFormat[] = [
  'decimal',
  'decimalParen',
  'lowerAlpha',
  'lowerAlphaParen',
  'upperAlpha',
  'upperAlphaParen',
  'lowerRoman',
  'upperRoman',
]

function isNumberFormat(v: unknown): v is ListNumberFormat {
  return typeof v === 'string' && (NUMBER_FORMATS as readonly string[]).includes(v)
}

/** Default bullet glyph cycle by nesting level (mirrors PowerPoint themes). */
const DEFAULT_BULLET_GLYPHS = ['•', '◦', '▪', '–', '‣'] as const

/** The glyph an un-customised bullet paragraph shows at the given level. */
export function defaultBulletGlyph(level: number): string {
  const l = Math.max(0, Math.floor(level))
  return DEFAULT_BULLET_GLYPHS[l % DEFAULT_BULLET_GLYPHS.length]!
}

/** Read the {@link ParagraphAttrs} subset out of a raw Y.Text run's attributes. */
function readBlockAttrs(a?: Record<string, unknown>): ParagraphAttrs {
  const out: ParagraphAttrs = {}
  if (a === undefined) return out
  if (a['list'] === 'bullet' || a['list'] === 'number') out.list = a['list'] as ListKind
  if (typeof a['level'] === 'number' && a['level'] > 0) {
    out.level = Math.min(MAX_LIST_LEVEL, Math.floor(a['level']))
  }
  if (typeof a['bulletChar'] === 'string' && a['bulletChar'] !== '') {
    out.bulletChar = a['bulletChar']
  }
  if (isNumberFormat(a['numberFormat'])) out.numberFormat = a['numberFormat']
  if (typeof a['startAt'] === 'number' && a['startAt'] >= 1) {
    out.startAt = Math.floor(a['startAt'])
  }
  return out
}

/** Keep only the inline {@link RichAttrs} from a raw run's attributes. */
function readInlineAttrs(a?: Record<string, unknown>): RichAttrs | undefined {
  if (a === undefined) return undefined
  const out: RichAttrs = {}
  if (a['italic'] === true) out.italic = true
  else if (a['italic'] === false) out.italic = false
  if (a['underline'] === true) out.underline = true
  else if (a['underline'] === false) out.underline = false
  if (typeof a['fontWeight'] === 'number') out.fontWeight = a['fontWeight']
  if (typeof a['color'] === 'number') out.color = a['color']
  if (typeof a['fontFamily'] === 'string' && a['fontFamily'] !== '') {
    out.fontFamily = a['fontFamily']
  }
  if (typeof a['fontSize'] === 'number' && a['fontSize'] > 0) out.fontSize = a['fontSize']
  return Object.keys(out).length > 0 ? out : undefined
}

export interface ParagraphInfo {
  /** Paragraph text WITHOUT its terminating separator (may contain '\n'). */
  text: string
  /** Block attributes carried on the terminating separator. */
  attrs: ParagraphAttrs
  /** Char index of the paragraph's first character in the Y.Text. */
  start: number
  /** Char index of the terminating separator (or text length if none). */
  end: number
  /** Whether a terminating U+2029 separator exists for this paragraph. */
  hasSep: boolean
}

export interface ParagraphDelta {
  /** Inline runs for this paragraph (separator stripped). */
  ops: RichDeltaOp[]
  /** Block attributes for this paragraph. */
  attrs: ParagraphAttrs
}

/**
 * Split a Y.Text into paragraphs with char offsets. Handles both the
 * normalized form (trailing separator on a list deck) and the legacy form
 * (no trailing separator) without producing a spurious empty final block.
 */
export function getParagraphs(yt: Y.Text): ParagraphInfo[] {
  const s = yt.toString()
  const raw = yt.toDelta() as Array<{ insert: unknown; attributes?: Record<string, unknown> }>
  // index -> block attrs, for every separator char
  const sepAttrs = new Map<number, ParagraphAttrs>()
  let pos = 0
  for (const op of raw) {
    const ins = typeof op.insert === 'string' ? op.insert : ''
    for (let i = 0; i < ins.length; i++) {
      if (ins[i] === PARAGRAPH_SEP) sepAttrs.set(pos + i, readBlockAttrs(op.attributes))
    }
    pos += ins.length
  }
  const out: ParagraphInfo[] = []
  let start = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] === PARAGRAPH_SEP) {
      out.push({
        text: s.slice(start, i),
        attrs: sepAttrs.get(i) ?? {},
        start,
        end: i,
        hasSep: true,
      })
      start = i + 1
    }
  }
  // Trailing text after the last separator is the final, unterminated
  // paragraph. If the string ended exactly on a separator (trailing-sep
  // invariant) there is no extra empty block — unless the body is empty.
  if (start < s.length || out.length === 0) {
    out.push({ text: s.slice(start), attrs: {}, start, end: s.length, hasSep: false })
  }
  return out
}

/**
 * Per-paragraph inline deltas + block attributes — the render-side view.
 * Equivalent paragraph boundaries to {@link getParagraphs} but preserving
 * inline run structure so each paragraph renders its own formatted runs.
 */
export function getParagraphDeltas(yt: Y.Text): ParagraphDelta[] {
  const raw = yt.toDelta() as Array<{ insert: unknown; attributes?: Record<string, unknown> }>
  const out: ParagraphDelta[] = []
  let cur: RichDeltaOp[] = []
  let lastWasSep = false
  let any = false
  const pushRun = (text: string, inline?: RichAttrs): void => {
    if (text.length === 0) return
    cur.push(inline !== undefined ? { insert: text, attributes: inline } : { insert: text })
  }
  for (const op of raw) {
    if (typeof op.insert !== 'string') continue
    any = true
    const inline = readInlineAttrs(op.attributes)
    const block = readBlockAttrs(op.attributes)
    const s = op.insert
    let seg = 0
    for (let i = 0; i < s.length; i++) {
      if (s[i] === PARAGRAPH_SEP) {
        pushRun(s.slice(seg, i), inline)
        out.push({ ops: cur, attrs: block })
        cur = []
        seg = i + 1
        lastWasSep = true
      } else {
        lastWasSep = false
      }
    }
    pushRun(s.slice(seg), inline)
  }
  // Final paragraph: only emit when the body didn't end on a separator
  // (or is completely empty), matching getParagraphs.
  if (!any || !lastWasSep || cur.length > 0) {
    out.push({ ops: cur, attrs: {} })
  }
  return out
}

function toBlockRecord(patch: Partial<Record<ParagraphAttrKey, unknown>>): Record<string, unknown> {
  const rec: Record<string, unknown> = {}
  for (const k of PARAGRAPH_ATTR_KEYS) {
    if (k in patch) rec[k] = patch[k] === undefined ? null : patch[k]
  }
  return rec
}

export type ParagraphPatch = Partial<
  Record<ParagraphAttrKey, ListKind | ListNumberFormat | string | number | null>
>

/**
 * Core per-paragraph mutation: for each paragraph overlapping the char
 * range [from, to], call `compute` with its current attributes and apply
 * the returned patch (a key set to `null`/`undefined` clears it). Returning
 * `null` leaves that paragraph untouched. Ensures the final paragraph is
 * terminated by a separator so its attributes have somewhere to live.
 *
 * Must run inside a Y.Doc transaction supplied by the caller.
 */
export function updateParagraphsInRange(
  yt: Y.Text,
  from: number,
  to: number,
  compute: (attrs: ParagraphAttrs, index: number) => ParagraphPatch | null,
): void {
  const lo = Math.max(0, Math.min(from, to))
  const hi = Math.max(from, to)
  const paras = getParagraphs(yt)
  const overlaps = (p: ParagraphInfo): boolean => p.start <= hi && p.end >= lo
  const targeted = paras.filter(overlaps)
  if (targeted.length === 0) return
  // The only paragraph that can lack a terminating separator is the last
  // one. If it's targeted, append a separator at the very end first; this
  // doesn't shift any earlier separator index.
  const last = paras[paras.length - 1]!
  if (!last.hasSep && overlaps(last)) yt.insert(yt.length, PARAGRAPH_SEP)
  const fresh = getParagraphs(yt)
  fresh.forEach((p, i) => {
    if (!overlaps(p) || !p.hasSep) return
    const patch = compute(p.attrs, i)
    if (patch === null) return
    const rec = toBlockRecord(patch)
    if (Object.keys(rec).length > 0) yt.format(p.end, 1, rec)
  })
}

/**
 * Apply (or clear) the same block attributes on every paragraph
 * overlapping [from, to]. Pass `null`/`undefined` for a key to clear it.
 * Must run inside a Y.Doc transaction supplied by the caller.
 */
export function applyParagraphPatch(
  yt: Y.Text,
  from: number,
  to: number,
  patch: ParagraphPatch,
): void {
  if (Object.keys(toBlockRecord(patch)).length === 0) return
  updateParagraphsInRange(yt, from, to, () => patch)
}

/**
 * Toggle a list kind over a range. If every covered paragraph already has
 * `list === kind`, the list is removed (and level reset). Otherwise every
 * covered paragraph is set to that kind, preserving each one's level.
 * Returns the list kind in effect after the toggle (or null when removed).
 */
export function toggleListKind(
  yt: Y.Text,
  from: number,
  to: number,
  kind: ListKind,
): ListKind | null {
  const lo = Math.max(0, Math.min(from, to))
  const hi = Math.max(from, to)
  const covered = getParagraphs(yt).filter((p) => p.start <= hi && p.end >= lo)
  const allMatch = covered.length > 0 && covered.every((p) => p.attrs.list === kind)
  if (allMatch) {
    // Remove the list entirely, including any list-only decorations.
    updateParagraphsInRange(yt, from, to, () => ({
      list: null,
      level: null,
      bulletChar: null,
      numberFormat: null,
      startAt: null,
    }))
    return null
  }
  updateParagraphsInRange(yt, from, to, () => ({ list: kind }))
  return kind
}

/**
 * Bump each covered paragraph's nesting level by `delta` (clamped to
 * 0..{@link MAX_LIST_LEVEL}). Used for Tab / Shift-Tab indent / outdent.
 * Returns true when any paragraph changed.
 */
export function indentParagraphs(yt: Y.Text, from: number, to: number, delta: number): boolean {
  let changed = false
  updateParagraphsInRange(yt, from, to, (attrs) => {
    const cur = attrs.level ?? 0
    const next = Math.max(0, Math.min(MAX_LIST_LEVEL, cur + delta))
    if (next === cur) return null
    changed = true
    return { level: next === 0 ? null : next }
  })
  return changed
}

/**
 * Read the block attributes shared across every paragraph overlapping
 * [from, to]. A key is present in the result only when *all* covered
 * paragraphs agree on its value — the Inspector shows a blank/mixed state
 * otherwise.
 */
export function readParagraphAttrsForRange(yt: Y.Text, from: number, to: number): ParagraphAttrs {
  const lo = Math.max(0, Math.min(from, to))
  const hi = Math.max(from, to)
  const covered = getParagraphs(yt).filter((p) => p.start <= hi && p.end >= lo)
  if (covered.length === 0) return {}
  const first = covered[0]!.attrs
  const out: ParagraphAttrs = { ...first }
  for (const p of covered.slice(1)) {
    for (const k of PARAGRAPH_ATTR_KEYS) {
      if ((out[k] as unknown) !== (p.attrs[k] as unknown)) delete out[k]
    }
  }
  return out
}

// --- Numbering / marker computation ----------------------------------------

function toAlpha(n: number, upper: boolean): string {
  let v = Math.max(1, Math.floor(n))
  let s = ''
  while (v > 0) {
    const rem = (v - 1) % 26
    s = String.fromCharCode(97 + rem) + s
    v = Math.floor((v - 1) / 26)
  }
  return upper ? s.toUpperCase() : s
}

function toRoman(n: number, upper: boolean): string {
  let v = Math.max(1, Math.floor(n))
  const table: Array<[number, string]> = [
    [1000, 'm'],
    [900, 'cm'],
    [500, 'd'],
    [400, 'cd'],
    [100, 'c'],
    [90, 'xc'],
    [50, 'l'],
    [40, 'xl'],
    [10, 'x'],
    [9, 'ix'],
    [5, 'v'],
    [4, 'iv'],
    [1, 'i'],
  ]
  let s = ''
  for (const [val, sym] of table) {
    while (v >= val) {
      s += sym
      v -= val
    }
  }
  return upper ? s.toUpperCase() : s
}

/** Format an ordinal for a numbered list paragraph (incl. its punctuation). */
export function formatListNumber(n: number, fmt: ListNumberFormat): string {
  switch (fmt) {
    case 'decimal':
      return `${n}.`
    case 'decimalParen':
      return `${n})`
    case 'lowerAlpha':
      return `${toAlpha(n, false)}.`
    case 'lowerAlphaParen':
      return `${toAlpha(n, false)})`
    case 'upperAlpha':
      return `${toAlpha(n, true)}.`
    case 'upperAlphaParen':
      return `${toAlpha(n, true)})`
    case 'lowerRoman':
      return `${toRoman(n, false)}.`
    case 'upperRoman':
      return `${toRoman(n, true)}.`
    default:
      return `${n}.`
  }
}

/**
 * Compute the literal list marker for each paragraph (bullet glyph or
 * formatted number), or `null` for a non-list paragraph. Numbering keeps a
 * per-level counter: descending out of a deeper level restarts that level,
 * a bullet or plain paragraph at a level breaks that level's run, and a
 * paragraph's `startAt` resets its level's counter.
 *
 * `legacyListStyle` reproduces the old frame-wide flag for un-migrated
 * decks (every paragraph treated as that list at level 0).
 */
export function computeMarkers(
  attrs: ReadonlyArray<ParagraphAttrs>,
  legacyListStyle?: TextListStyle,
): Array<string | null> {
  const counters: number[] = []
  const active: boolean[] = []
  const legacyKind: ListKind | undefined =
    legacyListStyle === 'bullet' ? 'bullet' : legacyListStyle === 'numbered' ? 'number' : undefined
  return attrs.map((a) => {
    const kind: ListKind | undefined = a.list ?? legacyKind
    const level = Math.max(0, Math.min(MAX_LIST_LEVEL, a.level ?? 0))
    // Descending out of any deeper level restarts it next time.
    for (let l = level + 1; l < counters.length; l++) {
      counters[l] = 0
      active[l] = false
    }
    if (kind === 'number') {
      let n: number
      if (typeof a.startAt === 'number' && a.startAt >= 1) {
        n = a.startAt
      } else if (active[level] === true) {
        n = (counters[level] ?? 0) + 1
      } else {
        n = 1
      }
      counters[level] = n
      active[level] = true
      return formatListNumber(n, a.numberFormat ?? 'decimal')
    }
    if (kind === 'bullet') {
      active[level] = false
      return a.bulletChar ?? defaultBulletGlyph(level)
    }
    active[level] = false
    return null
  })
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

export interface ListedHtmlOptions extends HtmlDefaults {
  paragraphSpaceBefore?: number
  paragraphSpaceAfter?: number
  /** Legacy frame-wide list fallback for un-migrated decks. */
  legacyListStyle?: TextListStyle
  /** Left indent added per nesting level, in em. Default 1.5. */
  indentPerLevelEm?: number
  /** Width of the marker gutter (hanging indent), in em. Default 1.6. */
  markerHangEm?: number
}

/**
 * Render a paragraph list (from {@link getParagraphDeltas}) into a single
 * HTML string of `<div data-pb="1">` blocks — one per paragraph — each
 * carrying its list marker, hanging indent, nesting indent, and paragraph
 * spacing. Shared verbatim by the Pixi `HTMLText` renderer and the
 * contenteditable edit overlay so the two never drift.
 *
 * Markers are wrapped in `<span data-marker="1" contenteditable="false">`
 * so the editor can exclude them from the text projection and keep the
 * caret out of them. Empty paragraphs emit `<br data-empty="1">` for
 * height; the editor ignores those when reconstructing the body string.
 */
export function buildListedHtml(paras: ParagraphDelta[], o: ListedHtmlOptions): string {
  const indentEm = o.indentPerLevelEm ?? 1.5
  const hangEm = o.markerHangEm ?? 1.6
  const defaults: HtmlDefaults = {}
  if (o.italic !== undefined) defaults.italic = o.italic
  if (o.underline !== undefined) defaults.underline = o.underline
  if (o.fontWeight !== undefined) defaults.fontWeight = o.fontWeight
  if (o.color !== undefined) defaults.color = o.color
  const markers = computeMarkers(
    paras.map((p) => p.attrs),
    o.legacyListStyle,
  )
  const psB =
    typeof o.paragraphSpaceBefore === 'number' && o.paragraphSpaceBefore > 0
      ? o.paragraphSpaceBefore
      : 0
  const psA =
    typeof o.paragraphSpaceAfter === 'number' && o.paragraphSpaceAfter > 0
      ? o.paragraphSpaceAfter
      : 0
  const out: string[] = []
  for (let i = 0; i < paras.length; i++) {
    const p = paras[i]!
    const marker = markers[i] ?? null
    const level = Math.max(0, Math.min(MAX_LIST_LEVEL, p.attrs.level ?? 0))
    const styleBits: string[] = []
    // Space-before is the gap *between* paragraphs. PowerPoint does not apply
    // it above the first paragraph in a text frame, and neither do we — the
    // extra leading pushed imported text down by one gap and was part of why
    // a frame PowerPoint had auto-sized to its text overflowed here.
    if (psB > 0 && i > 0) styleBits.push(`margin-top:${psB}px`)
    if (psA > 0) styleBits.push(`margin-bottom:${psA}px`)
    if (marker !== null) {
      styleBits.push(`padding-left:${(level * indentEm + hangEm).toFixed(3)}em`)
      styleBits.push(`text-indent:-${hangEm}em`)
    } else if (level > 0) {
      styleBits.push(`padding-left:${(level * indentEm).toFixed(3)}em`)
    }
    const markerHtml =
      marker !== null
        ? `<span data-marker="1" contenteditable="false" style="display:inline-block;width:${hangEm}em">${escapeHtml(marker)}</span>`
        : ''
    const inner = toHtml(p.ops, defaults)
    const body = inner.length > 0 ? inner : '<br data-empty="1">'
    const style = styleBits.length > 0 ? ` style="${styleBits.join(';')}"` : ''
    out.push(`<div data-pb="1"${style}>${markerHtml}${body}</div>`)
  }
  return out.join('')
}

/**
 * Project {@link ParagraphAttrs} to the raw attribute record used when
 * inserting a paragraph separator into a Y.Text (PPTX import / programmatic
 * builders). Returns undefined when there is nothing to store.
 */
export function blockAttrsToInsertAttrs(
  attrs: ParagraphAttrs,
): Record<string, unknown> | undefined {
  const rec: Record<string, unknown> = {}
  if (attrs.list === 'bullet' || attrs.list === 'number') rec['list'] = attrs.list
  if (typeof attrs.level === 'number' && attrs.level > 0) {
    rec['level'] = Math.min(MAX_LIST_LEVEL, Math.floor(attrs.level))
  }
  if (typeof attrs.bulletChar === 'string' && attrs.bulletChar !== '') {
    rec['bulletChar'] = attrs.bulletChar
  }
  if (isNumberFormat(attrs.numberFormat)) rec['numberFormat'] = attrs.numberFormat
  if (typeof attrs.startAt === 'number' && attrs.startAt >= 1) {
    rec['startAt'] = Math.floor(attrs.startAt)
  }
  return Object.keys(rec).length > 0 ? rec : undefined
}
