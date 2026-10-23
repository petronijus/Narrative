/**
 * commands/src/commands/paths.ts — point-drawn objects (A2.6): drawing a
 * path, turning a shape into one, editing its points, moving a line's ends.
 *
 * Paths, lines and arrows draw from their own points (`anchors`, `p1` /
 * `p2`, relative to the object's box), and the box is only their bounding
 * box. These commands take points in SLIDE px — where they are drawn — and
 * work out the box: the object keeps its rotation and mirroring, and every
 * point lands exactly where it was given. That is what the pen tool, the
 * point editor and the line handles need, and what an agent can reason
 * about without converting frames. Geometry: ../geometry.ts.
 */

import { z } from 'zod'
import type * as Y from 'yjs'
import {
  bulkUpdateObjects,
  createObjectOfType,
  replaceObject,
  yMapToPlainObject,
} from '@narrative/slide-model'
import type { PathObject, SlideObject, SlideObjectPatch } from '@narrative/shared'
import { MAX_PATH_ANCHORS, objectCreateInputSchema } from '@narrative/shared'
import { defineCommand } from '../registry.js'
import { CommandError } from '../errors.js'
import {
  ObjectIdSchema,
  SlideRefSchema,
  objectsOf,
  requireDeck,
  requireObjects,
  resolveSlide,
} from '../refs.js'
import {
  anchorsOnSlide,
  fitAnchors,
  localToSlide,
  shapeOutline,
  type OutlineShape,
  type PathPoint,
  type Placement,
} from '../geometry.js'

const objectEditor = {
  domain: 'object',
  role: 'editor',
  effects: ['doc'],
  undo: 'undoable',
  confirm: 'never',
  hosts: ['browser', 'server'],
  acceptsComponent: true,
} as const

const Finite = z.number().finite()
const SlidePoint = z.strictObject({ x: Finite, y: Finite })
const Box = { x: z.number(), y: z.number(), width: z.number(), height: z.number() }

const SlideAnchorSchema = z.strictObject({
  x: Finite,
  y: Finite,
  cpIn: SlidePoint.optional().describe('Incoming bezier handle, relative to the anchor'),
  cpOut: SlidePoint.optional().describe(
    'Outgoing bezier handle, relative to the anchor. A segment curves only when its start has cpOut AND its end cpIn',
  ),
  moveTo: z.boolean().optional().describe('Start a new subpath here (not joined to the previous)'),
})

const SlideAnchorsSchema = z
  .array(SlideAnchorSchema)
  .min(2)
  .max(MAX_PATH_ANCHORS)
  .describe('Points in slide px, in drawing order')

