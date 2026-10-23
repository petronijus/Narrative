/**
 * e2e/fixtures/textCorpus.ts — the text corpus the canvas-text parity specs
 * draw (ADR 0018): every feature of a text box the renderer draws, one slide
 * per group, seeded through the command API (`ops.apply`) like the perf
 * scenes.
 *
 * Fonts are the bundled Inter (variable, upright and italic) and faces every
 * macOS and Linux test machine has a stand-in for (Arial, Georgia, Times New
 * Roman, Courier New, Verdana): both engines of a comparison run in the same
 * browser on the same machine, so a stand-in is the same stand-in for both.
 * Box sizes are deliberately odd (333.3 px, 287.7 px) so lines start at
 * fractional positions when centred or right-aligned.
 */

import { crowdedSlideOps, type Op } from '@narrative/perf'

const SENTENCE = 'Quick brown fox jumps over the lazy dog — AV Ta WA To 0123'
const LONG =
  'Revenue grew in every region this quarter, led by the new markets; retention held at ' +
  'ninety-four per cent while the pipeline for the next two quarters doubled.'

type Paragraph = {
  text?: string
  runs?: Array<{
    text: string
    bold?: boolean
    italic?: boolean
    underline?: boolean
    color?: string
    fontFamily?: string
    fontSize?: number
  }>
  list?: 'bullet' | 'number'
  level?: number
  bulletChar?: string
  numberFormat?: string
  startAt?: number
}

interface TextBox {
  id: string
  x: number
  y: number
  width: number
  height: number
  text: string | { paragraphs: Paragraph[] }
  fontSize?: number
  fontFamily?: string
  fontWeight?: number
  italic?: boolean
  underline?: boolean
  color?: string
  align?: 'left' | 'center' | 'right'
  vAlign?: 'top' | 'middle' | 'bottom'
  extra?: Record<string, unknown>
}

/** An object id the command API takes: letters, digits, `_` and `-`. */
function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/gu, '_')
}

function textBox(slide: number, b: TextBox): Op {
  return {
    command: 'object.create',
    input: {
      slide: { index: slide },
      id: safeId(b.id),
      object: {
        type: 'text',
        x: b.x,
        y: b.y,
        width: b.width,
        height: b.height,
        text:
          typeof b.text === 'string'
            ? { paragraphs: b.text.split('\n').map((line) => ({ text: line })) }
            : b.text,
        fontSize: b.fontSize ?? 24,
        fontWeight: b.fontWeight ?? 400,
        color: b.color ?? '#111827',
        align: b.align ?? 'left',
        rotation: 0,
        opacity: 1,
        ...(b.fontFamily !== undefined ? { fontFamily: b.fontFamily } : {}),
        ...(b.italic !== undefined ? { italic: b.italic } : {}),
        ...(b.underline !== undefined ? { underline: b.underline } : {}),
        ...(b.vAlign !== undefined ? { vAlign: b.vAlign } : {}),
        ...b.extra,
      },
    },
  }
}

/** A grid of boxes: `n` cells, `cols` per row, inside the 1920 × 1080 artboard. */
function grid(
  n: number,
  cols: number,
  top = 40,
  gap = 16,
): Array<{ x: number; y: number; w: number; h: number }> {
  const rows = Math.ceil(n / cols)
  const w = (1920 - 80 - gap * (cols - 1)) / cols
  const h = (1080 - top - 40 - gap * (rows - 1)) / rows
  return Array.from({ length: n }, (_, i) => ({
    x: 40 + (i % cols) * (w + gap),
    y: top + Math.floor(i / cols) * (h + gap),
    w,
    h,
  }))
}

export interface CorpusSlide {
  name: string
  ops: Op[]
  /** Text box ids on the slide. */
  ids: string[]
}

function slide(index: number, name: string, boxes: TextBox[]): CorpusSlide {
  return { name, ops: boxes.map((b) => textBox(index, b)), ids: boxes.map((b) => safeId(b.id)) }
}

const FAMILIES = ['Inter', 'Arial', 'Georgia', 'Times New Roman', 'Courier New', 'Verdana']

