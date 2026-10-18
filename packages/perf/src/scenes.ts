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

export function textOp(slide: unknown, o: Box & { text: string; fontSize: number }): Op {
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
  const probeText = { id: 'probe-text', x: 300, y: 420, width: 520, height: 120 }
  add(
    textOp(slide, { ...probeText, text: 'Probe text box for typing and dragging', fontSize: 40 }),
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
