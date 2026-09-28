/**
 * commands/src/commands/transforms.ts — the editor's transforms as
 * commands (A2.5): resize, rotate, flip, align to the slide and crop.
 *
 * `object.update` can set the raw fields (x / y / width / height, rotation
 * in radians, flipH / flipV, imageRect in absolute slide px); these
 * commands carry the rules the editor applies on top, so a person dragging
 * a handle and an agent asking for "20 % wider" get the same result:
 *   - a resize keeps a chosen point of the object fixed, along its own
 *     (rotated) axes, and scales a cropped picture with its frame;
 *   - a flip negates the rotation, so a rotated object mirrors in place;
 *   - alignment to the slide uses what is visible (the rotated outline);
 *   - a crop is expressed relative to the frame.
 * Geometry: ../geometry.ts (shared with the editor's handles).
 */

import { z } from 'zod'
import type * as Y from 'yjs'
import { bulkUpdateObjects, translateObjects, type BulkUpdate } from '@narrative/slide-model'
import { SLIDE_HEIGHT, SLIDE_WIDTH } from '@narrative/shared'
import type { PathAnchor, SlideObject, SlideObjectPatch } from '@narrative/shared'
import { defineCommand } from '../registry.js'
import { CommandError } from '../errors.js'
import {
  ObjectIdSchema,
  ObjectIdsSchema,
  SlideRefSchema,
  objectsOf,
  requireDeck,
  requireObjects,
  resolveSlide,
} from '../refs.js'
import {
  ANCHORS,
  placeResized,
  scaleCrop,
  visualBounds,
  type Frame,
  type Rect,
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

const EmptyOutput = z.object({})
const Finite = z.number().finite()
const Size = z.number().finite().min(1).max(100_000)

function num(map: Y.Map<unknown>, key: string, fallback = 0): number {
  const v = map.get(key)
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function frameOf(map: Y.Map<unknown>): Frame {
  return {
    x: num(map, 'x'),
    y: num(map, 'y'),
    width: num(map, 'width'),
    height: num(map, 'height'),
    rotation: num(map, 'rotation'),
  }
}

function cropOf(map: Y.Map<unknown>): Rect | undefined {
  const r = map.get('imageRect') as Partial<Rect> | undefined
  if (r === undefined || r === null) return undefined
  if (
    typeof r.x !== 'number' ||
    typeof r.y !== 'number' ||
    typeof r.width !== 'number' ||
    typeof r.height !== 'number'
  )
    return undefined
  return { x: r.x, y: r.y, width: r.width, height: r.height }
}

/**
 * Lines, arrows and paths draw from their own points (`p1` / `p2`,
 * `anchors`, relative to x / y), not from width / height, which only track
 * the points' bounding box. Resizing one therefore scales its points about
 * the box's top-left, or the box would change while nothing visible does.
 * Stroke width is not scaled (a thicker outline is not a bigger shape).
 */
function scaledGeometry(
  map: Y.Map<unknown>,
  sx: number,
  sy: number,
): Record<string, unknown> | undefined {
  const type = map.get('type')
  const point = (p: unknown): { x: number; y: number } | undefined => {
    const q = p as { x?: unknown; y?: unknown } | undefined
    return q !== undefined && typeof q.x === 'number' && typeof q.y === 'number'
      ? { x: q.x * sx, y: q.y * sy }
      : undefined
  }
  if (type === 'line' || type === 'arrow') {
    const p1 = point(map.get('p1'))
    const p2 = point(map.get('p2'))
    return p1 !== undefined && p2 !== undefined ? { p1, p2 } : undefined
  }
  if (type === 'path') {
    const anchors = map.get('anchors')
    if (!Array.isArray(anchors)) return undefined
    return {
      anchors: (anchors as PathAnchor[]).map((a) => {
        const next: PathAnchor = { ...a, x: a.x * sx, y: a.y * sy }
        const cpIn = point(a.cpIn)
        const cpOut = point(a.cpOut)
        if (cpIn !== undefined) next.cpIn = cpIn
        if (cpOut !== undefined) next.cpOut = cpOut
        return next
      }),
    }
  }
  return undefined
}

function patchFor(id: string, patch: Record<string, unknown>): BulkUpdate {
  return { id, patch: patch as SlideObjectPatch<SlideObject> }
}

/** A side scaled with the other one; a real side never collapses below 1 px. */
const derivedSide = (side: number, factor: number): number =>
  side === 0 ? 0 : Math.max(1, side * factor)

const toRadians = (deg: number): number => (deg * Math.PI) / 180
const toDegrees = (rad: number): number => (rad * 180) / Math.PI

// ---------------------------------------------------------------------------
// object.resize
// ---------------------------------------------------------------------------

export const objectResize = defineCommand({
  ...objectEditor,
  id: 'object.resize',
  title: 'Resize object',
  description:
    'Resize one object. Give `width` and/or `height` (slide px) and the `anchor` that stays put (default ' +
    "topLeft; center grows it evenly on all sides) — measured along the object's own axes, so a rotated object " +
    'resizes like dragging its handle. `keepAspect` derives the missing side from the current proportions (with ' +
    'only one side given it defaults to true when the object is aspect-locked). Alternatively give the whole new ' +
    'box, `x`, `y`, `width` and `height` (top-left of the unrotated box), instead of an anchor. A cropped image ' +
    'keeps showing the same part of the picture: the crop scales with the frame. A line, arrow or path scales its ' +
    'points (not its stroke width). Text reflows, it is not scaled.',
  input: z
    .strictObject({
      slide: SlideRefSchema,
      object: ObjectIdSchema,
      width: Size.optional(),
      height: Size.optional(),
      anchor: z.enum(ANCHORS as [string, ...string[]]).optional(),
      keepAspect: z.boolean().optional(),
      x: Finite.optional().describe('New top-left x (with y, width and height; no anchor)'),
      y: Finite.optional().describe('New top-left y (with x, width and height; no anchor)'),
    })
    .superRefine((v, c) => {
      if (v.width === undefined && v.height === undefined)
        c.addIssue({ code: 'custom', message: 'Give width and/or height', path: ['width'] })
      const explicit = v.x !== undefined || v.y !== undefined
      if (explicit) {
        if (
          v.x === undefined ||
          v.y === undefined ||
          v.width === undefined ||
          v.height === undefined
        )
          c.addIssue({
            code: 'custom',
            message: 'A new box needs x, y, width and height together',
            path: ['x'],
          })
        if (v.anchor !== undefined || v.keepAspect !== undefined)
          c.addIssue({
            code: 'custom',
            message:
              'Give either the new box (x, y, width, height) or an anchor / keepAspect, not both',
            path: ['anchor'],
          })
      }
    }),
  output: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
  idempotent: true,
  implementedWith: ['bulkUpdateObjects'],
  examples: [
    {
      title: 'Make a rectangle 600 px wide, growing to the right',
      input: { slide: 's1', object: 'r1', width: 600 },
    },
    {
      title: 'Scale an image to 400 px wide around its centre, keeping proportions',
      input: { slide: 's1', object: 'img1', width: 400, anchor: 'center', keepAspect: true },
    },
    {
      title: 'Set the exact box',
      input: { slide: 's1', object: 'e1', x: 100, y: 120, width: 300, height: 300 },
    },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const slide = resolveSlide(deck, input.slide)
    const objects = objectsOf(deck, slide)
    const map = requireObjects(objects, [input.object], slide.id).get(input.object)!
    const from = frameOf(map)

    let box: Rect
    if (input.x !== undefined && input.y !== undefined) {
      box = { x: input.x, y: input.y, width: input.width!, height: input.height! }
    } else {
      const keepAspect =
        input.keepAspect ??
        ((input.width === undefined || input.height === undefined) &&
          map.get('aspectLocked') === true)
      // A side nobody asked to change keeps its value — even 0, the height of
      // a horizontal line; a side derived from the proportions scales by the
      // same factor as the given one (0 stays 0).
      let width = input.width ?? from.width
      let height = input.height ?? from.height
      if (keepAspect) {
        if (input.width !== undefined && input.height === undefined && from.width > 0)
          height = derivedSide(from.height, input.width / from.width)
        else if (input.height !== undefined && input.width === undefined && from.height > 0)
          width = derivedSide(from.width, input.height / from.height)
      }
      const anchor = (input.anchor ?? 'topLeft') as (typeof ANCHORS)[number]
      box = { ...placeResized(from, width, height, anchor), width, height }
    }

    const patch: Record<string, unknown> = { ...box }
    const crop = map.get('type') === 'image' ? cropOf(map) : undefined
    if (crop !== undefined) patch['imageRect'] = scaleCrop(crop, from, box)
    Object.assign(
      patch,
      scaledGeometry(
        map,
        from.width === 0 ? 1 : box.width / from.width,
        from.height === 0 ? 1 : box.height / from.height,
      ),
    )
    bulkUpdateObjects(objects, [patchFor(input.object, patch)])
    return box
  },
})

// ---------------------------------------------------------------------------
// object.rotate
// ---------------------------------------------------------------------------

export const objectRotate = defineCommand({
  ...objectEditor,
  id: 'object.rotate',
  title: 'Rotate objects',
  description:
    'Rotate objects about their own centres, in DEGREES (clockwise positive): `degrees` is the new angle, or with ' +
    '`relative: true` an amount added to the current one. A cropped image turns with its crop. object.update ' +
    'sets the raw `rotation`, which is in radians.',
  input: z.strictObject({
    slide: SlideRefSchema,
    objects: ObjectIdsSchema,
    degrees: Finite,
    relative: z.boolean().optional(),
  }),
  output: z.object({
    rotations: z
      .array(z.object({ object: z.string(), degrees: z.number() }))
      .describe('The resulting angle of each object'),
  }),
  implementedWith: ['bulkUpdateObjects'],
  examples: [
    {
      title: 'Tilt a rectangle by 15 degrees',
      input: { slide: 's1', objects: ['r1'], degrees: 15 },
    },
    {
      title: 'Turn two objects a further 90 degrees',
      input: { slide: 's1', objects: ['r1', 'e1'], degrees: 90, relative: true },
    },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const slide = resolveSlide(deck, input.slide)
    const objects = objectsOf(deck, slide)
    const maps = requireObjects(objects, input.objects, slide.id)
    const ids = [...new Set(input.objects)]
    const rotations = ids.map((id) => {
      const current = num(maps.get(id)!, 'rotation')
      const next =
        input.relative === true ? current + toRadians(input.degrees) : toRadians(input.degrees)
      return { id, next }
    })
    bulkUpdateObjects(
      objects,
      rotations.map((r) => patchFor(r.id, { rotation: r.next })),
    )
    return { rotations: rotations.map((r) => ({ object: r.id, degrees: toDegrees(r.next) })) }
  },
})

// ---------------------------------------------------------------------------
// object.flip
// ---------------------------------------------------------------------------

export const objectFlip = defineCommand({
  ...objectEditor,
  id: 'object.flip',
  title: 'Flip objects',
  description:
    'Mirror objects in place: `horizontal` flips left-right, `vertical` top-bottom. A flip toggles (flipping twice ' +
    'restores the original). A rotated object mirrors on the slide, as in the editor: its angle is negated along ' +
    'with the flip, so flipping both ways equals a 180 degree turn. For text the letters mirror too.',
  input: z.strictObject({
    slide: SlideRefSchema,
    objects: ObjectIdsSchema,
    axis: z.enum(['horizontal', 'vertical']),
  }),
  output: EmptyOutput,
  implementedWith: ['bulkUpdateObjects'],
  examples: [
    {
      title: 'Mirror an arrow left-right',
      input: { slide: 's1', objects: ['r1'], axis: 'horizontal' },
    },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const slide = resolveSlide(deck, input.slide)
    const objects = objectsOf(deck, slide)
    const maps = requireObjects(objects, input.objects, slide.id)
    const key = input.axis === 'horizontal' ? 'flipH' : 'flipV'
    // M · R(θ) = R(-θ) · M: toggling the local mirror and negating the
    // angle mirrors the object about its own centre on the slide.
    bulkUpdateObjects(
      objects,
      [...new Set(input.objects)].map((id) => {
        const map = maps.get(id)!
        return patchFor(id, {
          [key]: map.get(key) === true ? undefined : true,
          rotation: -num(map, 'rotation'),
        })
      }),
    )
    return {}
  },
})

// ---------------------------------------------------------------------------
// object.alignToSlide
// ---------------------------------------------------------------------------

export const objectAlignToSlide = defineCommand({
  ...objectEditor,
  id: 'object.alignToSlide',
  title: 'Align to slide',
  description:
    'Move objects to an edge or the centre of the slide (1920 x 1080): `horizontal` left | center | right, ' +
    '`vertical` top | middle | bottom (give one or both). Several objects move together as a block — their ' +
    'combined outline is aligned and their layout among themselves stays; align them to each other with ' +
    "object.align. What is aligned is what you see: a rotated object's rotated outline touches the edge. A crop " +
    'moves with its image.',
  input: z
    .strictObject({
      slide: SlideRefSchema,
      objects: ObjectIdsSchema,
      horizontal: z.enum(['left', 'center', 'right']).optional(),
      vertical: z.enum(['top', 'middle', 'bottom']).optional(),
    })
    .refine((v) => v.horizontal !== undefined || v.vertical !== undefined, {
      message: 'Give horizontal and/or vertical',
    }),
  output: z
    .object({ x: z.number(), y: z.number() })
    .describe("Where the block's visible top-left ends up"),
  idempotent: true,
  implementedWith: ['translateObjects'],
  examples: [
    {
      title: 'Centre a title horizontally',
      input: { slide: 's1', objects: ['t1'], horizontal: 'center' },
    },
    {
      title: 'Put two objects in the bottom-right corner, as a block',
      input: { slide: 's1', objects: ['r1', 'e1'], horizontal: 'right', vertical: 'bottom' },
    },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const slide = resolveSlide(deck, input.slide)
    const objects = objectsOf(deck, slide)
    const maps = requireObjects(objects, input.objects, slide.id)
    const ids = [...new Set(input.objects)]
    const boxes = ids.map((id) => visualBounds(frameOf(maps.get(id)!)))
    const left = Math.min(...boxes.map((b) => b.x))
    const top = Math.min(...boxes.map((b) => b.y))
    const right = Math.max(...boxes.map((b) => b.x + b.width))
    const bottom = Math.max(...boxes.map((b) => b.y + b.height))
    const w = right - left
    const h = bottom - top
    const targetX =
      input.horizontal === 'left'
        ? 0
        : input.horizontal === 'right'
          ? SLIDE_WIDTH - w
          : input.horizontal === 'center'
            ? Math.round((SLIDE_WIDTH - w) / 2)
            : left
    const targetY =
      input.vertical === 'top'
        ? 0
        : input.vertical === 'bottom'
          ? SLIDE_HEIGHT - h
          : input.vertical === 'middle'
            ? Math.round((SLIDE_HEIGHT - h) / 2)
            : top
    const dx = targetX - left
    const dy = targetY - top
    translateObjects(
      objects,
      ids.map((id) => ({ id, dx, dy })),
    )
    return { x: targetX, y: targetY }
  },
})

// ---------------------------------------------------------------------------
// object.crop.set
// ---------------------------------------------------------------------------

const PictureSchema = z
  .strictObject({ x: Finite, y: Finite, width: Size, height: Size })
  .describe("The whole picture's box relative to the frame's top-left, slide px")

const CropOpSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('set'), picture: PictureSchema }),
  z.strictObject({ op: z.literal('pan'), dx: Finite, dy: Finite }),
  z.strictObject({
    op: z.literal('zoom'),
    factor: z.number().finite().min(0.01).max(100),
    around: z
      .strictObject({ x: Finite, y: Finite })
      .optional()
      .describe('Frame-relative point that stays put (default: the frame centre)'),
  }),
  z.strictObject({
    op: z.literal('rotate'),
    degrees: Finite.describe("The picture's angle inside the frame, clockwise"),
    relative: z.boolean().optional(),
  }),
  z.strictObject({ op: z.literal('reset') }),
])

