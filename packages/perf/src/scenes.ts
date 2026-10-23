/**
 * scenes.ts — the seeded scenes of the browser benches (docs/plans/
 * perf-harness.md → Design principles 3): deterministic lists of commands
 * (`object.create`, `slide.add`) for the command API's `ops.apply`, so a dev
 * page, a production preview, both sides of an A/B and the Lighthouse audit
 * all get the same scene. Positions and sizes come from a fixed hash, words
 * from a fixed list. Pure: the drivers send the ops (apps/web/e2e/perf/lib/
 * seed.ts, cli/lighthouse.ts).
 */

/** One command of an `ops.apply` batch. */
export interface Op {
  command: string
  input: unknown
}

const WORDS = (
  'Narrative quarterly revenue growth market segment customer retention roadmap launch ' +
  'insight strategy brand audience campaign pipeline forecast delivery milestone risk'
).split(' ')

function sentence(seed: number, words: number): string {
  let s = ''
  for (let i = 0; i < words; i++) s += (i ? ' ' : '') + WORDS[(seed * 7 + i * 3) % WORDS.length]
  return s
}

/** A fixed hash in [0, m). */
export function rnd(i: number, m: number): number {
  return ((i * 2654435761) >>> 0) % m
}

const hex = (rgb: number): string => `#${(rgb & 0xffffff).toString(16).padStart(6, '0')}`

export interface Box {
  id: string
  x: number
  y: number
  width: number
  height: number
}

export function rectOp(slide: unknown, o: Box & { fill: number }): Op {
  return {
    command: 'object.create',
    input: {
      slide,
      id: o.id,
      object: {
        type: 'rectangle',
        x: o.x,
        y: o.y,
        width: o.width,
        height: o.height,
        fill: hex(o.fill),
        opacity: 1,
        rotation: 0,
      },
    },
  }
}

export function textOp(
  slide: unknown,
  o: Box & { text: string; fontSize: number; autofit?: 'grow-down' },
): Op {
  return {
    command: 'object.create',
    input: {
      slide,
      id: o.id,
      object: {
        type: 'text',
        x: o.x,
        y: o.y,
        width: o.width,
        height: o.height,
        text: { paragraphs: o.text.split('\n').map((line) => ({ text: line })) },
        fontSize: o.fontSize,
        fontWeight: 400,
        color: '#000000',
        align: 'left',
        rotation: 0,
        opacity: 1,
        ...(o.autofit === undefined ? {} : { autofit: o.autofit }),
      },
    },
  }
}

export function imageOp(slide: unknown, o: Box & { assetId: string }): Op {
  return {
    command: 'object.create',
    input: {
      slide,
      id: o.id,
      object: {
        type: 'image',
        assetId: o.assetId,
        x: o.x,
        y: o.y,
        width: o.width,
        height: o.height,
        opacity: 1,
        rotation: 0,
      },
    },
  }
}

export interface CrowdedScene {
  texts: number
  images: number
  rects: number
}

/**
 * The crowded slide of perf-heavy-slide.spec.ts: texts, then rectangles and
 * pictures, then three probes on top in an area of their own (a rectangle, a
 * text, a picture). Returns every object's box, by id.
 */
