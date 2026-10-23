/**
 * commands/src/commands/objects.ts — the `object.*` domain: arrangement,
 * duplication and geometry. Create/update/delete and the property commands
 * validate against the shared object schemas.
 */

import { z } from 'zod'
import {
  alignObjects,
  copyObjectsTo,
  distributeObjects,
  duplicateObjects,
  groupObjects,
  moveObjectToIndex,
  moveObjectsLayer,
  translateObjects,
  ungroupObjects,
} from '@narrative/slide-model'
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
const EmptyOutput = z.object({})

export const objectDuplicate = defineCommand({
  ...objectEditor,
  id: 'object.duplicate',
  title: 'Duplicate objects',
  description:
    'Copy objects on the same slide, moved by `offset` slide px (default 20, 20), on top, in one undo step. ' +
    'Copies get new ids and every property, rich text included. A whole group becomes a new group; a single ' +
    "member gives an ungrouped copy. A cropped image's copy shows the same part; a locked object's copy is " +
    'locked. Animations are not copied (animation.add). To another slide: object.copyTo; into another deck: ' +
    'read them (query.slide / query.object) and send them to object.insertFromDeck there (fromDeck = this ' +
    'deck).',
  input: z
    .object({
      slide: SlideRefSchema,
      objects: ObjectIdsSchema,
      offset: z.object({ x: Finite, y: Finite }).strict().optional(),
    })
    .strict(),
  output: z.object({ objectIds: z.array(z.string()) }),
  implementedWith: ['duplicateObjects'],
  examples: [
    {
      title: 'Duplicate a rectangle with the default offset',
      input: { slide: 's1', objects: ['r1'] },
    },
    {
      title: 'Duplicate a whole group exactly in place',
      input: { slide: 's1', objects: ['ga', 'gb'], offset: { x: 0, y: 0 } },
    },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const slide = resolveSlide(deck, input.slide)
    const objects = objectsOf(deck, slide)
    requireObjects(objects, input.objects, slide.id)
    const copies = duplicateObjects(objects, input.objects, input.offset ?? { x: 20, y: 20 })
    return { objectIds: copies.map((c) => c.id) }
  },
})

export const objectCopyTo = defineCommand({
  ...objectEditor,
  id: 'object.copyTo',
  title: 'Copy objects to a slide',
  description:
    'Copy objects to another slide of this deck (`toSlide`; omitted = the same slide), exact and whole — rich ' +
    "text, tables, crops, fills — on top of the target's stacking order, in one undo step. Copies get new " +
    'ids; a whole group becomes a new group, a lone member comes out ungrouped; animations are not copied. ' +
    'They keep their position on another slide and move 20, 20 on the same one; `offset` moves them by a ' +
    'delta, `at` puts the centre of their combined box on a slide point. Into another deck: read them with ' +
    'query.slide and use object.insertFromDeck there (fromDeck = this deck).',
  input: z
    .object({
      slide: SlideRefSchema,
      objects: ObjectIdsSchema,
      toSlide: SlideRefSchema.optional(),
      offset: z
        .object({ x: Finite, y: Finite })
        .strict()
        .optional()
        .describe('Move the copies by this delta (slide px)'),
      at: z
        .object({ x: Finite, y: Finite })
        .strict()
        .optional()
        .describe("Slide point the centre of the copies' combined box lands on"),
    })
    .strict()
    .refine((v) => v.offset === undefined || v.at === undefined, {
      message: 'Give `offset` or `at`, not both',
      path: ['at'],
    }),
  output: z.object({ objectIds: z.array(z.string()) }),
  implementedWith: ['copyObjectsTo'],
  examples: [
    {
      title: 'Copy the rectangle and the text box to slide 2, same place',
      input: { slide: 's1', objects: ['r1', 't1'], toSlide: 's2' },
    },
    {
      title: 'Copy the cropped image to the middle of slide 3',
      input: { slide: 's1', objects: ['img1'], toSlide: { index: 2 }, at: { x: 960, y: 540 } },
    },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const from = resolveSlide(deck, input.slide)
    const fromObjects = objectsOf(deck, from)
    const maps = requireObjects(fromObjects, input.objects, from.id)
    const target = input.toSlide === undefined ? from : resolveSlide(deck, input.toSlide)
    const toObjects = target.id === from.id ? fromObjects : objectsOf(deck, target)
    let offset = input.offset ?? (target.id === from.id ? { x: 20, y: 20 } : { x: 0, y: 0 })
    if (input.at !== undefined) {
      const boxes = [...maps.values()].map((m) => {
        const n = (k: string): number => {
          const v = m.get(k)
          return typeof v === 'number' && Number.isFinite(v) ? v : 0
        }
        return { x: n('x'), y: n('y'), width: n('width'), height: n('height') }
      })
      const left = Math.min(...boxes.map((b) => b.x))
      const top = Math.min(...boxes.map((b) => b.y))
      const right = Math.max(...boxes.map((b) => b.x + b.width))
      const bottom = Math.max(...boxes.map((b) => b.y + b.height))
      offset = { x: input.at.x - (left + right) / 2, y: input.at.y - (top + bottom) / 2 }
    }
    const copies = copyObjectsTo(fromObjects, toObjects, input.objects, offset)
    return { objectIds: copies.map((c) => c.id) }
  },
})

