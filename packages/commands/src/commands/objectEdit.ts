/**
 * commands/src/commands/objectEdit.ts — creating, changing and deleting
 * objects, and image masks. Every property write is validated against the
 * shared object schemas (packages/shared/src/schema) before anything
 * reaches the document.
 */

import { z } from 'zod'
import { nanoid } from 'nanoid'
import type * as Y from 'yjs'
import {
  addObject,
  applyShapeMask,
  bulkUpdateObjects,
  createObjectOfType,
  getObjectTypeDef,
  isMaskableShape,
  removeAnimation,
  removeObject,
  updateObject,
  yMapToPlainObject,
  type AnimationsMutationContext,
  type BulkUpdate,
  type ObjectsMutationContext,
} from '@narrative/slide-model'
import {
  IdSchema,
  objectCreateInputSchema,
  objectPatchInputSchema,
  type SlideObject,
  type SlideObjectPatch,
  type SlideObjectType,
  type TableDefaults,
} from '@narrative/shared'
import { defineCommand } from '../registry.js'
import { CommandError, issuesFromZod } from '../errors.js'
import {
  ObjectIdSchema,
  ObjectIdsSchema,
  SlideRefSchema,
  animationsOf,
  objectsOf,
  requireDeck,
  requireObjects,
  resolveSlide,
} from '../refs.js'
import {
  TextBodyInputSchema,
  planFromBody,
  planText,
  planToDelta,
  writePlan,
  type BodyPlan,
} from '../text/body.js'
import { textObjectBody } from '../text/target.js'
import { MAX_TABLE_TRACKS, TableDefaultsCreateSchema, insertTable } from './tables.js'

const objectEditor = {
  domain: 'object',
  role: 'editor',
  effects: ['doc'],
  undo: 'undoable',
  confirm: 'never',
  hosts: ['browser', 'server'],
  acceptsComponent: true,
} as const

const OBJECT_TYPES: readonly SlideObjectType[] = [
  'rectangle',
  'ellipse',
  'triangle',
  'polygon',
  'line',
  'arrow',
  'path',
  'text',
  'image',
  'video',
  'table',
]

function isObjectType(v: unknown): v is SlideObjectType {
  return typeof v === 'string' && (OBJECT_TYPES as readonly string[]).includes(v)
}

const UNITS =
  'Units: the slide is 1920 x 1080 px, origin top-left, y down; x/y/width/height in slide px; rotation in RADIANS ' +
  '(90 degrees = 1.5708); opacity and *Alpha 0..1; colours as "#RRGGBB", a 0xRRGGBB integer, or a colour token ' +
  '{ "$token": "colors.<id>" }.'

/** Animation steps on the slide that target any of `ids`. Reads only. */
function stepsTargeting(anims: AnimationsMutationContext, ids: ReadonlySet<string>): string[] {
  const out: string[] = []
  for (let i = 0; i < anims.animations.length; i++) {
    const step = anims.animations.get(i)
    if (ids.has(step.get('objectId') as string)) out.push(step.get('id') as string)
  }
  return out
}

// ---------------------------------------------------------------------------
// object.create
// ---------------------------------------------------------------------------

const assetId = IdSchema.describe('Id of an asset already uploaded to the deck (media.upload)')
const TrackCount = z.number().int().min(1).max(MAX_TABLE_TRACKS)

