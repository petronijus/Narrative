/**
 * commands/src/commands/components.ts — the `component.*` commands.
 *
 * A component is a small master (a headline block, the pagination, a
 * recurring card grid) kept in a folder and stamped onto slides as ordinary,
 * detached objects. Folders keep only a FEW components — for blocks that
 * recur on many slides (plan §7, decision 10); everything else is built from
 * plain objects styled with the folder's tokens.
 *
 * list / create / get / rename / delete call the server's ComponentService
 * (the same service GET/POST /folders/:id/components and PATCH/DELETE
 * /components/:id call). `component.promote` makes a component from objects
 * on a deck's slide, on the server (POST /decks/:id/promote-component).
 *
 * A component owns its pictures and videos (A2.12b): promoting copies the
 * deck's media into the component; stamping links the master's media — a
 * deck may show the pictures of its folder's components (folder sharing
 * step 2, apps/server/src/media/visibleMedia.ts), and a deleted component's
 * pictures stay with the folder.
 *
 * `component.stamp` is a document command with an asynchronous `load`
 * phase: the service reads the master and stages its media for the deck,
 * then `stampMaster` stamps it synchronously inside the host's one
 * transaction with slide-model's `stampComponent`, filling named text slots
 * in the same step. The editor's stamp (POST /decks/:id/stamp-component)
 * runs the same `stampMaster` on the server.
 *
 * Every stamped object records its provenance (`component`, A4.1), so
 * `component.restamp` re-applies a changed master to the stamps made from
 * it, in place — loaded like a stamp, written by slide-model's
 * `restampComponent`, its text slots re-formatted the way a stamp fills
 * them. A component's slots are its master objects' `slot ?? name`.
 *
 * Editing a master needs no command of its own: the host opens
 * `component:<id>` as the target document and the ordinary document
 * commands (object.*, text.*, table.*, query.slide) work on it.
 */

import { z } from 'zod'
import * as Y from 'yjs'
import {
  blockAttrsToInsertAttrs,
  getParagraphDeltas,
  restampComponent,
  slotNameOf,
  stampComponent,
  yMapToAnimationStep,
} from '@narrative/slide-model'
import { defineCommand } from '../registry.js'
import { requireServices } from '../services.js'
import { CommandError } from '../errors.js'
import {
  ObjectIdsSchema,
  SlideRefSchema,
  animationsOf,
  objectsOf,
  requireDeck,
  requireObjects,
  resolveSlide,
  type SlideRef,
} from '../refs.js'
import { ObjectOutputSchema, objectForModel, toJsonForModel } from '../read/plain.js'
import {
  TextBodyInputSchema,
  displayOf,
  planFromBody,
  writePlan,
  type BodyPlan,
  type TextBodyInput,
} from '../text/body.js'
import type { ComponentMaster, PreparedStamp } from '../services/components.js'
import type { DeckMutationContext } from '@narrative/slide-model'
import {
  ComponentOutput,
  DELETE,
  GET,
  IdSchema,
  PATCH,
  POST,
  serverCommand,
  targetDeckId,
  targetFolderId,
} from './serverShared.js'

const ComponentIdSchema = IdSchema.describe('Component id (component.list)')

// ---------------------------------------------------------------------------
// Reading a master
// ---------------------------------------------------------------------------

interface MasterView {
  doc: Y.Doc
  /** Master objects in stacking order, as stampComponent reads them. */
  objects: Y.Map<unknown>[]
  animations: Y.Map<unknown>[]
}

function openMaster(master: ComponentMaster): MasterView {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, master.state)
  const slide = doc.getArray<Y.Map<unknown>>('slides').get(0) as Y.Map<unknown> | undefined
  const objectsArr = slide?.get('objects')
  const animationsArr = slide?.get('animations')
  const objects =
    objectsArr instanceof Y.Array
      ? (objectsArr.toArray() as unknown[]).filter(
          (m): m is Y.Map<unknown> => m instanceof Y.Map && typeof m.get('type') === 'string',
        )
      : []
  const animations =
    animationsArr instanceof Y.Array
      ? (animationsArr.toArray() as unknown[]).filter(
          (m): m is Y.Map<unknown> => m instanceof Y.Map,
        )
      : []
  return { doc, objects, animations }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/** The master's bounding box — where a stamp lands when no position is given. */