/** The corpus: its slides in deck order (slide 0 is the deck's first). */
export function textCorpus(): CorpusSlide[] {
  const slides: CorpusSlide[] = []

  // 0 — families, weights and slopes.
  {
    const boxes: TextBox[] = []
    const cells = grid(24, 4)
    let i = 0
    for (const w of [100, 200, 300, 400, 500, 600, 700, 800, 900]) {
      const c = cells[i++]!
      boxes.push({
        id: `w-inter-${w}`,
        x: c.x,
        y: c.y,
        width: c.w,
        height: c.h,
        text: `Inter ${w} ${SENTENCE}`,
        fontFamily: 'Inter',
        fontWeight: w,
        fontSize: 22,
      })
    }
    for (const w of [300, 700]) {
      const c = cells[i++]!
      boxes.push({
        id: `i-inter-${w}`,
        x: c.x,
        y: c.y,
        width: c.w,
        height: c.h,
        text: `Inter italic ${w} ${SENTENCE}`,
        fontFamily: 'Inter',
        fontWeight: w,
        italic: true,
        fontSize: 22,
      })
    }
    for (const f of FAMILIES.slice(1)) {
      for (const style of ['regular', 'bold', 'italic'] as const) {
        const c = cells[i++]
        if (c === undefined) break
        boxes.push({
          id: `f-${f.replace(/ /g, '-').toLowerCase()}-${style}`,
          x: c.x,
          y: c.y,
          width: c.w,
          height: c.h,
          text: `${f} ${style} ${SENTENCE}`,
          fontFamily: f,
          fontWeight: style === 'bold' ? 700 : 400,
          italic: style === 'italic',
          fontSize: 22,
        })
      }
    }
    slides.push(slide(0, 'families', boxes))
  }

  // 1 — sizes, whole and fractional.
  {
    const sizes = [8, 9, 11, 12.5, 14, 16, 18.75, 24, 31, 48, 72, 120]
    let y = 24
    const boxes: TextBox[] = sizes.map((s, i) => {
      const b: TextBox = {
        id: `size-${i}`,
        x: 40 + (i % 2) * 20.3,
        y,
        width: 1840,
        height: Math.ceil(s * 1.4),
        text: `${s}px Inter AVATAR Typography gjpqy ${SENTENCE}`,
        fontFamily: i % 3 === 0 ? 'Georgia' : 'Inter',
        fontSize: s,
        extra: { wrap: 'none' },
      }
      y += Math.ceil(s * 1.4) + 6
      return b
    })
    slides.push(slide(1, 'sizes', boxes))
  }

  // 2 — letter spacing, line height, line spacing, paragraph spacing.
  {
    const cells = grid(12, 3)
    const variants: Array<[string, Record<string, unknown>]> = [
      ['ls-2', { letterSpacing: -2 }],
      ['ls-0.5', { letterSpacing: 0.5 }],
      ['ls-3', { letterSpacing: 3 }],
      ['ls-12', { letterSpacing: 12 }],
      ['lh-0.75', { lineHeight: 0.75 }],
      ['lh-1', { lineHeight: 1 }],
      ['lh-1.37', { lineHeight: 1.37 }],
      ['lh-2.2', { lineHeight: 2.2 }],
      ['lsp-0.8', { lineSpacing: 0.8 }],
      ['lsp-1.5', { lineSpacing: 1.5 }],
      ['ps-before-after', { paragraphSpaceBefore: 14, paragraphSpaceAfter: 9 }],
      ['ls-lh-mix', { letterSpacing: 1.25, lineHeight: 1.15 }],
    ]
    const boxes: TextBox[] = variants.map(([id, extra], i) => {
      const c = cells[i]!
      return {
        id: `sp-${id}`,
        x: c.x,
        y: c.y,
        width: c.w,
        height: c.h,
        text: `${id}: ${LONG}\nSecond paragraph, a shorter one.`,
        fontFamily: i % 2 === 0 ? 'Inter' : 'Arial',
        fontSize: 20,
        extra,
      }
    })
    slides.push(slide(2, 'spacing', boxes))
  }

  // 3 — alignment, horizontal × vertical, at fractional widths; unwrapped lines.
  {
    const boxes: TextBox[] = []
    const aligns = ['left', 'center', 'right'] as const
    const valigns = ['top', 'middle', 'bottom'] as const
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++)
        boxes.push({
          id: `al-${aligns[c]}-${valigns[r]}`,
          x: 40.5 + c * 600.25,
          y: 30 + r * 270,
          width: 333.3 + c * 41.7,
          height: 240,
          text: `${aligns[c]} ${valigns[r]}: ${LONG.slice(0, 90 + c * 13)}`,
          fontFamily: c === 1 ? 'Arial' : 'Inter',
          fontSize: 19 + r,
          align: aligns[c],
          vAlign: valigns[r],
        })
    for (const [i, a] of aligns.entries())
      boxes.push({
        id: `nowrap-${a}`,
        x: 430 + i * 600,
        y: 860 + i * 50,
        width: 120,
        height: 40,
        text: `unwrapped ${a} line that runs past its box`,
        fontSize: 22,
        align: a,
        extra: { wrap: 'none' },
      })
    slides.push(slide(3, 'alignment', boxes))
  }

  // 4 — autofit: shrink and grow.
  {
    const boxes: TextBox[] = [
      {
        id: 'fit-shrink',
        x: 60,
        y: 60,
        width: 520,
        height: 180,
        text: `${LONG} ${LONG}`,
        fontSize: 30,
        extra: { autofit: 'shrink' },
      },
      {
        id: 'fit-shrink-min',
        x: 660,
        y: 60,
        width: 520,
        height: 120,
        text: `${LONG} ${LONG} ${LONG}`,
        fontSize: 28,
        extra: { autofit: 'shrink', minFontSize: 18 },
      },
      {
        id: 'fit-grow',
        x: 1260,
        y: 60,
        width: 520,
        height: 40,
        text: LONG,
        fontSize: 26,
        extra: { autofit: 'grow-down' },
      },
      {
        id: 'fit-shrink-list',
        x: 60,
        y: 420,
        width: 700,
        height: 220,
        text: {
          paragraphs: Array.from({ length: 9 }, (_, i) => ({
            list: 'bullet' as const,
            level: i % 3,
            text: `Point ${i + 1}: ${LONG.slice(0, 60)}`,
          })),
        },
        fontSize: 26,
        extra: { autofit: 'shrink' },
      },
    ]
    slides.push(slide(4, 'autofit', boxes))
  }

  // 5 — lists.
  {
    const cells = grid(6, 3)
    const items = (
      n: number,
      list: 'bullet' | 'number',
      extra: Partial<Paragraph> = {},
    ): Paragraph[] =>
      Array.from({ length: n }, (_, i) => ({
        list,
        level: i % 4,
        text: `${list} level ${i % 4}: ${LONG.slice(0, 40 + i * 7)}`,
        ...extra,
      }))
    const lists: Array<[string, Paragraph[], Record<string, unknown>?]> = [
      ['bullets', items(6, 'bullet')],
      ['numbers', items(6, 'number')],
      ['custom-bullet', items(4, 'bullet', { bulletChar: '–' })],
      ['alpha', items(4, 'number', { numberFormat: 'lowerAlpha' })],
      ['roman-start', items(4, 'number', { numberFormat: 'upperRoman', startAt: 4 })],
      [
        'levels',
        items(5, 'bullet'),
        {
          listLevels: [
            { bulletColor: '#dc2626', bulletScale: 1.4 },
            { indent: 60, hanging: 24, fontSize: 18, color: '#2563eb' },
            { fontWeight: 700 },
          ],
        },
      ],
    ]
    const boxes: TextBox[] = lists.map(([id, paragraphs, extra], i) => {
      const c = cells[i]!
      return {
        id: `list-${id}`,
        x: c.x,
        y: c.y,
        width: c.w,
        height: c.h,
        text: { paragraphs },
        fontSize: 20,
        fontFamily: i % 2 === 0 ? 'Inter' : 'Arial',
        extra: extra ?? {},
      }
    })
    slides.push(slide(5, 'lists', boxes))
  }

  // 6 — rich runs, transforms, colour alpha, stroke.
  {
    const cells = grid(9, 3)
    const runs: Paragraph = {
      runs: [
        { text: 'Mixed ' },
        { text: 'bold ', bold: true },
        { text: 'italic ', italic: true },
        { text: 'red ', color: '#dc2626' },
        { text: 'big ', fontSize: 40 },
        { text: 'Georgia ', fontFamily: 'Georgia' },
        { text: 'small', fontSize: 12 },
        { text: ' and back to normal across a wrap at the box edge.' },
      ],
    }
    const variants: Array<[string, Partial<TextBox>, Record<string, unknown>?]> = [
      ['runs', { text: { paragraphs: [runs, runs] } }],
      ['upper', {}, { textTransform: 'uppercase' }],
      ['lower', {}, { textTransform: 'lowercase' }],
      ['capitalize', {}, { textTransform: 'capitalize' }],
      ['alpha', {}, { colorAlpha: 0.45 }],
      ['stroke-1', { fontSize: 44, fontWeight: 700 }, { stroke: '#2563eb', strokeWidth: 1 }],
      ['stroke-3', { fontSize: 56, fontWeight: 800 }, { stroke: '#111827', strokeWidth: 3 }],
      ['colour', { color: '#0f766e', fontSize: 30 }],
      ['runs-arial', { text: { paragraphs: [runs] }, fontFamily: 'Arial' }],
    ]
    const boxes: TextBox[] = variants.map(([id, b, extra], i) => {
      const c = cells[i]!
      return {
        id: `run-${id}`,
        x: c.x,
        y: c.y,
        width: c.w,
        height: c.h,
        text: `${id}: the o'neil x-ray — ${LONG.slice(0, 80)}`,
        fontSize: 22,
        fontFamily: 'Inter',
        ...b,
        extra: extra ?? {},
      }
    })
    slides.push(slide(6, 'runs', boxes))
  }

  // 7 — underline.
  {
    const cells = grid(8, 2)
    const boxes: TextBox[] = [
      { id: 'u-box', text: `Underlined box: ${SENTENCE} gjpqy`, underline: true, fontSize: 24 },
      {
        id: 'u-box-arial',
        text: `Underlined Arial: ${SENTENCE} gjpqy`,
        underline: true,
        fontFamily: 'Arial',
        fontSize: 24,
      },
      { id: 'u-small', text: `Small underline gjpqy ${LONG}`, underline: true, fontSize: 12 },
      { id: 'u-big', text: 'Big gjpqy', underline: true, fontSize: 72, fontWeight: 700 },
      {
        id: 'u-italic',
        text: `Italic underline gjpqy ${SENTENCE}`,
        underline: true,
        italic: true,
        fontSize: 26,
      },
      {
        id: 'u-run',
        text: {
          paragraphs: [
            {
              runs: [
                { text: 'Only ' },
                { text: 'this part', underline: true },
                { text: ' is underlined, then ' },
                { text: 'bold underlined', bold: true, underline: true },
                { text: '.' },
              ],
            },
          ],
        },
        fontSize: 24,
      },
      {
        id: 'u-georgia',
        text: `Georgia underline gjpqy ${SENTENCE}`,
        underline: true,
        fontFamily: 'Georgia',
        fontSize: 28,
      },
      {
        id: 'u-centered',
        text: `Centred underlined text that wraps over more than one line in its box gjpqy`,
        underline: true,
        fontSize: 24,
        align: 'center',
      },
    ].map((b, i) => {
      const c = cells[i]!
      return { x: c.x, y: c.y, width: c.w, height: c.h, ...b } as TextBox
    })
    slides.push(slide(7, 'underline', boxes))
  }

  // 8 — scripts: RTL, emoji, CJK, combining marks.
  {
    const cells = grid(8, 2)
    const texts: Array<[string, string, string?]> = [
      ['hebrew', 'שלום עולם, זהו טקסט בעברית שנמשך על פני יותר משורה אחת בתיבה'],
      ['arabic', 'مرحبا بالعالم، هذا نص عربي يمتد على أكثر من سطر واحد في المربع'],
      ['mixed-bidi', 'English then עברית 123 and العربية back to English.'],
      ['emoji', 'Emoji 😀 👍🏽 🇨🇿 👨‍👩‍👧 ❤️ ✨ in a line of text that wraps 🚀'],
      [
        'japanese',
        '日本語のテキストは単語の間にスペースがなくても行を折り返します。カタカナとひらがな。',
      ],
      ['chinese', '中文文本在没有空格的情况下也会换行，这是第二句话。', 'Arial'],
      ['korean', '한국어 텍스트는 띄어쓰기가 있습니다. 두 번째 문장입니다.'],
      ['accents', 'Příliš žluťoučký kůň úpěl ďábelské ódy — e\u0301 a\u0308 Việt Nam ﬁ ﬂ'],
    ]
    const boxes: TextBox[] = texts.map(([id, text, family], i) => {
      const c = cells[i]!
      return {
        id: `sc-${id}`,
        x: c.x,
        y: c.y,
        width: c.w,
        height: c.h,
        text,
        fontSize: 26,
        fontFamily: family ?? 'Inter',
      }
    })
    slides.push(slide(8, 'scripts', boxes))
  }

  // 9 — a table: header, banded rows, alignment per column, vertical alignment
  // per row, an italic wrapping column, a light column.
  {
    const id = 'tbl'
    const rows = 6
    const cols = 5
    const slide = { index: 9 }
    const t = { slide, table: id }
    const ops: Op[] = [
      {
        command: 'object.create',
        input: {
          slide,
          id,
          object: {
            type: 'table',
            rows,
            cols,
            x: 80.5,
            y: 90,
            width: 1760,
            height: 860,
            defaults: {
              fontFamily: 'Inter',
              fontSize: 22,
              color: '#1f2937',
              vAlign: 'middle',
              padding: { top: 8, right: 12, bottom: 8, left: 12 },
              border: { color: '#d0d7de', width: 1 },
            },
          },
        },
      },
    ]
    const range = (
      r0: number,
      c0: number,
      r1: number,
      c1: number,
      style: Record<string, unknown>,
    ): void => {
      ops.push({
        command: 'table.style.range',
        input: { ...t, range: { from: { row: r0, col: c0 }, to: { row: r1, col: c1 } }, style },
      })
    }
    range(0, 0, 0, cols - 1, {
      fill: '#1b2a4a',
      color: '#ffffff',
      fontWeight: 700,
      align: 'center',
    })
    for (let r = 2; r < rows; r += 2) range(r, 0, r, cols - 1, { fill: '#f3f6fa' })
    range(1, 1, rows - 1, 1, { italic: true, fontSize: 18, color: '#4b5563' })
    range(1, 2, rows - 1, 2, { align: 'center' })
    range(1, 3, rows - 1, 4, { align: 'right' })
    range(1, 0, 1, cols - 1, { vAlign: 'top' })
    range(3, 0, 3, cols - 1, { vAlign: 'bottom' })
    range(1, 4, rows - 1, 4, { fontWeight: 300, fontSize: 20 })
    const head = ['Segment', 'Summary', 'Centred', 'Right', 'Light']
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const text =
          r === 0
            ? head[c]!
            : c === 1
              ? LONG.slice(0, 60 + r * 11)
              : c === 0
                ? `Row ${r} AV Ta`
                : `${(r * 1234.5 + c * 77).toFixed(1)} €`
        ops.push({
          command: 'text.set',
          input: { target: { slide, object: id, cell: { row: r, col: c } }, text },
        })
      }
    slides.push({ name: 'table', ops, ids: [id] })
  }

  // 10 — the perf harness's crowded slide: 120 texts in Arial (and its probe text).
  {
    const { ops } = crowdedSlideOps({ texts: 120, images: 0, rects: 0 }, ['none'])
    const ids: string[] = []
    const own: Op[] = []
    for (const op of ops) {
      const input = op.input as { slide: unknown; id: string; object: { type: string } }
      if (op.command !== 'object.create' || input.object.type !== 'text') continue
      own.push({ ...op, input: { ...input, slide: { index: 10 } } })
      ids.push(input.id)
    }
    slides.push({ name: 'crowded', ops: own, ids })
  }

  return slides
}

/** Every op of the corpus deck: the slides added after the deck's first, then each slide's boxes. */
export function textCorpusOps(): { ops: Op[]; slides: CorpusSlide[] } {
  const slides = textCorpus()
  const ops: Op[] = []
  for (let i = 1; i < slides.length; i++) ops.push({ command: 'slide.add', input: {} })
  for (const s of slides) ops.push(...s.ops)
  return { ops, slides }
}