const CreateObjectSchema = z.discriminatedUnion('type', [
  objectCreateInputSchema('rectangle').extend({ type: z.literal('rectangle') }),
  objectCreateInputSchema('ellipse').extend({ type: z.literal('ellipse') }),
  objectCreateInputSchema('triangle').extend({ type: z.literal('triangle') }),
  objectCreateInputSchema('polygon').extend({ type: z.literal('polygon') }),
  objectCreateInputSchema('line').extend({ type: z.literal('line') }),
  objectCreateInputSchema('arrow').extend({ type: z.literal('arrow') }),
  objectCreateInputSchema('path').extend({ type: z.literal('path') }),
  objectCreateInputSchema('text').extend({
    type: z.literal('text'),
    text: TextBodyInputSchema.optional(),
  }),
  objectCreateInputSchema('image').extend({ type: z.literal('image'), assetId }),
  objectCreateInputSchema('video').extend({ type: z.literal('video'), assetId }),
  objectCreateInputSchema('table')
    .omit({ rows: true, colWidths: true, rowHeights: true, defaults: true, borderSegments: true })
    .extend({
      type: z.literal('table'),
      rows: TrackCount.optional().describe('Number of rows (default 3)'),
      cols: TrackCount.optional().describe('Number of columns (default 3)'),
      defaults: TableDefaultsCreateSchema.optional(),
    }),
])

type CreateObject = z.output<typeof CreateObjectSchema>

function createText(
  objects: ObjectsMutationContext,
  props: Extract<CreateObject, { type: 'text' }>,
): string {
  const { text, type, ...rest } = props
  const plan: BodyPlan | null = text === undefined ? null : planFromBody(text)
  const richer =
    plan !== null &&
    (plan.hasBlocks ||
      plan.paragraphs.some((p) => p.runs.some((r) => Object.keys(r.attrs).length > 0)))
  if (!richer) {
    const overrides = plan === null ? rest : { ...rest, text: planText(plan) }
    return createObjectOfType(objects, type, overrides as never).id
  }
  // Formatted body: the object goes in with its rich text in one insert —
  // addObject replays the `_richTextOps` delta onto the new Y.Text.
  const def = getObjectTypeDef('text')
  if (def === undefined) throw new CommandError('failed', "object type 'text' is not registered")
  const id = nanoid()
  const obj = {
    ...def.defaultProps(),
    ...rest,
    id,
    type,
    text: planText(plan),
    _richTextOps: planToDelta(plan),
  }
  addObject(objects, obj as unknown as SlideObject)
  return id
}

export const objectCreate = defineCommand({
  ...objectEditor,
  id: 'object.create',
  title: 'Create object',
  description:
    'Create one object on a slide: rectangle, ellipse, triangle, polygon, line, arrow, path, text, image, video or ' +
    'table. Only `type` is required; every property you omit takes the editor default (e.g. a 200 x 150 blue ' +
    'rectangle at 100,100). Text takes `text` as a plain string (blank line = new paragraph) or ' +
    '{ paragraphs: [...] } with formatted runs and bullet/numbered lists. Images and videos need the `assetId` of ' +
    'an asset already uploaded to the deck (media.upload). A table takes rows/cols/defaults (same as table.insert) and is filled ' +
    'with text.set. New objects go on top of the stacking order; use object.layer to reorder. ' +
    UNITS,
  input: z.strictObject({ slide: SlideRefSchema, object: CreateObjectSchema }),
  output: z.object({ objectId: z.string() }),
  implementedWith: ['createObjectOfType', 'addObject', 'addTable', 'updateObject'],
  examples: [
    {
      title: 'Add a rounded red rectangle',
      input: {
        slide: 's2',
        object: {
          type: 'rectangle',
          x: 160,
          y: 200,
          width: 400,
          height: 240,
          fill: '#e03c31',
          cornerRadius: 16,
        },
      },
    },
    {
      title: 'Add a title text box',
      input: {
        slide: 's2',
        object: {
          type: 'text',
          x: 160,
          y: 80,
          width: 1600,
          height: 120,
          text: 'Quarterly review',
          fontSize: 72,
          fontWeight: 'bold',
        },
      },
    },
    {
      title: 'Add a bulleted list with one bold word',
      input: {
        slide: 's2',
        object: {
          type: 'text',
          x: 160,
          y: 300,
          width: 900,
          height: 300,
          text: {
            paragraphs: [
              { list: 'bullet', runs: [{ text: 'Revenue ' }, { text: 'up 12%', bold: true }] },
              { list: 'bullet', text: 'Costs flat' },
            ],
          },
        },
      },
    },
    {
      title: 'Place the fixture image again, smaller',
      input: {
        slide: 's3',
        object: { type: 'image', assetId: 'asset-fixture', width: 320, height: 240 },
      },
    },
    {
      title: 'Create a 2 x 4 table',
      input: { slide: 's3', object: { type: 'table', rows: 2, cols: 4, x: 200, y: 600 } },
    },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const objects = objectsOf(deck, resolveSlide(deck, input.slide))
    const o = input.object
    if (
      o.type === 'video' &&
      o.trimStart !== undefined &&
      o.trimEnd !== undefined &&
      o.trimEnd <= o.trimStart
    ) {
      throw new CommandError('invalid_input', 'trimEnd must be greater than trimStart', {
        issues: [
          { path: ['object', 'trimEnd'], message: 'trimEnd must be greater than trimStart' },
        ],
      })
    }
    if (o.type === 'table') {
      const { type: _t, rows, cols, defaults, x, y, width, height, name, ...base } = o
      void _t
      const id = insertTable(objects, {
        rows,
        cols,
        x,
        y,
        width,
        height,
        name,
        defaults: defaults as Partial<TableDefaults> | undefined,
      })
      if (Object.keys(base).length > 0)
        updateObject(objects, id, base as SlideObjectPatch<SlideObject>)
      return { objectId: id }
    }
    if (o.type === 'text') return { objectId: createText(objects, o) }
    const { type, ...overrides } = o
    return { objectId: createObjectOfType(objects, type, overrides as never).id }
  },
})