function masterBounds(objects: ReadonlyArray<Y.Map<unknown>>) {
  if (objects.length === 0) return { x: 0, y: 0, width: 0, height: 0 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const o of objects) {
    const x = num(o.get('x'))
    const y = num(o.get('y'))
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x + num(o.get('width')))
    maxY = Math.max(maxY, y + num(o.get('height')))
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/** A master object's slot name: its `slot`, else its `name` (masters named before A4 keep working). */
function slotOf(o: Y.Map<unknown>): string | null {
  return slotNameOf({ slot: o.get('slot'), name: o.get('name') })
}

/** The master's slots: every object with a slot name, in master order. */
function slotsOf(objects: ReadonlyArray<Y.Map<unknown>>) {
  const slots: Array<{
    name: string
    objectId: string
    type: string
    role?: string
    text?: string
  }> = []
  for (const o of objects) {
    const name = slotOf(o)
    if (name === null) continue
    const text = o.get('text')
    const role = o.get('role')
    slots.push({
      name,
      objectId: o.get('id') as string,
      type: o.get('type') as string,
      ...(typeof role === 'string' ? { role } : {}),
      ...(text instanceof Y.Text ? { text: displayOf(text.toString()).display } : {}),
    })
  }
  return slots
}

const SlotOutput = z.object({
  name: z.string().describe('Slot name — pass it as a key of `slots` to component.stamp'),
  objectId: z.string().describe('The master object that is the slot'),
  type: z.string(),
  role: z.string().optional(),
  text: z.string().optional().describe('Text slots: the placeholder text'),
})

const BoundsOutput = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
})

// ---------------------------------------------------------------------------
// Commands backed by the service
// ---------------------------------------------------------------------------

/** A folder's components: members read them, editors change them (folder sharing). */
const folderComponent = {
  ...serverCommand,
  domain: 'component',
  scope: 'folder',
  effects: ['server'],
} as const

export const componentList = defineCommand({
  ...folderComponent,
  role: 'viewer',
  id: 'component.list',
  title: 'List components',
  description:
    "The folder's components (id, name, thumbnail URL), oldest first. A folder keeps only a few — the blocks that " +
    'recur on many slides, such as the headline block, the pagination or a card grid. Prefer them for those roles: ' +
    'component.get shows one with its slots, component.stamp places it. Do not expect a component for every ' +
    'layout; build one-off content from plain objects styled with the folder tokens. Any member of the folder.',
  input: z.strictObject({}),
  output: z.object({ components: z.array(ComponentOutput) }),
  readOnly: true,
  undo: 'n/a',
  confirm: 'never',
  routes: [GET('/folders/:folderId/components')],
  examples: [{ title: "The folder's components", input: {} }],
  async handler(ctx) {
    return {
      components: await requireServices(ctx).components.list({
        userId: ctx.actor.userId,
        folderId: targetFolderId(ctx),
      }),
    }
  },
})