export function crowdedSlideOps(
  scene: CrowdedScene,
  assets: readonly string[],
): { ops: Op[]; boxes: Map<string, Box> } {
  const slide = { index: 0 }
  const ops: Op[] = []
  const boxes = new Map<string, Box>()
  const add = (op: Op, box: Box): void => {
    ops.push(op)
    boxes.set(box.id, box)
  }
  for (let i = 0; i < scene.rects; i++) {
    const b = {
      id: `rect-${i}`,
      x: rnd(i + 1, 1700),
      y: rnd(i + 5, 900),
      width: 120 + rnd(i + 9, 260),
      height: 80 + rnd(i + 13, 200),
    }
    add(rectOp(slide, { ...b, fill: 0x223344 + rnd(i, 0x777777) }), b)
  }
  for (let i = 0; i < scene.images; i++) {
    const b = {
      id: `img-${i}`,
      x: rnd(i + 21, 1500),
      y: rnd(i + 25, 800),
      width: 260 + rnd(i + 29, 240),
      height: 180 + rnd(i + 33, 160),
    }
    add(imageOp(slide, { ...b, assetId: assets[i % assets.length]! }), b)
  }
  for (let i = 0; i < scene.texts; i++) {
    const lines = 1 + (i % 4)
    const b = {
      id: `text-${i}`,
      x: rnd(i + 41, 1600),
      y: rnd(i + 45, 950),
      width: 240 + rnd(i + 49, 320),
      height: 40 * lines,
    }
    const text = Array.from({ length: lines }, (_, l) => sentence(i + l, 3 + ((i + l) % 4))).join(
      '\n',
    )
    add(textOp(slide, { ...b, text, fontSize: 16 + rnd(i + 53, 5) * 6 }), b)
  }
  const probeRect = { id: 'probe-rect', x: 1300, y: 420, width: 220, height: 160 }
  add(rectOp(slide, { ...probeRect, fill: 0xcc3366 }), probeRect)
  // A growing box (`autofit: 'grow-down'`, what agents and imports write):
  // typing into it and dragging it go through the editor's height write-back
  // (state/autofitHeights.ts, performance.md → E4).
  const probeText = { id: 'probe-text', x: 300, y: 420, width: 520, height: 120 }
  add(
    textOp(slide, {
      ...probeText,
      text: 'Probe text box for typing and dragging',
      fontSize: 40,
      autofit: 'grow-down',
    }),
    probeText,
  )
  const probeImg = { id: 'probe-img', x: 860, y: 420, width: 360, height: 240 }
  add(imageOp(slide, { ...probeImg, assetId: assets[0]! }), probeImg)
  return { ops, boxes }
}

/** The light slide of perf-zoom-drag.spec.ts: a text and twelve rectangles. */
export function lightSlideOps(): { ops: Op[]; boxes: Map<string, Box> } {
  const slide = { index: 0 }
  const ops: Op[] = []
  const boxes = new Map<string, Box>()
  const text = { id: 'perf-text', x: 100, y: 100, width: 800, height: 120 }
  ops.push(
    textOp(slide, {
      ...text,
      text: 'The quick brown fox jumps over the lazy dog, again and again',
      fontSize: 32,
    }),
  )
  boxes.set(text.id, text)
  for (let i = 0; i < 12; i++) {
    const b = {
      id: `perf-r${i}`,
      x: 100 + (i % 6) * 280,
      y: 400 + Math.floor(i / 6) * 260,
      width: 220,
      height: 200,
    }
    ops.push(rectOp(slide, { ...b, fill: 0x3366cc }))
    boxes.set(b.id, b)
  }
  return { ops, boxes }
}

/** The table of the table slide (performance.md → E5): 12 rows × 8 columns. */
export const TABLE_SCENE = {
  id: 'perf-table',
  rows: 12,
  cols: 8,
  box: { id: 'perf-table', x: 160, y: 140, width: 1600, height: 840 },
} as const

const TABLE_HEADERS = ['Segment', 'Summary', 'Q1', 'Q2', 'Q3', 'Q4', 'Growth', 'Share']

/**
 * The table slide: one styled 12 × 8 table in Inter, the way a quarterly
 * report has it — a dark centred bold header row, banded rows, a bold first
 * column, a wrapping summary column in italics, right-aligned figures, a
 * totals row with a gradient fill, cells centred vertically — and a second
 * slide with a title only (the mount bench switches to the table from it).
 * Every cell has text. Ids: `perf-table`, `perf-title-2`.
 */
