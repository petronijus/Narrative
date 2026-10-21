/**
 * renderer/experimental/textEngine/blockLayout.ts — candidate (a1) of the E7
 * spike: CSS inline layout of a `TextBlock` with nothing but a text
 * measurer, so it runs in a worker (EXPERIMENTAL).
 *
 * The subset is the one our markup produces (white-space `pre-wrap` or
 * `pre`, `overflow-wrap: break-word`, explicit px line heights): paragraphs
 * as blocks with collapsing margins, a hanging text-indent and a marker
 * inline-block, inline runs in several fonts, `<br>`, per-line alignment.
 * Chromium's rules where they decide pixels:
 *
 *   - half-leading: the part above the glyphs is floored to a whole pixel
 *     (`CalculateLeadingSpace` in LayoutNG), the rest goes below; the line
 *     box spans every inline box of the line, the paragraph's strut included;
 *   - spaces at the end of a wrapped line hang: they neither cause a break
 *     nor count for alignment;
 *   - break opportunities (a simplification of UAX #14): after spaces,
 *     after a hyphen between letters, around em / en dashes, after U+200B,
 *     between CJK ideographs; an unbreakable word wider than the line is
 *     broken between graphemes (`break-word`);
 *   - the measured size is the inline-block's scroll size, whole pixels.
 */

import { transformText } from './textTransform.js'
import type { GlyphRun, TextRunLayout } from './runs.js'
import type { BlockParagraph, BlockStyle, TextBlock } from './textBlock.js'

/** The one thing layout needs from a font engine: an advance width. */
export interface Measurer {
  /** Advance of `text` in `style`, letter spacing included, CSS px. */
  width(text: string, style: BlockStyle): number
}

/** Options that differ between engines (WebKit's inline layout is not LayoutNG). */
export interface LayoutOptions {
  /**
   * The unit the half-leading above the glyphs is floored to: a whole pixel
   * in Chromium (LayoutNG's `CalculateLeadingSpace`), a LayoutUnit (1/64)
   * in WebKit.
   */
  halfLeadingUnit: number
  /** The unit a line height is floored to: a LayoutUnit in Chromium; 0 = none (WebKit's float inline layout). */
  lineHeightUnit: number
}

export const CHROMIUM_LAYOUT: LayoutOptions = { halfLeadingUnit: 1, lineHeightUnit: 1 / 64 }
export const WEBKIT_LAYOUT: LayoutOptions = { halfLeadingUnit: 0, lineHeightUnit: 0 }

function floorTo(v: number, unit: number): number {
  return unit > 0 ? Math.floor(v / unit) * unit : v
}

interface Piece {
  text: string
  style: number
  /** A line may break after this piece. */
  breakAfter: boolean
  /** A marker inline-block of this width (its text drawn inside). */
  box?: number
  /** A forced break (`<br>`) — text is empty. */
  br?: boolean
}

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/u
const LETTER = /\p{L}/u
const DIGIT_OR_SPACE = /[\p{N}\s]/u

/** Split `text` after each break opportunity. Exported for tests. */
export function breakUnits(text: string): string[] {
  const out: string[] = []
  let cur = ''
  const chars = [...text]
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!
    const next = chars[i + 1]
    // A break before an em dash or an ideograph.
    if (cur !== '' && (ch === '—' || CJK.test(ch)) && !/\s$/u.test(cur)) {
      out.push(cur)
      cur = ''
    }
    cur += ch
    const isSpace = ch === ' '
    const breakHere =
      (isSpace && next !== ' ') ||
      ch === '​' ||
      ch === '–' ||
      ch === '—' ||
      CJK.test(ch) ||
      (ch === '-' &&
        i > 0 &&
        LETTER.test(chars[i - 1]!) &&
        next !== undefined &&
        !DIGIT_OR_SPACE.test(next))
    if (breakHere && next !== undefined && !(isSpace && next === ' ')) {
      out.push(cur)
      cur = ''
    }
  }
  if (cur !== '') out.push(cur)
  return out
}

function trailingSpaces(text: string): string {
  const m = / +$/u.exec(text)
  return m === null ? '' : m[0]
}