export const componentGet = defineCommand({
  ...folderComponent,
  role: 'viewer',
  id: 'component.get',
  title: 'Read component',
  description:
    "One component's master: its objects with every property (the shapes query.slide returns), its animations, " +
    'its bounding box, and its slot map — an object with a `slot` (else a name) is a slot; text slots show their ' +
    'placeholder text. ' +
    'Read it before component.stamp to know which slot names to fill. To change the master itself, target the ' +
    'component (componentId) with the ordinary document commands. Any member of the folder.',
  input: z.strictObject({ componentId: ComponentIdSchema }),
  output: z.object({
    component: ComponentOutput,
    bounds: BoundsOutput.describe('Bounding box of the master objects, in slide px'),
    slots: z.array(SlotOutput),
    objects: z.array(ObjectOutputSchema),
    animations: z.array(z.record(z.string(), z.unknown())),
  }),
  readOnly: true,
  undo: 'n/a',
  confirm: 'never',
  examples: [{ title: 'Read the headline component', input: { componentId: 'cmp_headline' } }],
  async handler(ctx, input) {
    const master = await requireServices(ctx).components.readMaster({
      userId: ctx.actor.userId,
      componentId: input.componentId,
      folderId: targetFolderId(ctx),
    })
    const view = openMaster(master)
    try {
      return {
        component: master.component,
        bounds: masterBounds(view.objects),
        slots: slotsOf(view.objects),
        objects: view.objects.map((m) => objectForModel(m) as z.input<typeof ObjectOutputSchema>),
        animations: view.animations.map(
          (m) => toJsonForModel(yMapToAnimationStep(m)) as Record<string, unknown>,
        ),
      }
    } finally {
      view.doc.destroy()
    }
  },
})

export const componentCreate = defineCommand({
  ...folderComponent,
  role: 'editor',
  id: 'component.create',
  title: 'Create component',
  description:
    'Make an empty component in the folder, for a block that recurs on many slides. Fill its master with the ' +
    'object and text commands pointed at it (componentId); from objects on a slide use component.promote. ' +
    'Needs the editor role in the folder. Undo: component.delete.',
  input: z.strictObject({
    // Validated by the service (as for POST /folders/:folderId/components):
    // trimmed, at most 200 characters, blank → "Untitled component".
    name: z.string().optional().describe('The name the folder lists it under'),
  }),
  output: ComponentOutput,
  undo: 'undoable',
  undoneBy: 'component.delete',
  confirm: 'never',
  routes: [POST('/folders/:folderId/components')],
  examples: [{ title: 'Create an empty pagination component', input: { name: 'Pagination' } }],
  async handler(ctx, input) {
    return requireServices(ctx).components.create({
      userId: ctx.actor.userId,
      folderId: targetFolderId(ctx),
      name: input.name ?? '',
    })
  },
})

export const componentRename = defineCommand({
  ...folderComponent,
  role: 'editor',
  id: 'component.rename',
  title: 'Rename component',
  description:
    'Rename a component of the folder. Stamps already on slides are unaffected. Undo: rename it back. Needs the editor role in the folder.',
  input: z.strictObject({
    componentId: ComponentIdSchema,
    name: z
      .string()
      .max(200)
      .refine((t) => t.trim().length > 0, 'the name must not be blank'),
  }),
  output: ComponentOutput,
  idempotent: true,
  undo: 'undoable',
  undoneBy: 'component.rename',
  confirm: 'never',
  routes: [PATCH('/components/:id')],
  examples: [
    { title: 'Rename a component', input: { componentId: 'cmp_headline', name: 'Headline' } },
  ],
  async handler(ctx, input) {
    return requireServices(ctx).components.rename({
      userId: ctx.actor.userId,
      componentId: input.componentId,
      name: input.name.trim(),
      folderId: targetFolderId(ctx),
    })
  },
})

export const componentDelete = defineCommand({
  ...folderComponent,
  role: 'editor',
  id: 'component.delete',
  title: 'Delete component',
  description:
    'Delete a component master from the folder. Objects already stamped from it stay on their slides with their ' +
    "pictures and videos (the folder keeps the master's); it just cannot be stamped any more. Cannot be undone; " +
    'confirm with the user first. Needs the editor role in the folder.',
  input: z.strictObject({ componentId: ComponentIdSchema }),
  output: z.object({ deleted: z.literal(true) }),
  undo: 'irreversible',
  confirm: 'always',
  routes: [DELETE('/components/:id')],
  examples: [{ title: 'Delete a component', input: { componentId: 'cmp_headline' } }],
  async handler(ctx, input) {
    await requireServices(ctx).components.delete({
      userId: ctx.actor.userId,
      componentId: input.componentId,
      folderId: targetFolderId(ctx),
    })
    return { deleted: true as const }
  },
})

// ---------------------------------------------------------------------------
// component.stamp
// ---------------------------------------------------------------------------