export function tableSlideOps(): { ops: Op[]; boxes: Map<string, Box>; second: Box } {
  const { id, rows, cols, box } = TABLE_SCENE
  const slide = { index: 0 }
  const ops: Op[] = [{ command: 'slide.add', input: {} }]
  const t = { slide, table: id }
  ops.push({
    command: 'object.create',
    input: {
      slide,
      id,
      object: {
        type: 'table',
        rows,
        cols,
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        defaults: {
          fontFamily: 'Inter',
          fontSize: 18,
          color: '#1f2937',
          vAlign: 'middle',
          padding: { top: 8, right: 12, bottom: 8, left: 12 },
          border: { color: '#d0d7de', width: 1 },
        },
      },
    },
  })
  const range = (r0: number, c0: number, r1: number, c1: number, style: Record<string, unknown>) =>
    ops.push({
      command: 'table.style.range',
      input: { ...t, range: { from: { row: r0, col: c0 }, to: { row: r1, col: c1 } }, style },
    })
  for (let r = 2; r < rows - 1; r += 2) range(r, 0, r, cols - 1, { fill: '#f3f6fa' })
  range(1, 0, rows - 1, 0, { fontWeight: 600 })
  range(1, 1, rows - 2, 1, { italic: true, fontSize: 16, color: '#4b5563' })
  range(1, 2, rows - 1, cols - 1, { align: 'right' })
  range(0, 0, 0, cols - 1, { fill: '#1b2a4a', color: '#ffffff', fontWeight: 700, align: 'center' })
  range(rows - 1, 0, rows - 1, cols - 1, {
    fontWeight: 700,
    fillStyle: {
      kind: 'linearGradient',
      angleDeg: 90,
      stops: [
        { offset: 0, color: 0xe8eef8, alpha: 1 },
        { offset: 1, color: 0xc9d6e8, alpha: 1 },
      ],
    },
  })
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      let text: string
      if (r === 0) text = TABLE_HEADERS[c]!
      else if (r === rows - 1) text = c === 0 ? 'Total' : c === 1 ? sentence(r + 3, 3) : '9 876'
      else if (c === 0) text = `${WORDS[(r * 5) % WORDS.length]} ${r}`
      else if (c === 1) text = sentence(r * 3 + 1, 4 + (r % 3))
      else if (c === cols - 1) text = `${(rnd(r * cols + c, 400) / 10).toFixed(1)} %`
      else if (c === cols - 2) text = `+${(rnd(r * cols + c, 250) / 10).toFixed(1)} %`
      else text = `${1 + rnd(r * cols + c, 9)} ${String(rnd(r * 31 + c, 1000)).padStart(3, '0')}`
      ops.push({
        command: 'text.set',
        input: { target: { slide, object: id, cell: { row: r, col: c } }, text },
      })
    }
  const second = { id: 'perf-title-2', x: 160, y: 80, width: 1600, height: 120 }
  ops.push(textOp({ index: 1 }, { ...second, text: 'Next slide', fontSize: 64 }))
  return { ops, boxes: new Map([[box.id, { ...box }]]), second }
}

/**
 * A deck of `slides` slides, each with 6 texts, 4 rectangles and 2 pictures
 * (ids `s<n>-…`). The deck's first slide exists already; the rest are added.
 */
export function deckOps(
  slides: number,
  assets: readonly string[],
): { ops: Op[]; perSlide: string[][] } {
  const ops: Op[] = []
  const perSlide: string[][] = []
  for (let s = 1; s < slides; s++) ops.push({ command: 'slide.add', input: {} })
  for (let s = 0; s < slides; s++) {
    const slide = { index: s }
    const ids: string[] = []
    for (let i = 0; i < 4; i++) {
      const b = {
        id: `s${s}-r${i}`,
        x: 80 + i * 440,
        y: 700 + rnd(s * 13 + i, 200),
        width: 380,
        height: 160,
      }
      ops.push(rectOp(slide, { ...b, fill: 0x335577 + rnd(s * 7 + i, 0x553311) }))
      ids.push(b.id)
    }
    for (let i = 0; i < 2; i++) {
      const b = { id: `s${s}-i${i}`, x: 1100 + i * 380, y: 160, width: 340, height: 240 }
      ops.push(imageOp(slide, { ...b, assetId: assets[(s * 2 + i) % assets.length]! }))
      ids.push(b.id)
    }
    for (let i = 0; i < 6; i++) {
      const lines = 1 + ((s + i) % 3)
      const b = { id: `s${s}-t${i}`, x: 80, y: 60 + i * 100, width: 900, height: 44 * lines }
      const text = Array.from({ length: lines }, (_, l) =>
        sentence(s * 11 + i + l, 4 + ((i + l) % 5)),
      ).join('\n')
      ops.push(
        textOp(slide, {
          ...b,
          text: i === 0 ? `Slide ${s + 1}: ${text}` : text,
          fontSize: i === 0 ? 48 : 24,
        }),
      )
      ids.push(b.id)
    }
    perSlide.push(ids)
  }
  return { ops, perSlide }
}