// ---------------------------------------------------------------------------
// object.update
// ---------------------------------------------------------------------------

/** Table structure is CRDT-nested; a flat patch would corrupt it. */
const TABLE_STRUCTURE_KEYS = [
  'rows',
  'colWidths',
  'rowHeights',
  'defaults',
  'borderSegments',
] as const

const PatchRecord = z
  .record(z.string(), z.unknown())
  .refine((p) => Object.keys(p).length > 0, { message: 'The patch is empty' })
  .describe(
    'Properties to change, validated against the object type (unknown keys are rejected). `null` removes an ' +
      'optional property (e.g. "shadow": null). Required properties cannot be removed.',
  )

interface PreparedUpdate {
  id: string
  map: Y.Map<unknown>
  patch: Record<string, unknown>
  text: BodyPlan | null
}

/**
 * Validate one patch against the object's CURRENT type — before any write.
 * Only what the patch changes is checked (plus the invariants it takes
 * part in), never the untouched fields: imported decks legitimately hold
 * values today's strict schemas would reject.
 */
function preparePatch(
  id: string,
  map: Y.Map<unknown>,
  raw: Record<string, unknown>,
  at: PropertyKey[],
): PreparedUpdate {
  const type = map.get('type')
  if (!isObjectType(type))
    throw new CommandError('conflict', `object '${id}' has an unknown type '${String(type)}'`)
  if (type === 'table') {
    const structural = TABLE_STRUCTURE_KEYS.filter((k) => k in raw)
    if (structural.length > 0) {
      throw new CommandError(
        'invalid_input',
        `table structure (${structural.join(', ')}) cannot be patched; use table.row.*/col.*, table.resize*, ` +
          'table.merge/split, table.style.* and table.border.*',
        {
          issues: structural.map((k) => ({
            path: [...at, k],
            message: 'use the table.* commands',
          })),
        },
      )
    }
  }
  const parsed = objectPatchInputSchema(type).safeParse(raw)
  if (!parsed.success) {
    throw new CommandError('invalid_input', `invalid patch for ${type} '${id}'`, {
      issues: issuesFromZod(parsed.error).map((i) => ({
        path: [...at, ...i.path],
        message: i.message,
      })),
    })
  }
  const patch: Record<string, unknown> = { ...(parsed.data as Record<string, unknown>) }

  // Video trim window: a pair invariant spanning the patch and the object.
  if (type === 'video' && ('trimStart' in patch || 'trimEnd' in patch)) {
    const start = 'trimStart' in patch ? patch['trimStart'] : map.get('trimStart')
    const end = 'trimEnd' in patch ? patch['trimEnd'] : map.get('trimEnd')
    if (typeof start === 'number' && typeof end === 'number' && end <= start) {
      throw new CommandError('invalid_input', 'trimEnd must be greater than trimStart', {
        issues: [{ path: [...at, 'trimEnd'], message: 'trimEnd must be greater than trimStart' }],
      })
    }
  }

  // A crop (`imageRect`) is in ABSOLUTE slide coordinates: moving the frame
  // without moving it would slide the picture inside the frame.
  if (type === 'image' && ('x' in patch || 'y' in patch) && !('imageRect' in patch)) {
    const crop = map.get('imageRect') as
      | { x?: unknown; y?: unknown; width?: unknown; height?: unknown }
      | undefined
    const oldX = map.get('x')
    const oldY = map.get('y')
    if (crop !== undefined && typeof crop.x === 'number' && typeof crop.y === 'number') {
      const dx = typeof patch['x'] === 'number' && typeof oldX === 'number' ? patch['x'] - oldX : 0
      const dy = typeof patch['y'] === 'number' && typeof oldY === 'number' ? patch['y'] - oldY : 0
      if (dx !== 0 || dy !== 0) patch['imageRect'] = { ...crop, x: crop.x + dx, y: crop.y + dy }
    }
  }

  let text: BodyPlan | null = null
  if (type === 'text' && typeof patch['text'] === 'string') {
    text = planFromBody(patch['text'])
    delete patch['text']
  }
  return { id, map, patch, text }
}

