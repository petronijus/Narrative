/**
 * commands/src/commands/objects.ts — the `object.*` domain: arrangement,
 * duplication and geometry. Create/update/delete and the property commands
 * validate against the shared object schemas.
 */

import { z } from 'zod'
import {
  alignObjects,
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
    'Copy objects on the same slide, offset by `offset` slide pixels (default 20, 20), on top of the stacking order, ' +
    'in one undo step. Copies get new ids and keep every property, rich text included. A duplicated group becomes ' +
    'its own new group (the original group is untouched); copying a single member of a group gives an ungrouped ' +
    "copy. A cropped image's crop moves with its copy, so the copy shows the same part of the picture. A copy of a " +
    'locked object is locked too. Animations are not ' +
    'copied (add them with animation.add). Copying to another slide or deck is object.copyTo (planned, not ' +
    'available yet): today, read the object with query.object and recreate it there with object.create.',
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

export const objectMove = defineCommand({
  ...objectEditor,
  id: 'object.move',
  title: 'Move objects',
  description:
    'Move objects by a delta in slide pixels (the slide is 1920 x 1080, origin top-left, y down). ' +
    'This is the correct way to move anything: a cropped image keeps its crop. ' +
    'To place an object at absolute coordinates, set x/y with object.update (a crop follows there too) or compute ' +
    'the delta from its current x/y (query.object). To line objects up use object.align; to an edge or the ' +
    'centre of the slide, object.alignToSlide.',
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
    'Change where objects sit in the stacking (z) order of their slide: `front` / `back` move them to the very ' +
    'top / bottom, `forward` / `backward` move them past one neighbour. Several objects move as a block and keep ' +
    'their relative order. To put one object at an exact stacking position use `toIndex` ' +
    '(0 = backmost), which requires exactly one object. Other objects shift around the moved ' +
    'ones as needed.',
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
    'Group two or more objects so they are selected, moved and duplicated together. Groups do not nest: every ' +
    'listed object leaves its current group for the new one, while members of that old group you did not list stay ' +
    "in it — to merge whole groups, list all their members (query.slide shows each object's groupId).",
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
    'Remove the given objects from their group. To dissolve a whole group, pass all its members ' +
    '(query.slide lists objects with their groupId).',
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
    "Align two or more objects to the edges or centre of their combined bounding box (e.g. 'left' moves every " +
    "object's left edge to the leftmost edge). Rotation is ignored; cropped images keep their crop. " +
    'To align objects to the slide itself use object.alignToSlide.',
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
    'Space three or more objects so the gaps between neighbours are equal, horizontally or vertically. ' +
    'The two outermost objects stay where they are. Rotation is ignored; cropped images keep their crop.',
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
  objectMove,
  objectLayer,
  objectGroup,
  objectUngroup,
  objectAlign,
  objectDistribute,
]