// ---------------------------------------------------------------------------
// Present mode (docs/plans/performance.md → D)
// ---------------------------------------------------------------------------

/** A present-mode deck: its ops and every slide's object ids (index = slide index). */
export interface PresentScene {
  ops: Op[]
  perSlide: string[][]
}

function backgroundOp(slide: unknown, background: Record<string, unknown>): Op {
  return { command: 'slide.setBackground', input: { slide, background } }
}

function styledText(
  slide: unknown,
  o: Box & { text: string; fontSize: number; fontFamily?: string; color?: string; weight?: number },
): Op {
  const op = textOp(slide, o)
  const object = (op.input as { object: Record<string, unknown> }).object
  if (o.fontFamily !== undefined) object['fontFamily'] = o.fontFamily
  if (o.color !== undefined) object['color'] = o.color
  if (o.weight !== undefined) object['fontWeight'] = o.weight
  return op
}

/**
 * Text-heavy slides in a folder font (`fontFamily`): a title, five body
 * boxes of 2–5 lines, a caption in the default face, a page-number field,
 * a coloured or gradient background. `slides` slides; the first exists.
 */
export function presentTextOps(slides: number, fontFamily: string): PresentScene {
  const ops: Op[] = []
  const perSlide: string[][] = []
  for (let s = 1; s < slides; s++) ops.push({ command: 'slide.add', input: {} })
  for (let s = 0; s < slides; s++) {
    const slide = { index: s }
    const ids: string[] = []
    ops.push(
      backgroundOp(
        slide,
        s % 3 === 2
          ? {
              kind: 'linearGradient',
              angleDeg: 20 + s * 13,
              stops: [
                { offset: 0, color: '#f4f1ea' },
                { offset: 1, color: hex(0xc9d6e8 + rnd(s, 0x202020)) },
              ],
            }
          : { kind: 'color', color: hex(0xf2f2f2 - rnd(s + 3, 0x101010)) },
      ),
    )
    const title = { id: `p${s}-title`, x: 120, y: 80, width: 1680, height: 120 }
    ops.push(
      styledText(slide, {
        ...title,
        text: `Chapter ${s + 1}: ${sentence(s * 5 + 1, 5)}`,
        fontSize: 64,
        fontFamily,
        weight: 700,
        color: '#1b2a4a',
      }),
    )
    ids.push(title.id)
    for (let i = 0; i < 5; i++) {
      const lines = 2 + ((s + i) % 4)
      const b = {
        id: `p${s}-body${i}`,
        x: 120 + (i % 2) * 860,
        y: 260 + Math.floor(i / 2) * 260,
        width: 800,
        height: 44 * lines,
      }
      const text = Array.from({ length: lines }, (_, l) =>
        sentence(s * 17 + i * 3 + l, 6 + ((i + l) % 4)),
      ).join('\n')
      ops.push(styledText(slide, { ...b, text, fontSize: 30, fontFamily, color: '#222222' }))
      ids.push(b.id)
    }
    const caption = { id: `p${s}-caption`, x: 120, y: 990, width: 1200, height: 40 }
    ops.push(styledText(slide, { ...caption, text: sentence(s + 40, 9), fontSize: 20 }))
    ids.push(caption.id)
    const number = { id: `p${s}-number`, x: 1700, y: 990, width: 100, height: 40 }
    ops.push(styledText(slide, { ...number, text: '#', fontSize: 20 }))
    ops.push({
      command: 'object.slideNumber.set',
      input: { slide, object: number.id, on: true },
    })
    ids.push(number.id)
    perSlide.push(ids)
  }
  return { ops, perSlide }
}