type CropOp = z.infer<typeof CropOpSchema>

/** The picture box (frame-relative) after `op`, or null for "no crop" (the picture fills the frame). */
function applyCropOp(frame: Rect, current: Rect, op: CropOp): Rect | null {
  switch (op.op) {
    case 'reset':
      return null
    case 'rotate':
      return current
    case 'set':
      return op.picture
    case 'pan':
      return { ...current, x: current.x + op.dx, y: current.y + op.dy }
    case 'zoom': {
      const px = op.around?.x ?? frame.width / 2
      const py = op.around?.y ?? frame.height / 2
      return {
        x: px - (px - current.x) * op.factor,
        y: py - (py - current.y) * op.factor,
        width: current.width * op.factor,
        height: current.height * op.factor,
      }
    }
  }
}

export const objectCropSet = defineCommand({
  ...objectEditor,
  id: 'object.crop.set',
  title: 'Crop image',
  description:
    'Change which part of a picture an image object shows; the object (its frame) stays where it is. In frame-' +
    "relative px (0,0 = the frame's top-left): `set` places the whole picture at `picture` {x, y, width, height} " +
    '(e.g. width 2x the frame = zoomed in 2x); `pan` shifts the picture by dx/dy; `zoom` scales it by `factor` ' +
    'around a point (default the frame centre; > 1 zooms in); `rotate` turns the picture inside the frame ' +
    '(degrees, or `relative`); `reset` removes the crop and the turn so the picture fills the frame. To change the frame itself while keeping the picture put, set x/y/width/height together with the ' +
    'current imageRect in one object.update.',
  input: z.strictObject({ slide: SlideRefSchema, image: ObjectIdSchema, crop: CropOpSchema }),
  output: z.object({
    picture: PictureSchema.nullable().describe('The resulting picture box, null = no crop'),
    degrees: z.number().describe("The picture's angle inside the frame"),
  }),
  implementedWith: ['bulkUpdateObjects'],
  examples: [
    {
      title: 'Zoom into the centre 1.5x',
      input: { slide: 's1', image: 'img1', crop: { op: 'zoom', factor: 1.5 } },
    },
    {
      title: 'Show more of the top of the picture',
      input: { slide: 's1', image: 'img1', crop: { op: 'pan', dx: 0, dy: 80 } },
    },
    {
      title: 'Show the left half of the picture, frame unchanged (img1 is 400 x 300)',
      input: {
        slide: 's1',
        image: 'img1',
        crop: { op: 'set', picture: { x: 0, y: -150, width: 800, height: 600 } },
      },
    },
    {
      title: 'Turn the picture 5 degrees inside its frame',
      input: { slide: 's1', image: 'img1', crop: { op: 'rotate', degrees: 5 } },
    },
    { title: 'Remove the crop', input: { slide: 's1', image: 'img1', crop: { op: 'reset' } } },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const slide = resolveSlide(deck, input.slide)
    const objects = objectsOf(deck, slide)
    const map = requireObjects(objects, [input.image], slide.id).get(input.image)!
    if (map.get('type') !== 'image') {
      throw new CommandError(
        'conflict',
        `object '${input.image}' is not an image; only images can be cropped`,
      )
    }
    const frame = frameOf(map)
    const absolute = cropOf(map) ?? {
      x: frame.x,
      y: frame.y,
      width: frame.width,
      height: frame.height,
    }
    const current = { ...absolute, x: absolute.x - frame.x, y: absolute.y - frame.y }
    const next = applyCropOp(frame, current, input.crop)
    const turn = num(map, 'imageRotation')
    const nextTurn =
      input.crop.op === 'reset'
        ? 0
        : input.crop.op === 'rotate'
          ? input.crop.relative === true
            ? turn + toRadians(input.crop.degrees)
            : toRadians(input.crop.degrees)
          : turn
    const patch: Record<string, unknown> =
      next === null
        ? { imageRect: undefined }
        : { imageRect: { ...next, x: frame.x + next.x, y: frame.y + next.y } }
    if (nextTurn !== turn) patch['imageRotation'] = nextTurn === 0 ? undefined : nextTurn
    bulkUpdateObjects(objects, [patchFor(input.image, patch)])
    return { picture: next, degrees: toDegrees(nextTurn) }
  },
})

export const transformCommands = [
  objectResize,
  objectRotate,
  objectFlip,
  objectAlignToSlide,
  objectCropSet,
]