/**
 * The plan for filling a text slot. A structured body is written as given.
 * A plain string keeps the slot's formatting: each new paragraph takes the
 * inline style of the first run and the list attributes of the placeholder
 * paragraph at the same position (the last one for extra paragraphs), so a
 * bold, brand-coloured headline stays bold and brand-coloured.
 */
function slotPlan(placeholder: Y.Text, body: TextBodyInput): BodyPlan {
  const plan = planFromBody(body)
  return typeof body === 'string' ? formattedLike(placeholder, plan) : plan
}

/**
 * The plan for a text slot a restamp keeps: its paragraphs' text, formatted
 * like the master's placeholder exactly as `slotPlan` formats a plain string
 * (the slot's own inline formatting gives way to the master's).
 */
function restampSlotPlan(placeholder: Y.Text, current: Y.Text): BodyPlan {
  const paragraphs = getParagraphDeltas(current).map((p) => ({
    text: p.ops.map((op) => (typeof op.insert === 'string' ? op.insert : '')).join(''),
  }))
  return formattedLike(placeholder, planFromBody({ paragraphs }))
}

/** `plan`'s text with the placeholder's formatting, paragraph by paragraph (see slotPlan). */
function formattedLike(placeholder: Y.Text, plan: BodyPlan): BodyPlan {
  const template = getParagraphDeltas(placeholder)
  if (template.length === 0) return plan
  const paragraphs = plan.paragraphs.map((p, i) => {
    const t = template[Math.min(i, template.length - 1)]!
    const inline = t.ops[0]?.attributes ?? {}
    return {
      runs: p.runs.map((r) => ({ text: r.text, attrs: { ...inline } })),
      block: { ...t.attrs },
    }
  })
  return {
    paragraphs,
    hasBlocks: paragraphs.some((p) => blockAttrsToInsertAttrs(p.block) !== undefined),
  }
}

/** What stamping a master wrote: `component.stamp`'s output. */
export interface StampResult {
  objectIds: string[]
  filledSlots: string[]
  at: { x: number; y: number }
}

/**
 * Stamp `master` onto `input.slide` of `deck` and fill its text slots — the
 * body of `component.stamp`, shared with the editor's server-side stamp
 * (POST /decks/:id/stamp-component). Every check runs before the first
 * write, so a refusal leaves the deck untouched; `wrote.value` turns true
 * the moment the deck is changed. Synchronous: call it inside the one
 * transaction of the write.
 */
export function stampMaster(
  deck: DeckMutationContext,
  master: ComponentMaster,
  input: {
    componentId: string
    slide: SlideRef
    at?: { x: number; y: number } | undefined
    slots?: Record<string, TextBodyInput> | undefined
  },
  wrote?: { value: boolean },
): StampResult {
  const slide = resolveSlide(deck, input.slide)
  const objects = objectsOf(deck, slide)
  const view = openMaster(master)
  try {
    if (view.objects.length === 0) {
      throw new CommandError('conflict', `component '${input.componentId}' has no objects to stamp`)
    }
    // Every slot must name a text object of the master — checked before the first write.
    const slotNames = Object.keys(input.slots ?? {})
    const textSlots = new Set(
      slotsOf(view.objects)
        .filter((s) => s.type === 'text')
        .map((s) => s.name),
    )
    const unknown = slotNames.filter((n) => !textSlots.has(n))
    if (unknown.length > 0) {
      throw new CommandError(
        'invalid_input',
        `component '${input.componentId}' has no text slot named ${unknown.map((n) => `'${n}'`).join(', ')}` +
          ` (its text slots: ${[...textSlots].map((n) => `'${n}'`).join(', ') || 'none'})`,
      )
    }

    const bounds = masterBounds(view.objects)
    const at = input.at ?? { x: bounds.x, y: bounds.y }
    if (wrote !== undefined) wrote.value = true
    const ids = stampComponent(objects, view.doc, at, input.componentId)

    // stampComponent copies the master objects in order, with the same
    // "has a type" rule openMaster applies, so ids[i] is the copy of
    // view.objects[i].
    const filled = new Set<string>()
    if (slotNames.length > 0 && ids.length === view.objects.length) {
      const stamped = requireObjects(objects, ids, slide.id)
      view.objects.forEach((m, i) => {
        const name = slotOf(m)
        const body = name !== null ? input.slots?.[name] : undefined
        if (name === null || body === undefined) return
        const text = stamped.get(ids[i]!)?.get('text')
        if (!(text instanceof Y.Text)) return
        writePlan(deck.doc, text, slotPlan(text, body))
        filled.add(name)
      })
    }
    return { objectIds: ids, filledSlots: [...filled], at }
  } finally {
    view.doc.destroy()
  }
}