/**
 * Photo slides: a full-bleed picture, two framed ones and a caption, each
 * slide's pictures distinct where `assets` has enough (12 assets, 12
 * slides: every picture is shown on three slides).
 */
export function presentPhotoOps(slides: number, assets: readonly string[]): PresentScene {
  const ops: Op[] = []
  const perSlide: string[][] = []
  for (let s = 1; s < slides; s++) ops.push({ command: 'slide.add', input: {} })
  for (let s = 0; s < slides; s++) {
    const slide = { index: s }
    const ids: string[] = []
    const bleed = { id: `q${s}-bleed`, x: 0, y: 0, width: 1920, height: 1080 }
    ops.push(imageOp(slide, { ...bleed, assetId: assets[s % assets.length]! }))
    ids.push(bleed.id)
    for (let i = 0; i < 2; i++) {
      const b = { id: `q${s}-photo${i}`, x: 1080 + i * 380, y: 520, width: 340, height: 460 }
      ops.push(imageOp(slide, { ...b, assetId: assets[(s + 4 + i * 4) % assets.length]! }))
      ids.push(b.id)
    }
    const panel = { id: `q${s}-panel`, x: 80, y: 760, width: 900, height: 240 }
    ops.push(rectOp(slide, { ...panel, fill: 0x101820 }))
    ids.push(panel.id)
    const caption = { id: `q${s}-caption`, x: 120, y: 790, width: 820, height: 180 }
    ops.push(
      styledText(slide, {
        ...caption,
        text: `${sentence(s * 3 + 2, 4)}\n${sentence(s * 3 + 7, 8)}`,
        fontSize: 40,
        color: '#ffffff',
      }),
    )
    ids.push(caption.id)
    // A link to slide `link` is added by the driver (it needs the slide ids).
    const link = { id: `q${s}-link`, x: 1700, y: 60, width: 160, height: 100 }
    ops.push(rectOp(slide, { ...link, fill: 0xcc3366 }))
    ids.push(link.id)
    perSlide.push(ids)
  }
  return { ops, perSlide }
}

/**
 * One slide per transition of the DSL (packages/shared deck.ts →
 * SlideTransitionKind): slide 1 has none, then fade, push left / right /
 * up / down, cube, and a magic move (slide 8 holds slide 7's objects, same
 * ids, moved and resized). Each slide: a picture, a title, a text, two
 * rectangles.
 */
export const PRESENT_TRANSITIONS: ReadonlyArray<{
  kind: 'none' | 'fade' | 'push' | 'cube' | 'magic'
  durationMs: number
  direction?: 'left' | 'right' | 'up' | 'down'
}> = [
  { kind: 'none', durationMs: 0 },
  { kind: 'fade', durationMs: 600 },
  { kind: 'push', durationMs: 600, direction: 'left' },
  { kind: 'push', durationMs: 600, direction: 'right' },
  { kind: 'push', durationMs: 600, direction: 'up' },
  { kind: 'push', durationMs: 600, direction: 'down' },
  { kind: 'cube', durationMs: 800 },
  { kind: 'magic', durationMs: 800 },
]