export const objectMove = defineCommand({
  ...objectEditor,
  id: 'object.move',
  title: 'Move objects',
  description:
    'Move objects by a delta in slide px. The correct way to move anything: a cropped image keeps its crop. ' +
    'To an absolute position: set x/y with object.update (a crop follows there too) or compute the delta from ' +
    'its x/y (query.object). Line objects up: object.align; to an edge or the centre of the slide: ' +
    'object.alignToSlide.',
  input: z
    .object({
      slide: SlideRefSchema,
      objects: ObjectIdsSchema,
      dx: Finite,
      dy: Finite,
    })
    .strict(),
  output: EmptyOutput,
  implementedWith: ['translateObjects'],
  examples: [
    {
      title: 'Nudge a rectangle 10 px to the right',
      input: { slide: 's1', objects: ['r1'], dx: 10, dy: 0 },
    },
    { title: 'Move a cropped image up', input: { slide: 's1', objects: ['img1'], dx: 0, dy: -40 } },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const slide = resolveSlide(deck, input.slide)
    const objects = objectsOf(deck, slide)
    requireObjects(objects, input.objects, slide.id)
    translateObjects(
      objects,
      input.objects.map((id) => ({ id, dx: input.dx, dy: input.dy })),
    )
    return {}
  },
})

export const objectLayer = defineCommand({
  ...objectEditor,
  id: 'object.layer',
  title: 'Change stacking order',
  description:
    'Change where objects sit in the stacking (z) order of their slide: `front` / `back` to the very top / ' +
    'bottom, `forward` / `backward` past one neighbour; several move as a block in their order. `toIndex` (0 ' +
    '= backmost) puts exactly one object at an exact position.',
  input: z
    .object({
      slide: SlideRefSchema,
      objects: ObjectIdsSchema,
      move: z.enum(['front', 'back', 'forward', 'backward', 'toIndex']),
      toIndex: z.number().int().min(0).optional(),
    })
    .strict()
    .refine((v) => (v.move === 'toIndex') === (v.toIndex !== undefined), {
      message: '`toIndex` is required with move "toIndex" and not allowed otherwise',
      path: ['toIndex'],
    })
    .refine((v) => v.move !== 'toIndex' || v.objects.length === 1, {
      message: 'move "toIndex" takes exactly one object',
      path: ['objects'],
    }),
  output: EmptyOutput,
  implementedWith: ['moveObjectsLayer', 'moveObjectToIndex'],
  examples: [
    {
      title: 'Bring a rectangle to the front',
      input: { slide: 's1', objects: ['r1'], move: 'front' },
    },
    {
      title: 'Put the text box right above the backmost object',
      input: { slide: 's1', objects: ['t1'], move: 'toIndex', toIndex: 1 },
    },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const slide = resolveSlide(deck, input.slide)
    const objects = objectsOf(deck, slide)
    requireObjects(objects, input.objects, slide.id)
    const [first] = input.objects
    if (input.move === 'toIndex') {
      if (first === undefined || input.toIndex === undefined) {
        throw new CommandError('invalid_input', 'move "toIndex" needs one object and a toIndex')
      }
      moveObjectToIndex(objects, first, input.toIndex)
    } else {
      moveObjectsLayer(objects, input.objects, input.move)
    }
    return {}
  },
})