export const componentStamp = defineCommand({
  ...serverCommand,
  id: 'component.stamp',
  domain: 'component',
  title: 'Stamp component',
  description:
    "Place one of the deck's folder components on a slide and fill its text slots in the same step. The master's " +
    'objects are copied as ordinary objects with fresh ids — rich text, groups and table content included; the ' +
    "master's animations are not copied. Each copy records its component (`component`): component.restamp " +
    're-applies a changed master. Without `at` ' +
    'the copy lands where the master was drawn (its bounding box top-left); `at` moves that corner. `slots` maps ' +
    'slot names (component.get lists them) to text: a plain string keeps the ' +
    "slot's formatting, { paragraphs } sets it explicitly. The stamp shows the master's own pictures and videos " +
    "(linked, not copied: a deck may show its folder's component media). Returns the new object ids in stacking " +
    "order. Use the folder's existing components for the roles they cover; do not stamp for one-off content. " +
    "Needs the editor role on the deck and a role in its folder (the folder's components are its members').",
  input: z.strictObject({
    componentId: ComponentIdSchema,
    slide: SlideRefSchema,
    at: z
      .strictObject({ x: z.number(), y: z.number() })
      .optional()
      .describe(
        "Top-left of the stamped copy, in slide px (default: where the master's objects sit)",
      ),
    slots: z
      .record(z.string().min(1).max(200), TextBodyInputSchema)
      .optional()
      .describe('Text per slot name, e.g. { "title": "Q3 results", "subtitle": "Revenue up 12%" }'),
  }),
  output: z.object({
    objectIds: z.array(z.string()).describe('The stamped objects, in stacking order'),
    filledSlots: z.array(z.string()),
    at: z.object({ x: z.number(), y: z.number() }),
  }),
  role: 'editor',
  scope: 'deck',
  effects: ['doc', 'server'],
  undo: 'undoable',
  confirm: 'never',
  routes: [POST('/decks/:id/stamp-component')],
  implementedWith: [
    'stampComponent',
    'getParagraphDeltas',
    'spliceRichText',
    'applyFormat',
    'updateParagraphsInRange',
  ],
  examples: [
    {
      title: 'Stamp the headline block and fill it',
      input: {
        componentId: 'cmp_headline',
        slide: 's2',
        slots: { title: 'Q3 results', subtitle: 'Revenue up 12% year on year' },
      },
    },
    {
      title: 'Stamp at a position without filling',
      input: { componentId: 'cmp_headline', slide: { index: 2 }, at: { x: 120, y: 80 } },
    },
  ],
  async load(ctx, input): Promise<PreparedStamp> {
    return requireServices(ctx).components.prepareStamp({
      userId: ctx.actor.userId,
      componentId: input.componentId,
      deckId: targetDeckId(ctx),
    })
  },
  release: (prepared) => prepared.discard(),
  // The deck may have moved to another folder while the stamp was staged:
  // its linked pictures are then copied into it (server:
  // services/localiseMedia.ts carryLinkedMedia).
  settle: (prepared) => prepared.settle(),
  handler(ctx, input, prepared) {
    const wrote = { value: false }
    try {
      return stampMaster(requireDeck(ctx), prepared.master, input, wrote)
    } catch (e) {
      // Refused before the first write: nothing references the media
      // copied for this stamp.
      if (!wrote.value) void prepared.discard()
      throw e
    }
  },
})