/** The paragraph's inlines as pieces with break opportunities, text-transform applied. */
function piecesOf(p: BlockParagraph, styles: readonly BlockStyle[]): Piece[] {
  const out: Piece[] = []
  let before = ' '
  for (const inline of p.inlines) {
    if (inline.kind === 'br') {
      out.push({ text: '', style: p.strut, breakAfter: true, br: true })
      before = ' '
      continue
    }
    const style = styles[inline.style]!
    if (inline.kind === 'box') {
      out.push({
        text: transformText(inline.text, style.transform, ' '),
        style: inline.style,
        breakAfter: false,
        box: inline.width,
      })
      continue
    }
    const text = transformText(inline.text, style.transform, before)
    before = inline.text.length > 0 ? inline.text[inline.text.length - 1]! : before
    const units = breakUnits(text)
    units.forEach((u, i) => {
      // The last unit of an inline breaks only if it ends with a space (the
      // next inline may continue the word).
      const last = i === units.length - 1
      out.push({ text: u, style: inline.style, breakAfter: !last || / $/u.test(u) })
    })
  }
  return out
}

interface Line {
  pieces: Piece[]
  /** Width without hanging spaces. */
  width: number
  first: boolean
}

class LineWidth {
  constructor(
    private readonly m: Measurer,
    private readonly styles: readonly BlockStyle[],
  ) {}

  /**
   * Width of pieces laid side by side: consecutive pieces of one style are
   * measured as one string (the browser shapes a text node as a whole, so
   * kerning across a space is in); a style change is a shaping boundary.
   */
  of(pieces: readonly Piece[], hang: boolean): number {
    let total = 0
    let runText = ''
    let runStyle = -1
    const flush = (): void => {
      if (runText !== '') total += this.m.width(runText, this.styles[runStyle]!)
      runText = ''
    }
    for (const p of pieces) {
      if (p.box !== undefined) {
        flush()
        total += p.box
        runStyle = -1
        continue
      }
      if (p.style !== runStyle) {
        flush()
        runStyle = p.style
      }
      runText += p.text
    }
    if (hang) {
      // Hanging spaces of the last piece(s) do not count.
      const last = pieces[pieces.length - 1]
      if (last !== undefined && last.box === undefined) {
        const spaces = trailingSpaces(runText)
        if (spaces.length > 0) {
          const kept = runText.slice(0, runText.length - spaces.length)
          runText = kept
        }
      }
    }
    flush()
    return total
  }
}

function graphemes(text: string): string[] {
  const Seg = (Intl as unknown as { Segmenter?: typeof Intl.Segmenter }).Segmenter
  if (Seg === undefined) return [...text]
  return [...new Seg(undefined, { granularity: 'grapheme' }).segment(text)].map((s) => s.segment)
}

/** Break a paragraph into lines of at most `avail` (first line: `availFirst`). */
function breakLines(
  pieces: Piece[],
  availFirst: number,
  avail: number,
  wraps: boolean,
  breakWord: boolean,
  lw: LineWidth,
): Line[] {
  const lines: Piece[][] = [[]]
  const EPS = 1 / 64
  const limit = (): number => (lines.length === 1 ? availFirst : avail)
  // Words: runs of pieces up to a break opportunity.
  const words: Piece[][] = []
  let cur: Piece[] = []
  for (const p of pieces) {
    if (p.br === true) {
      // A forced break is a word of its own, whatever came before it.
      if (cur.length > 0) words.push(cur)
      words.push([p])
      cur = []
      continue
    }
    cur.push(p)
    if (p.breakAfter) {
      words.push(cur)
      cur = []
    }
  }
  if (cur.length > 0) words.push(cur)
  for (const word of words) {
    const isBr = word.length === 1 && word[0]!.br === true
    if (isBr) {
      lines.push([])
      continue
    }
    const line = lines[lines.length - 1]!
    if (!wraps) {
      line.push(...word)
      continue
    }
    const candidate = [...line, ...word]
    if (lw.of(candidate, true) <= limit() + EPS) {
      line.push(...word)
      continue
    }
    if (line.length > 0) {
      lines.push([])
    }
    const fresh = lines[lines.length - 1]!
    if (lw.of(word, true) <= limit() + EPS || !breakWord) {
      fresh.push(...word)
      continue
    }
    // break-word: fill lines grapheme by grapheme.
    for (const piece of word) {
      let rest = graphemes(piece.text)
      while (rest.length > 0) {
        const target = lines[lines.length - 1]!
        let take = 0
        while (take < rest.length) {
          const trial: Piece = { ...piece, text: rest.slice(0, take + 1).join('') }
          if (lw.of([...target, trial], true) > limit() + EPS) break
          take++
        }
        if (take === 0 && target.length === 0) take = 1
        if (take === 0) {
          lines.push([])
          continue
        }
        const partDone = take === rest.length
        target.push({
          ...piece,
          text: rest.slice(0, take).join(''),
          breakAfter: partDone ? piece.breakAfter : false,
        })
        rest = rest.slice(take)
        if (rest.length > 0) lines.push([])
      }
    }
  }
  return lines.map((ps, i) => ({ pieces: ps, width: lw.of(ps, wraps), first: i === 0 }))
}