export function presentTransitionOps(assets: readonly string[]): PresentScene {
  const ops: Op[] = []
  const perSlide: string[][] = []
  const n = PRESENT_TRANSITIONS.length
  for (let s = 1; s < n; s++) ops.push({ command: 'slide.add', input: {} })
  for (let s = 0; s < n; s++) {
    const slide = { index: s }
    const t = PRESENT_TRANSITIONS[s]!
    // The magic slide repeats the previous slide's ids: Magic Move pairs them.
    const k = t.kind === 'magic' ? s - 1 : s
    const moved = t.kind === 'magic'
    const ids: string[] = []
    ops.push(backgroundOp(slide, { kind: 'color', color: hex(0x203040 + rnd(s, 0x303030)) }))
    const photo = moved
      ? { id: `t${k}-photo`, x: 900, y: 120, width: 900, height: 600 }
      : { id: `t${k}-photo`, x: 120, y: 300, width: 720, height: 480 }
    ops.push(imageOp(slide, { ...photo, assetId: assets[k % assets.length]! }))
    ids.push(photo.id)
    const title = moved
      ? { id: `t${k}-title`, x: 120, y: 760, width: 1400, height: 110 }
      : { id: `t${k}-title`, x: 120, y: 90, width: 1400, height: 110 }
    ops.push(
      styledText(slide, {
        ...title,
        text: `${t.kind}${t.direction !== undefined ? ` ${t.direction}` : ''}: ${sentence(k + 9, 4)}`,
        fontSize: 72,
        color: '#ffffff',
        weight: 700,
      }),
    )
    ids.push(title.id)
    const body = moved
      ? { id: `t${k}-body`, x: 120, y: 900, width: 1400, height: 120 }
      : { id: `t${k}-body`, x: 900, y: 320, width: 900, height: 300 }
    ops.push(
      styledText(slide, {
        ...body,
        text: [0, 1, 2].map((l) => sentence(k * 7 + l, 7)).join('\n'),
        fontSize: 34,
        color: '#e8eef5',
      }),
    )
    ids.push(body.id)
    for (let i = 0; i < 2; i++) {
      const r = moved
        ? { id: `t${k}-r${i}`, x: 120 + i * 260, y: 120 + i * 200, width: 220, height: 160 }
        : { id: `t${k}-r${i}`, x: 900 + i * 460, y: 700, width: 420, height: 260 }
      ops.push(rectOp(slide, { ...r, fill: 0x3b82f6 + rnd(k * 3 + i, 0x404040) }))
      ids.push(r.id)
    }
    if (t.kind !== 'none')
      ops.push({
        command: 'slide.setTransition',
        input: {
          slide,
          kind: t.kind,
          durationMs: t.durationMs,
          ...(t.direction !== undefined ? { direction: t.direction } : {}),
        },
      })
    perSlide.push(ids)
  }
  return { ops, perSlide }
}

/** A build step of presentBuildOps. */
interface BuildStep {
  object: string
  preset: string
  trigger: 'onEnter' | 'onClick' | 'withPrevious' | 'afterPrevious'
  duration: number
  params?: Record<string, unknown>
}

/**
 * Build animations, four slides:
 *   1. a title and four bullets building in after each other on entry (fadeIn, slideIn);
 *   2. three onClick steps (zoomIn, wipeIn, popIn) — `clicks` says how many clicks it takes;
 *   3. a withPrevious group (scaleIn + rotateIn) after the title, then a moveTo;
 *   4. bounceIn, flipIn, dissolveIn on a picture, a text and a rectangle.
 */