// ---------------------------------------------------------------------------
// component.restamp
// ---------------------------------------------------------------------------

/** What restamping wrote on one slide: part of `component.restamp`'s output. */
export interface RestampedSlide {
  slide: string
  stamps: number
  updated: string[]
  added: string[]
  removed: string[]
  removedAnimations: string[]
}

function isStampOf(m: Y.Map<unknown>, componentId: string): boolean {
  const c = m.get('component') as { id?: unknown } | undefined
  return typeof c === 'object' && c !== null && c.id === componentId
}

/**
 * Re-apply `master` to its stamps on `input.slide` of `deck`, or on every
 * slide — the body of `component.restamp`. slide-model's `restampComponent`
 * updates each stamp in place; the text slots it kept are then given the
 * master's formatting the way `stampMaster` fills a slot. Every check runs
 * before the first write; `wrote.value` turns true the moment the deck is
 * changed. Synchronous: call it inside the one transaction of the write.
 */
export function restampMaster(
  deck: DeckMutationContext,
  master: ComponentMaster,
  input: { componentId: string; slide?: SlideRef | undefined },
  wrote?: { value: boolean },
): { slides: RestampedSlide[] } {
  const slides =
    input.slide !== undefined
      ? [resolveSlide(deck, input.slide)]
      : deck.slides.toArray().map((m) => resolveSlide(deck, m.get('id') as string))
  const view = openMaster(master)
  try {
    if (view.objects.length === 0) {
      throw new CommandError(
        'conflict',
        `component '${input.componentId}' has no objects; restamping would empty its stamps`,
      )
    }
    const placeholders = new Map<string, Y.Text>()
    for (const m of view.objects) {
      const text = m.get('text')
      if (text instanceof Y.Text) placeholders.set(m.get('id') as string, text)
    }
    const out: RestampedSlide[] = []
    for (const slide of slides) {
      const objects = objectsOf(deck, slide)
      if (!objects.objects.toArray().some((m) => isStampOf(m, input.componentId))) continue
      if (wrote !== undefined) wrote.value = true
      const r = restampComponent(objects, animationsOf(deck, slide), view.doc, input.componentId)
      for (const { objectId, masterObjectId } of r.textSlots) {
        const body = objects.objects
          .toArray()
          .find((m) => m.get('id') === objectId)
          ?.get('text')
        const placeholder = placeholders.get(masterObjectId)
        if (body instanceof Y.Text && placeholder !== undefined)
          writePlan(deck.doc, body, restampSlotPlan(placeholder, body))
      }
      out.push({
        slide: slide.id,
        stamps: r.stamps.length,
        updated: r.stamps.flatMap((st) => st.updated),
        added: r.stamps.flatMap((st) => st.added),
        removed: r.stamps.flatMap((st) => st.removed),
        removedAnimations: r.removedAnimations,
      })
    }
    return { slides: out }
  } finally {
    view.doc.destroy()
  }
}