export const objectGroup = defineCommand({
  ...objectEditor,
  id: 'object.group',
  title: 'Group objects',
  description:
    'Group two or more objects so they are selected, moved and duplicated together. Groups do not nest: each ' +
    'listed object leaves its group for the new one, unlisted members of that group stay in it — to merge ' +
    'whole groups, list all their members (query.slide shows groupId).',
  input: z
    .object({ slide: SlideRefSchema, objects: z.array(ObjectIdSchema).min(2).max(500) })
    .strict(),
  output: z.object({ groupId: z.string() }),
  implementedWith: ['groupObjects'],
  examples: [
    { title: 'Group a rectangle with a text box', input: { slide: 's1', objects: ['r1', 't1'] } },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const slide = resolveSlide(deck, input.slide)
    const objects = objectsOf(deck, slide)
    requireObjects(objects, input.objects, slide.id)
    return { groupId: groupObjects(objects, input.objects) }
  },
})

export const objectUngroup = defineCommand({
  ...objectEditor,
  id: 'object.ungroup',
  title: 'Ungroup objects',
  description:
    'Remove the given objects from their group. A whole group: pass all its members (query.slide shows ' +
    'groupId).',
  input: z.object({ slide: SlideRefSchema, objects: ObjectIdsSchema }).strict(),
  output: EmptyOutput,
  implementedWith: ['ungroupObjects'],
  examples: [
    { title: 'Dissolve the fixture group', input: { slide: 's1', objects: ['ga', 'gb'] } },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const slide = resolveSlide(deck, input.slide)
    const objects = objectsOf(deck, slide)
    requireObjects(objects, input.objects, slide.id)
    ungroupObjects(objects, input.objects)
    return {}
  },
})

export const objectAlign = defineCommand({
  ...objectEditor,
  id: 'object.align',
  idempotent: true,
  title: 'Align objects to each other',
  description:
    "Align two or more objects to the edges or centre of their combined box ('left' moves every left edge to " +
    'the leftmost). Rotation is ignored; crops move with their images. To the slide: object.alignToSlide.',
  input: z
    .object({
      slide: SlideRefSchema,
      objects: z.array(ObjectIdSchema).min(2).max(500),
      axis: z.enum(['left', 'center-x', 'right', 'top', 'center-y', 'bottom']),
    })
    .strict(),
  output: EmptyOutput,
  implementedWith: ['alignObjects'],
  examples: [
    {
      title: 'Align the left edges of a rectangle and an ellipse',
      input: { slide: 's1', objects: ['r1', 'e1'], axis: 'left' },
    },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const slide = resolveSlide(deck, input.slide)
    const objects = objectsOf(deck, slide)
    requireObjects(objects, input.objects, slide.id)
    alignObjects(objects, input.objects, input.axis)
    return {}
  },
})

export const objectDistribute = defineCommand({
  ...objectEditor,
  id: 'object.distribute',
  idempotent: true,
  title: 'Distribute objects evenly',
  description:
    'Space three or more objects so the gaps between neighbours are equal, horizontally or vertically; the ' +
    'two outermost stay put. Rotation is ignored; crops move with their images.',
  input: z
    .object({
      slide: SlideRefSchema,
      objects: z.array(ObjectIdSchema).min(3).max(500),
      axis: z.enum(['horizontal', 'vertical']),
    })
    .strict(),
  output: EmptyOutput,
  implementedWith: ['distributeObjects'],
  examples: [
    {
      title: 'Distribute three shapes vertically',
      input: { slide: 's1', objects: ['r1', 'e1', 't1'], axis: 'vertical' },
    },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const slide = resolveSlide(deck, input.slide)
    const objects = objectsOf(deck, slide)
    requireObjects(objects, input.objects, slide.id)
    distributeObjects(objects, input.objects, input.axis)
    return {}
  },
})

export const objectCommands = [
  objectDuplicate,
  objectCopyTo,
  objectMove,
  objectLayer,
  objectGroup,
  objectUngroup,
  objectAlign,
  objectDistribute,
]