export function presentBuildOps(assets: readonly string[]): PresentScene & { clicks: number[] } {
  const ops: Op[] = []
  const perSlide: string[][] = []
  const clicks: number[] = []
  for (let s = 1; s < 4; s++) ops.push({ command: 'slide.add', input: {} })
  const steps: BuildStep[][] = []
  for (let s = 0; s < 4; s++) {
    const slide = { index: s }
    const ids: string[] = []
    const title = { id: `b${s}-title`, x: 120, y: 80, width: 1680, height: 120 }
    ops.push(
      styledText(slide, {
        ...title,
        text: `Builds ${s + 1}: ${sentence(s + 30, 4)}`,
        fontSize: 64,
        weight: 700,
      }),
    )
    ids.push(title.id)
    const photo = { id: `b${s}-photo`, x: 1100, y: 280, width: 700, height: 470 }
    ops.push(imageOp(slide, { ...photo, assetId: assets[(s + 2) % assets.length]! }))
    ids.push(photo.id)
    const rect = { id: `b${s}-rect`, x: 1100, y: 800, width: 700, height: 180 }
    ops.push(rectOp(slide, { ...rect, fill: 0x2a9d8f }))
    ids.push(rect.id)
    for (let i = 0; i < 4; i++) {
      const b = { id: `b${s}-bullet${i}`, x: 120, y: 280 + i * 170, width: 900, height: 130 }
      ops.push(
        styledText(slide, {
          ...b,
          text: `${sentence(s * 9 + i, 6)}\n${sentence(s * 9 + i + 4, 5)}`,
          fontSize: 34,
        }),
      )
      ids.push(b.id)
    }
    perSlide.push(ids)
    const on = (o: string): string => `b${s}-${o}`
    if (s === 0)
      steps.push([
        { object: on('bullet0'), preset: 'fadeIn', trigger: 'afterPrevious', duration: 0.4 },
        {
          object: on('bullet1'),
          preset: 'slideIn',
          trigger: 'afterPrevious',
          duration: 0.4,
          params: { direction: 'left', distance: 200 },
        },
        { object: on('bullet2'), preset: 'fadeIn', trigger: 'afterPrevious', duration: 0.4 },
        {
          object: on('bullet3'),
          preset: 'slideIn',
          trigger: 'afterPrevious',
          duration: 0.4,
          params: { direction: 'up', distance: 120 },
        },
        { object: on('photo'), preset: 'fadeIn', trigger: 'withPrevious', duration: 0.6 },
      ])
    else if (s === 1)
      steps.push([
        { object: on('photo'), preset: 'zoomIn', trigger: 'onClick', duration: 0.5 },
        { object: on('bullet0'), preset: 'wipeIn', trigger: 'onClick', duration: 0.5 },
        { object: on('rect'), preset: 'popIn', trigger: 'onClick', duration: 0.5 },
      ])
    else if (s === 2)
      steps.push([
        { object: on('bullet0'), preset: 'scaleIn', trigger: 'afterPrevious', duration: 0.5 },
        { object: on('bullet1'), preset: 'rotateIn', trigger: 'withPrevious', duration: 0.5 },
        { object: on('rect'), preset: 'moveTo', trigger: 'afterPrevious', duration: 0.8 },
      ])
    else
      steps.push([
        { object: on('photo'), preset: 'bounceIn', trigger: 'afterPrevious', duration: 0.6 },
        { object: on('bullet0'), preset: 'flipIn', trigger: 'afterPrevious', duration: 0.5 },
        { object: on('rect'), preset: 'dissolveIn', trigger: 'afterPrevious', duration: 0.5 },
      ])
  }
  for (const [s, list] of steps.entries()) {
    clicks.push(list.filter((st) => st.trigger === 'onClick').length)
    for (const st of list)
      ops.push({
        command: 'animation.add',
        input: {
          slide: { index: s },
          object: st.object,
          preset: st.preset,
          trigger: st.trigger,
          duration: st.duration,
          ...(st.params !== undefined ? { params: st.params } : {}),
        },
      })
  }
  return { ops, perSlide, clicks }
}

/**
 * A text slide, a full-bleed autoplaying video, a text slide. With `loop`
 * the video plays that range of its file over and over (trimmed, looped:
 * present.video.loop).
 */
export function presentVideoOps(
  videoAsset: string,
  opts: { loop?: { trimStart: number; trimEnd: number } } = {},
): PresentScene {
  const ops: Op[] = []
  const perSlide: string[][] = []
  for (let s = 1; s < 3; s++) ops.push({ command: 'slide.add', input: {} })
  for (let s = 0; s < 3; s++) {
    const slide = { index: s }
    const ids: string[] = []
    if (s === 1) {
      ops.push({
        command: 'object.create',
        input: {
          slide,
          id: 'v1-video',
          object: {
            type: 'video',
            assetId: videoAsset,
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
            rotation: 0,
            opacity: 1,
            autoplay: true,
            muted: true,
            ...(opts.loop !== undefined
              ? { loop: true, trimStart: opts.loop.trimStart, trimEnd: opts.loop.trimEnd }
              : {}),
          },
        },
      })
      ids.push('v1-video')
    }
    const title = { id: `v${s}-title`, x: 120, y: 80, width: 1680, height: 120 }
    ops.push(
      styledText(slide, {
        ...title,
        text: `Video deck ${s + 1}: ${sentence(s + 50, 4)}`,
        fontSize: 64,
        weight: 700,
        color: s === 1 ? '#ffffff' : '#111111',
      }),
    )
    ids.push(title.id)
    perSlide.push(ids)
  }
  return { ops, perSlide }
}