function num(map: Y.Map<unknown>, key: string): number {
  const v = map.get(key)
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function placementOf(map: Y.Map<unknown>): Placement {
  return {
    x: num(map, 'x'),
    y: num(map, 'y'),
    width: num(map, 'width'),
    height: num(map, 'height'),
    rotation: num(map, 'rotation'),
    flipH: map.get('flipH') === true,
    flipV: map.get('flipV') === true,
  }
}

function patchFor(id: string, patch: Record<string, unknown>) {
  return { id, patch: patch as SlideObjectPatch<SlideObject> }
}

/** An anchor as parsed input or as computed: optional fields may be present but undefined. */
type LooseAnchor = {
  x: number
  y: number
  cpIn?: { x: number; y: number } | undefined
  cpOut?: { x: number; y: number } | undefined
  moveTo?: boolean | undefined
}

/** The stored anchors carry only what is set (the schemas are exact-optional). */
function cleanAnchor(a: LooseAnchor): PathPoint {
  const out: PathPoint = { x: a.x, y: a.y }
  if (a.cpIn !== undefined) out.cpIn = a.cpIn
  if (a.cpOut !== undefined) out.cpOut = a.cpOut
  if (a.moveTo === true) out.moveTo = true
  return out
}

// ---------------------------------------------------------------------------
// object.path.create
// ---------------------------------------------------------------------------

const PathStyleSchema = objectCreateInputSchema('path')
  .omit({ x: true, y: true, width: true, height: true, anchors: true })
  .describe(
    'Other path properties (stroke, fill, closed, name, rotation, …); omitted = editor defaults',
  )

export const objectPathCreate = defineCommand({
  ...objectEditor,
  id: 'object.path.create',
  title: 'Draw a path',
  description:
    'Draw a free-form path (what the pen tool makes) through `anchors` in slide px, each optionally with ' +
    'bezier handles relative to it; the box is fitted around it. `object` sets the other properties: `closed: ' +
    'true` joins the last point to the first and lets `fill` show; with a `rotation` (radians) the points ' +
    'still land where given. A straight two-point line: object.create with type line / arrow.',
  input: z.strictObject({
    slide: SlideRefSchema,
    anchors: SlideAnchorsSchema,
    object: PathStyleSchema.optional(),
  }),
  output: z.object({ objectId: z.string(), ...Box }),
  implementedWith: ['createObjectOfType'],
  examples: [
    {
      title: 'A closed triangle with a red fill',
      input: {
        slide: 's3',
        anchors: [
          { x: 960, y: 200 },
          { x: 1160, y: 540 },
          { x: 760, y: 540 },
        ],
        object: { closed: true, fill: '#e03c31', stroke: '#e03c31', strokeWidth: 0 },
      },
    },
    {
      title: 'An S-curve stroke',
      input: {
        slide: 's3',
        anchors: [
          { x: 300, y: 700, cpOut: { x: 150, y: -200 } },
          { x: 700, y: 700, cpIn: { x: -150, y: 200 } },
        ],
        object: { stroke: '#1b2a4a', strokeWidth: 6 },
      },
    },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const objects = objectsOf(deck, resolveSlide(deck, input.slide))
    const style = input.object ?? {}
    const { box, anchors } = fitAnchors(
      input.anchors.map(cleanAnchor),
      {
        rotation: style.rotation ?? 0,
        ...(style.flipH !== undefined ? { flipH: style.flipH } : {}),
        ...(style.flipV !== undefined ? { flipV: style.flipV } : {}),
      },
      style.closed === true,
    )
    const created = createObjectOfType(objects, 'path', {
      ...style,
      ...box,
      anchors: anchors.map(cleanAnchor),
    } as Partial<PathObject>)
    return { objectId: created.id, ...box }
  },
})

// ---------------------------------------------------------------------------
// object.path.fromShape
// ---------------------------------------------------------------------------

const CONVERTIBLE = new Set(['rectangle', 'ellipse', 'triangle', 'polygon'])

/** Properties every object type shares; they carry over to the path unchanged. */
const BASE_KEYS = [
  'x',
  'y',
  'width',
  'height',
  'rotation',
  'opacity',
  'name',
  'locked',
  'shadow',
  'blur',
  'groupId',
  'hyperlink',
  'aspectLocked',
  'flipH',
  'flipV',
] as const

/** Fill and stroke carry over; `strokeDash` is spelled `dash` on a path. */
const PAINT_KEYS = ['fill', 'fillAlpha', 'fillStyle', 'strokeAlpha'] as const

export const objectPathFromShape = defineCommand({
  ...objectEditor,
  id: 'object.path.fromShape',
  title: 'Convert a shape to a path',
  description:
    'Turn a rectangle (rounded corners too), ellipse, triangle or polygon into an editable path with the same ' +
    'outline, so its points can be moved (object.path.setAnchors). Same object: id, stacking place, ' +
    'animations, group, fill (gradients and images too), stroke, shadow, rotation and mirroring; shape-only ' +
    'settings (corner radius, sides) become the path.',
  input: z.strictObject({ slide: SlideRefSchema, object: ObjectIdSchema }),
  output: z.object({ objectId: z.string(), anchorCount: z.number() }),
  implementedWith: ['replaceObject'],
  examples: [
    {
      title: 'Make the fixture rectangle editable point by point',
      input: { slide: 's1', object: 'r1' },
    },
    { title: 'Convert the ellipse', input: { slide: 's1', object: 'e1' } },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const slide = resolveSlide(deck, input.slide)
    const objects = objectsOf(deck, slide)
    const map = requireObjects(objects, [input.object], slide.id).get(input.object)!
    const source = yMapToPlainObject(map) as unknown as Record<string, unknown>
    const type = source['type']
    if (typeof type !== 'string' || !CONVERTIBLE.has(type)) {
      throw new CommandError(
        'conflict',
        `object '${input.object}' is a ${String(type)}; only rectangles, ellipses, triangles and polygons ` +
          'convert to a path',
      )
    }
    const at = placementOf(map)
    const outline = shapeOutline(
      {
        type,
        cornerRadius: source['cornerRadius'],
        sides: source['sides'],
      } as OutlineShape,
      at.width,
      at.height,
    )
    // Refit around what the outline draws (an inscribed polygon does not
    // fill its box) — through the slide, so every point stays where it is.
    const { box, anchors } = fitAnchors(anchorsOnSlide(at, outline), at, true)
    const next: Record<string, unknown> = { id: input.object, type: 'path', closed: true }
    for (const key of [...BASE_KEYS, ...PAINT_KEYS]) {
      if (source[key] !== undefined) next[key] = source[key]
    }
    Object.assign(next, box, { anchors: anchors.map(cleanAnchor) })
    // A path always has a stroke; a shape without one gets an invisible one.
    next['stroke'] = source['stroke'] ?? 0x000000
    next['strokeWidth'] = source['strokeWidth'] ?? 0
    if (source['strokeDash'] === true) next['dash'] = true
    replaceObject(objects, next as unknown as PathObject)
    return { objectId: input.object, anchorCount: anchors.length }
  },
})

// ---------------------------------------------------------------------------
// object.path.setAnchors
// ---------------------------------------------------------------------------

export const objectPathSetAnchors = defineCommand({
  ...objectEditor,
  id: 'object.path.setAnchors',
  idempotent: true,
  title: 'Set path points',
  description:
    "Edit a path's points in slide px: `moves` puts chosen anchors (by index in the path's `anchors`) at new " +
    'points, their handles and the other anchors staying where they are drawn — the way to move one corner, ' +
    'of a rotated or mirrored path too; or `anchors` replaces them all (handles relative to their anchor). ' +
    'The box is refitted; rotation and mirroring are kept. Stored anchors are relative to the box: unrotated ' +
    'and unmirrored, an anchor sits at (x + anchor.x, y + anchor.y). Shapes: object.path.fromShape first.',
  input: z
    .strictObject({
      slide: SlideRefSchema,
      object: ObjectIdSchema,
      anchors: SlideAnchorsSchema.optional(),
      moves: z
        .array(z.strictObject({ index: z.number().int().min(0), x: Finite, y: Finite }))
        .min(1)
        .max(MAX_PATH_ANCHORS)
        .optional(),
    })
    .refine((v) => (v.anchors === undefined) !== (v.moves === undefined), {
      message: 'Give either `anchors` or `moves`',
    }),
  output: z.object(Box),
  implementedWith: ['bulkUpdateObjects'],
  examples: [
    {
      title: 'Lift the middle point of the fixture curve to y 600',
      input: { slide: 's2', object: 'pa1', moves: [{ index: 1, x: 1400, y: 600 }] },
    },
    {
      title: 'Replace all points: a straight three-point zigzag',
      input: {
        slide: 's2',
        object: 'pa1',
        anchors: [
          { x: 1200, y: 800 },
          { x: 1400, y: 650 },
          { x: 1600, y: 800 },
        ],
      },
    },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const slide = resolveSlide(deck, input.slide)
    const objects = objectsOf(deck, slide)
    const map = requireObjects(objects, [input.object], slide.id).get(input.object)!
    if (map.get('type') !== 'path') {
      throw new CommandError(
        'conflict',
        `object '${input.object}' is not a path; convert a shape with object.path.fromShape first`,
      )
    }
    const at = placementOf(map)
    let onSlide: LooseAnchor[]
    if (input.anchors !== undefined) {
      onSlide = input.anchors
    } else {
      const stored = map.get('anchors')
      const current = anchorsOnSlide(at, Array.isArray(stored) ? (stored as PathPoint[]) : [])
      for (const m of input.moves ?? []) {
        const a = current[m.index]
        if (a === undefined) {
          throw new CommandError(
            'invalid_input',
            `the path has ${current.length} anchors; there is no index ${m.index}`,
            { issues: [{ path: ['moves'], message: `index ${m.index} is out of range` }] },
          )
        }
        current[m.index] = { ...a, x: m.x, y: m.y }
      }
      onSlide = current
    }
    const { box, anchors } = fitAnchors(onSlide.map(cleanAnchor), at, map.get('closed') === true)
    bulkUpdateObjects(objects, [
      patchFor(input.object, { ...box, anchors: anchors.map(cleanAnchor) }),
    ])
    return box
  },
})

// ---------------------------------------------------------------------------
// object.line.setEndpoints
// ---------------------------------------------------------------------------

export const objectLineSetEndpoints = defineCommand({
  ...objectEditor,
  id: 'object.line.setEndpoints',
  idempotent: true,
  title: 'Move line ends',
  description:
    'Move the start (`p1`) and/or end (`p2`) of a line or arrow to points in slide px; an omitted end stays ' +
    'where it is drawn. The box is refitted; rotation and mirroring stay. Stored p1 / p2 are relative to the ' +
    'box: unrotated, an end sits at (x + p.x, y + p.y). Returns both ends in slide px.',
  input: z
    .strictObject({
      slide: SlideRefSchema,
      object: ObjectIdSchema,
      p1: SlidePoint.optional(),
      p2: SlidePoint.optional(),
    })
    .refine((v) => v.p1 !== undefined || v.p2 !== undefined, { message: 'Give p1 and/or p2' }),
  output: z.object({ p1: SlidePoint, p2: SlidePoint }),
  implementedWith: ['bulkUpdateObjects'],
  examples: [
    {
      title: 'Point the fixture line up to the right',
      input: { slide: 's2', object: 'ln1', p2: { x: 500, y: 700 } },
    },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const slide = resolveSlide(deck, input.slide)
    const objects = objectsOf(deck, slide)
    const map = requireObjects(objects, [input.object], slide.id).get(input.object)!
    const type = map.get('type')
    if (type !== 'line' && type !== 'arrow') {
      throw new CommandError(
        'conflict',
        `object '${input.object}' is a ${String(type)}, not a line or arrow`,
      )
    }
    const at = placementOf(map)
    const point = (key: 'p1' | 'p2') => {
      const p = map.get(key) as { x?: unknown; y?: unknown } | undefined
      return {
        x: typeof p?.x === 'number' ? p.x : 0,
        y: typeof p?.y === 'number' ? p.y : 0,
      }
    }
    const p1 = input.p1 ?? localToSlide(at, point('p1'))
    const p2 = input.p2 ?? localToSlide(at, point('p2'))
    const { box, anchors } = fitAnchors([p1, p2], at)
    const [l1, l2] = anchors as [PathPoint, PathPoint]
    bulkUpdateObjects(objects, [
      patchFor(input.object, { ...box, p1: { x: l1.x, y: l1.y }, p2: { x: l2.x, y: l2.y } }),
    ])
    return { p1, p2 }
  },
})

export const pathCommands = [
  objectPathCreate,
  objectPathFromShape,
  objectPathSetAnchors,
  objectLineSetEndpoints,
]