export const componentRestamp = defineCommand({
  ...serverCommand,
  id: 'component.restamp',
  domain: 'component',
  title: 'Restamp component',
  description:
    "Reset a component's stamps to its current master — on `slide`, or without it the whole deck — only when " +
    'the user asks to bring them up to date: stamps are detached, a master change never reaches them by itself. ' +
    'Change the master first (object and text commands with componentId); for a new stamp use component.stamp. ' +
    'Each stamp is updated in place (ids, so animations, kept; where people moved it) with every master ' +
    'property, overwriting local edits to it (colour, size, name, lock, link…), except slot content: a text slot ' +
    'keeps its text in the master formatting, a picture slot its picture, a table slot its cells. Every master ' +
    'object comes back, also ones deleted from the stamp; objects no longer in the master go with their ' +
    'animations. Ask the user before restamping a whole deck. An empty master is refused. Needs the editor role ' +
    'on the deck and a role in its folder.',
  input: z.strictObject({
    componentId: ComponentIdSchema,
    slide: SlideRefSchema.optional(),
  }),
  output: z.object({
    slides: z
      .array(
        z.object({
          slide: z.string(),
          stamps: z.number().describe('Stamps of the component restamped on the slide'),
          updated: z.array(z.string()),
          added: z
            .array(z.string())
            .describe('Master objects the stamps lacked (deleted, never copied or new), restored'),
          removed: z.array(z.string()).describe('Objects no longer in the master, deleted'),
          removedAnimations: z.array(z.string()),
        }),
      )
      .describe('Slides that had stamps of the component'),
  }),
  role: 'editor',
  scope: 'deck',
  effects: ['doc', 'server'],
  idempotent: true,
  undo: 'undoable',
  confirm: 'never',
  implementedWith: [
    'restampComponent',
    'getParagraphDeltas',
    'spliceRichText',
    'applyFormat',
    'updateParagraphsInRange',
  ],
  examples: [
    {
      title: 'Restamp the headline block on one slide',
      input: { componentId: 'cmp_headline', slide: 's2' },
    },
    { title: 'Restamp it across the deck', input: { componentId: 'cmp_headline' } },
  ],
  async load(ctx, input): Promise<PreparedStamp> {
    return requireServices(ctx).components.prepareStamp({
      userId: ctx.actor.userId,
      componentId: input.componentId,
      deckId: targetDeckId(ctx),
      purpose: 'restamp',
    })
  },
  release: (prepared) => prepared.discard(),
  settle: (prepared) => prepared.settle(),
  handler(ctx, input, prepared) {
    const wrote = { value: false }
    try {
      return restampMaster(requireDeck(ctx), prepared.master, input, wrote)
    } catch (e) {
      if (!wrote.value) void prepared.discard()
      throw e
    }
  },
})

export const componentPromote = defineCommand({
  ...serverCommand,
  id: 'component.promote',
  domain: 'component',
  title: 'Make component from objects',
  description:
    "Make a new component of this deck's folder from objects on one of its slides, for a block that recurs on " +
    'many slides (a headline block, the pagination, a card grid) — a folder keeps only a few. The objects become ' +
    'the master as they are: a group brings its members, rich text, tables and their animations come along; the ' +
    'slide is not changed. Pictures and videos are copied into the component; links to slides are removed. ' +
    "An object's `slot` (else its name) makes it a slot (component.stamp fills text slots by it), so set `slot` on " +
    'the text boxes (object.update) first; a stamp link (`component`) is dropped. Needs the editor role in the ' +
    "deck's folder. Undo: component.delete.",
  input: z.strictObject({
    slide: SlideRefSchema,
    objects: ObjectIdsSchema.describe('The objects to promote (a group id brings its members)'),
    name: z
      .string()
      .max(200)
      .refine((t) => t.trim().length > 0, 'the name must not be blank')
      .describe('The component name the folder lists it under'),
  }),
  output: z.object({
    component: ComponentOutput,
    objectCount: z.number().describe('Objects in the master'),
    mediaCopied: z.number().describe('Pictures and videos copied into the component'),
    skippedImages: z.number().describe('Pictures whose file could not be copied'),
    droppedLinks: z.number().describe('Links to slides (removed)'),
  }),
  role: 'editor',
  scope: 'deck',
  effects: ['server'],
  undo: 'undoable',
  undoneBy: 'component.delete',
  confirm: 'never',
  routes: [POST('/decks/:id/promote-component')],
  implementedWith: ['promoteToComponent', 'writeComponentMaster', 'insertObjectsWithRichText'],
  examples: [
    {
      title: 'Make the headline block a component',
      input: { slide: 's2', objects: ['hd1'], name: 'Headline' },
    },
  ],
  async handler(ctx, input) {
    return requireServices(ctx).components.promote({
      userId: ctx.actor.userId,
      deckId: targetDeckId(ctx),
      slide: input.slide,
      objects: input.objects,
      name: input.name.trim(),
    })
  },
})

export const componentCommands = [
  componentList,
  componentCreate,
  componentGet,
  componentRename,
  componentDelete,
  componentPromote,
  componentStamp,
  componentRestamp,
]