export const objectUpdate = defineCommand({
  ...objectEditor,
  id: 'object.update',
  idempotent: true,
  title: 'Update object properties',
  description:
    'ROTATION IS IN RADIANS here (the stored unit): 90 degrees = 1.5708, 180 = 3.1416; object.rotate takes ' +
    'degrees. ' +
    'Change properties of an object — fill, stroke, opacity, font size, corner radius, shadow, name, lock, x/y/' +
    'width/height, rotation, … — validated against its type before anything is written (unknown keys fail). ' +
    '`null` removes an optional property. Use `updates` to patch several objects on one slide in one step. ' +
    "Not for tables' rows/columns/cells (table.* commands) or relative moves (object.move). " +
    'Raw fields do exactly what they say and no more; where the editor does more, compose it yourself: ' +
    '(1) Setting x/y of a cropped image moves its crop along, but width/height do NOT scale the crop ' +
    '(`imageRect`) — resize with object.resize, which does. ' +
    "(2) `flipH` / `flipV` only mirror the content without negating `rotation` as the editor's Flip does — flip " +
    'with object.flip. ' +
    '(3) Box-level typography (fontFamily, fontSize, fontWeight, color, …) is only the default: inline run ' +
    'formatting in the text overrides it, so a box-wide change on formatted text needs text.format with `clear` ' +
    'for those attributes first — put both in one ops.apply. ' +
    '(4) `fontFamily` does not snap `fontWeight` to a cut the new family has (the editor does); set a weight the ' +
    'family provides in the same patch. ' +
    "(5) `textStyleId` only links a folder text style, it does not apply it; set the style's font fields in the " +
    'same patch; text.style.apply (planned, not available yet) will do both. ' +
    '`text` on a text box replaces the body with plain text (formatting is dropped; use text.set for formatted ' +
    'text, text.format for styling ranges). ' +
    '`locked` is an editor-only flag (it stops a person dragging, resizing or deleting the object on the canvas); ' +
    'it does not restrict commands, so locked objects can be changed and `locked` set or cleared like any property. ' +
    UNITS,
  input: z.union([
    z.strictObject({ slide: SlideRefSchema, object: ObjectIdSchema, patch: PatchRecord }),
    z.strictObject({
      slide: SlideRefSchema,
      updates: z
        .array(z.strictObject({ object: ObjectIdSchema, patch: PatchRecord }))
        .min(1)
        .max(500),
    }),
  ]),
  output: z.object({ updated: z.array(z.string()) }),
  implementedWith: ['updateObject', 'bulkUpdateObjects', 'spliceRichText'],
  examples: [
    {
      title: 'Recolour a rectangle and round its corners',
      input: { slide: 's1', object: 'r1', patch: { fill: '#0a7d4b', cornerRadius: 12 } },
    },
    {
      title: 'Remove a property with null',
      input: { slide: 's1', object: 'r1', patch: { stroke: null, name: 'Card' } },
    },
    {
      title: 'Move a cropped image to an absolute position (the crop follows)',
      input: { slide: 's1', object: 'img1', patch: { x: 1100, y: 250 } },
    },
    {
      title: 'Fade two shapes at once',
      input: {
        slide: 's1',
        updates: [
          { object: 'r1', patch: { opacity: 0.5 } },
          { object: 'e1', patch: { opacity: 0.5 } },
        ],
      },
    },
    {
      title: 'Unlock the logo (`locked` is an ordinary property)',
      input: { slide: 's2', object: 'lock1', patch: { locked: false } },
    },
    {
      title: 'Rotate a rectangle by 45 degrees (rotation is in radians: 45 degrees = 0.7854)',
      input: { slide: 's1', object: 'r1', patch: { rotation: 0.7854 } },
    },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const slide = resolveSlide(deck, input.slide)
    const objects = objectsOf(deck, slide)
    const requested =
      'updates' in input
        ? input.updates.map((u, i) => ({
            id: u.object,
            patch: u.patch,
            at: ['updates', i, 'patch'] as PropertyKey[],
          }))
        : [{ id: input.object, patch: input.patch, at: ['patch'] as PropertyKey[] }]
    const ids = requested.map((r) => r.id)
    if (new Set(ids).size !== ids.length) {
      throw new CommandError('invalid_input', 'each object may appear only once in `updates`')
    }
    const maps = requireObjects(objects, ids, slide.id)
    const prepared = requested.map((r) => preparePatch(r.id, maps.get(r.id)!, r.patch, r.at))

    // Every check passed — write.
    const [single] = prepared
    if (prepared.length === 1 && single !== undefined) {
      if (Object.keys(single.patch).length > 0)
        updateObject(objects, single.id, single.patch as SlideObjectPatch<SlideObject>)
    } else {
      const bulk: BulkUpdate[] = prepared
        .filter((p) => Object.keys(p.patch).length > 0)
        .map((p) => ({ id: p.id, patch: p.patch as SlideObjectPatch<SlideObject> }))
      bulkUpdateObjects(objects, bulk)
    }
    for (const p of prepared) {
      if (p.text !== null) writePlan(deck.doc, textObjectBody(objects, p.id, p.map), p.text)
    }
    return { updated: ids }
  },
})