/** Lay `block` out: glyph runs and the size HTMLText would measure. */
export function layoutBlock(
  block: TextBlock,
  m: Measurer,
  options: LayoutOptions = CHROMIUM_LAYOUT,
): TextRunLayout {
  const lw = new LineWidth(m, block.styles)
  const wraps = block.width !== null
  const pad = block.padding
  interface Placed {
    line: Line
    p: BlockParagraph
    top: number
    baseline: number
    bottom: number
  }
  const placed: Placed[] = []
  let y = 0
  let prevMarginBottom = 0
  let maxLineWidth = 0
  block.paragraphs.forEach((p, pi) => {
    y += pi === 0 ? p.marginTop : Math.max(prevMarginBottom, p.marginTop)
    const width = block.width ?? Number.POSITIVE_INFINITY
    const avail = width - p.paddingLeft
    const pieces = piecesOf(p, block.styles)
    const lines = breakLines(pieces, avail - p.textIndent, avail, wraps, block.breakWord, lw)
    const L = floorTo(p.lineHeight, options.lineHeightUnit)
    for (const line of lines) {
      // Inline boxes of the line: the strut and every piece's style.
      const used = new Set<number>([p.strut])
      for (const piece of line.pieces) if (piece.br !== true) used.add(piece.style)
      let above = 0
      let below = 0
      for (const s of used) {
        const st = block.styles[s]!
        const leading = L - (st.ascent + st.descent)
        const top = floorTo(leading / 2, options.halfLeadingUnit)
        above = Math.max(above, st.ascent + top)
        below = Math.max(below, st.descent + (leading - top))
      }
      placed.push({ line, p, top: y, baseline: y + above, bottom: y + above + below })
      maxLineWidth = Math.max(
        maxLineWidth,
        line.width + p.paddingLeft + (line.first ? p.textIndent : 0),
      )
      y += above + below
    }
    prevMarginBottom = p.marginBottom
  })
  const last = block.paragraphs[block.paragraphs.length - 1]
  y += last?.marginBottom ?? 0
  const contentWidth = block.width ?? maxLineWidth
  const runs: GlyphRun[] = []
  for (const { line, p, baseline } of placed) {
    const indent = line.first ? p.textIndent : 0
    const avail = contentWidth - p.paddingLeft - indent
    const free = avail - line.width
    const offset = p.align === 'right' ? free : p.align === 'center' ? free / 2 : 0
    let x = pad + p.paddingLeft + indent + offset
    // Merge consecutive pieces of one style into runs; boxes are runs of their own.
    let group: Piece[] = []
    const emit = (): void => {
      if (group.length === 0) return
      const style = block.styles[group[0]!.style]!
      const text = group.map((g) => g.text).join('')
      const width = lw.of(group, false)
      if (text.trim() !== '' || style.underline !== undefined) {
        runs.push(runOf(text, x, pad + baseline, width, style))
      }
      x += width
      group = []
    }
    for (const piece of line.pieces) {
      if (piece.br === true) continue
      if (piece.box !== undefined) {
        emit()
        const style = block.styles[piece.style]!
        const tw = m.width(piece.text, style)
        const inner =
          p.align === 'right' ? piece.box - tw : p.align === 'center' ? (piece.box - tw) / 2 : 0
        if (piece.text.trim() !== '')
          runs.push(runOf(piece.text, x + inner, pad + baseline, tw, style))
        x += piece.box
        continue
      }
      if (group.length > 0 && group[0]!.style !== piece.style) emit()
      group.push(piece)
    }
    emit()
  }
  const width = Math.round(contentWidth + 2 * pad) - 2 * pad
  const height = Math.round(y + 2 * pad) - 2 * pad
  return {
    width,
    height,
    padding: pad,
    runs,
    lines: placed.map((q) => ({ top: pad + q.top, bottom: pad + q.bottom })),
  }
}

function runOf(text: string, x: number, y: number, width: number, style: BlockStyle): GlyphRun {
  const run: GlyphRun = {
    text,
    x,
    y,
    font: style.font,
    size: style.size,
    stretch: style.stretch,
    color: style.color,
    letterSpacing: style.letterSpacing,
    width,
  }
  if (style.underline !== undefined) {
    run.underline = {
      offset: Math.max(1, style.underline.size * 0.11),
      thickness: Math.max(1, style.underline.size / 14),
      color: style.underline.color,
    }
  }
  if (style.stroke !== undefined) run.stroke = style.stroke
  return run
}