// ---------------------------------------------------------------------------
// object.delete
// ---------------------------------------------------------------------------

export const objectDelete = defineCommand({
  ...objectEditor,
  id: 'object.delete',
  title: 'Delete objects',
  description:
    'Delete objects from a slide together with every animation step that targets them. Group members are deleted ' +
    'individually; pass every member to delete a whole group. To hide an object instead, use object.update with ' +
    'opacity 0. Locked objects are deleted like any other: `locked` is an editor-only flag that does not restrict ' +
    'commands.',
  input: z.strictObject({
    slide: SlideRefSchema,
    objects: ObjectIdsSchema,
  }),
  output: z.object({ deleted: z.array(z.string()), removedAnimations: z.array(z.string()) }),
  implementedWith: ['removeObject', 'removeAnimation'],
  examples: [
    { title: 'Delete a rectangle and its fade-in', input: { slide: 's1', objects: ['r1'] } },
    {
      title: 'Delete the locked logo (locks do not restrict commands)',
      input: { slide: 's2', objects: ['lock1'] },
    },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const slide = resolveSlide(deck, input.slide)
    const objects = objectsOf(deck, slide)
    const ids = [...new Set(input.objects)]
    requireObjects(objects, ids, slide.id)
    const anims = animationsOf(deck, slide)
    const steps = stepsTargeting(anims, new Set(ids))
    for (const id of ids) removeObject(objects, id)
    for (const step of steps) removeAnimation(anims, step)
    return { deleted: ids, removedAnimations: steps }
  },
})

// ---------------------------------------------------------------------------
// Masks
// ---------------------------------------------------------------------------

export const objectMaskApply = defineCommand({
  ...objectEditor,
  id: 'object.mask.apply',
  title: 'Mask an image with a shape',
  description:
    "Clip an image to a shape's silhouette (rectangle, ellipse, triangle, polygon or path). The shape is consumed: " +
    "it is deleted along with its animations, and the image's frame becomes the shape's bounding box while the " +
    'picture stays exactly where it was on the slide. Shape rotation is ignored. Undo with object.mask.remove ' +
    '(which keeps the new frame).',
  input: z.strictObject({
    slide: SlideRefSchema,
    image: ObjectIdSchema.describe('The image to clip'),
    shape: ObjectIdSchema.describe('The shape whose silhouette becomes the mask (it is deleted)'),
  }),
  output: z.object({ removedAnimations: z.array(z.string()) }),
  implementedWith: ['applyShapeMask', 'isMaskableShape', 'removeAnimation'],
  examples: [
    {
      title: 'Clip the fixture image to the ellipse',
      input: { slide: 's1', image: 'img1', shape: 'e1' },
    },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const slide = resolveSlide(deck, input.slide)
    const objects = objectsOf(deck, slide)
    if (input.image === input.shape)
      throw new CommandError('invalid_input', 'image and shape must be different objects')
    const maps = requireObjects(objects, [input.image, input.shape], slide.id)
    const image = maps.get(input.image)!
    if (image.get('type') !== 'image') {
      throw new CommandError(
        'conflict',
        `object '${input.image}' is a ${String(image.get('type'))}, not an image`,
      )
    }
    const shape = yMapToPlainObject(maps.get(input.shape)!)
    if (!isMaskableShape(shape)) {
      throw new CommandError(
        'conflict',
        `a ${shape.type} cannot be a mask; use a rectangle, ellipse, triangle, polygon or path`,
      )
    }
    const anims = animationsOf(deck, slide)
    const steps = stepsTargeting(anims, new Set([input.shape]))
    if (!applyShapeMask(objects, input.image, input.shape)) {
      throw new CommandError('failed', 'the mask could not be applied')
    }
    for (const step of steps) removeAnimation(anims, step)
    return { removedAnimations: steps }
  },
})

export const objectMaskRemove = defineCommand({
  ...objectEditor,
  id: 'object.mask.remove',
  title: 'Remove image mask',
  description:
    "Remove an image's shape mask so it shows as a rectangle again. The frame stays where the mask left it and the " +
    'picture does not move. Returns removed: false when the image had no mask. To remove a crop instead use ' +
    'object.crop.set with op reset.',
  input: z.strictObject({ slide: SlideRefSchema, image: ObjectIdSchema }),
  output: z.object({ removed: z.boolean() }),
  implementedWith: ['updateObject'],
  examples: [{ title: 'Unmask the round portrait', input: { slide: 's1', image: 'img2' } }],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const slide = resolveSlide(deck, input.slide)
    const objects = objectsOf(deck, slide)
    const image = requireObjects(objects, [input.image], slide.id).get(input.image)!
    if (image.get('type') !== 'image') {
      throw new CommandError(
        'conflict',
        `object '${input.image}' is a ${String(image.get('type'))}, not an image`,
      )
    }
    if (image.get('mask') === undefined) return { removed: false }
    updateObject(objects, input.image, {
      mask: undefined,
    } as unknown as SlideObjectPatch<SlideObject>)
    return { removed: true }
  },
})

export const objectEditCommands = [
  objectCreate,
  objectUpdate,
  objectDelete,
  objectMaskApply,
  objectMaskRemove,
]
