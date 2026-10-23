/**
 * commands/src/commands/layouts.ts — slides laid out with the folder's style
 * pack (agentic A4.4): `slide.applyLayout` lays one slide out with a pack
 * layout, `style.deck.apply` re-lays every laid-out slide of a deck with its
 * folder's pack, sets the deck's variant and footer fields, and puts the
 * pack's grid in as guides. Both run in the editor and on the server; the
 * plan is stylePack/layout.ts.
 */

import { z } from 'zod'
import * as Y from 'yjs'
import {
  ArchetypeSchema,
  PackRegionSchema,
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  type StylePack,
} from '@narrative/shared'
import {
  addGuide,
  addObject,
  getDeckGuidesCtx,
  listDeckGuides,
  listSlides,
  moveObjectToIndex,
  readDeckMeta,
  readSlideLayout,
  addSlide,
  moveSlide,
  removeObject,
  removeSlide,
  setDeckMeta,
  setDeckSpec,
  setSlideBrief,
  setSlideLayout,
  setSlideSpecKey,
  setSlideNotes,
  updateObject,
  updateSlideBackground,
  type DeckMutationContext,
  type FolderTokensSnapshot,
} from '@narrative/slide-model'
import { defineCommand } from '../registry.js'
import { requireDeck, resolveSlide, objectsOf, SlideRefSchema } from '../refs.js'
import { CommandError } from '../errors.js'
import type { CommandContext } from '../types.js'
import {
  layoutForArchetype,
  planLayout,
  type LayoutPlan,
  type SlotContent,
} from '../stylePack/layout.js'
import { storedStylePack } from '../stylePack/parse.js'
import { checkDeck } from '../stylePack/check.js'
import { normalizeOutline } from '../outline.js'
import { titleGuess } from './queries.js'
import { planBuild } from '../stylePack/buildPlan.js'
import { rebindToPack, restyleLayout } from '../stylePack/restyle.js'
import {
  DeckSpecSchema,
  MAX_SPEC_BYTES,
  refuseIssues,
  validateDeckSpec,
  type DeckSpec,
} from '../stylePack/deckSpec.js'
import { targetDocument } from './serverShared.js'
import { loadNotesMarkdown, type NotesMarkdown } from './slides.js'
import { TextBodyInputSchema, writePlan } from '../text/body.js'

const layoutCommand = {
  role: 'editor',
  effects: ['doc'],
  undo: 'undoable',
  confirm: 'never',
  hosts: ['browser', 'server'],
  readsStylePack: true,
  readsFolderTokens: true,
  // A component master is a one-slide document of the same kind: it can be
  // laid out with a pack layout too (its folder is the deck's).
  acceptsComponent: true,
} as const

/** The folder's pack and tokens, or the reason a command cannot lay out without them. */
function packAndTokens(ctx: CommandContext): { pack: StylePack; tokens: FolderTokensSnapshot } {
  if (ctx.stylePack === undefined || ctx.folderTokens === undefined)
    throw new CommandError('conflict', "the folder's style pack cannot be read here")
  if (ctx.stylePack === null)
    throw new CommandError(
      'not_found',
      "the deck's folder has no style pack (style.pack.edit sets one; style.pack.get reads it)",
    )
  if (ctx.folderTokens === null)
    throw new CommandError(
      'conflict',
      'the folder has no tokens; compile its pack first (style.pack.edit { op: "compile" })',
    )
  return { pack: storedStylePack(ctx.stylePack), tokens: ctx.folderTokens }
}

/** Write a layout plan onto one slide (inside the command's transaction). */
function executePlan(deck: DeckMutationContext, slideId: string, plan: LayoutPlan): void {
  const slide = resolveSlide(deck, { id: slideId })
  const objects = objectsOf(deck, slide)
  for (const id of plan.remove) removeObject(objects, id)
  for (const u of plan.update) {
    updateObject(objects, u.id, u.patch as never)
    if (u.body !== undefined) {
      const map = objects.objects.toArray().find((m) => m.get('id') === u.id)
      const text = map?.get('text')
      if (text instanceof Y.Text) writePlan(deck.doc, text, u.body)
    }
  }
  for (const obj of plan.add) {
    addObject(objects, obj)
    // Decoration and pictures the pack draws sit behind the content.
    if (obj.role === 'furniture' && obj.type !== 'text') moveObjectToIndex(objects, obj.id, 0)
  }
  updateSlideBackground(deck, slideId, plan.background)
  setSlideLayout(deck, slideId, plan.layout)
}

/** A slot's content: text (a string or paragraphs) or a picture `{ assetId, focus? }`. */
const SlotContentSchema = z.union([
  z.strictObject({
    assetId: z.string().min(1).max(64),
    focus: PackRegionSchema.shape.focus.describe(
      "The side of the picture kept in view (default: the layout's)",
    ),
  }),
  TextBodyInputSchema,
])

export const slideApplyLayout = defineCommand({
  ...layoutCommand,
  id: 'slide.applyLayout',
  domain: 'slide',
  title: 'Lay a slide out with a pack layout',
  description:
    'Lay a slide out with one of its folder\'s style pack layouts (style.pack.get "layouts" lists them by ' +
    "purpose and slots): each slot becomes a box in the brand's text style and place, a picture, or the " +
    "pack's component; the pack's footer, page number and decoration are drawn. `content` fills slots by " +
    'name: text (a string or { paragraphs }) or a picture { assetId }. On a slide with a layout already, its ' +
    'text and pictures move into the slots of the same name, else of their `role` (top to bottom, left to ' +
    'right; on a plain slide set roles with object.update first); `unplaced` lists what stayed. `archetype` ' +
    'instead of `layoutId` takes the layout the pack maps to that kind of slide. `surface`: where the layout ' +
    'offers a choice (a photo tone). The pack must be compiled. Undo: one step.',
  input: z
    .strictObject({
      slide: SlideRefSchema,
      layoutId: z.string().min(1).max(48).optional(),
      archetype: ArchetypeSchema.optional(),
      content: z.record(z.string().min(1).max(200), SlotContentSchema).optional(),
      surface: z.string().min(1).max(48).optional(),
    })
    .refine((i) => (i.layoutId === undefined) !== (i.archetype === undefined), {
      message: 'Give exactly one of layoutId and archetype',
    }),
  output: z.object({
    slide: z.string(),
    layoutId: z.string(),
    added: z.number(),
    updated: z.number(),
    removed: z.number(),
    unplaced: z
      .array(z.string())
      .describe('Objects left where they were: no slot or role the layout has a place for'),
  }),
  implementedWith: [
    'addObject',
    'updateObject',
    'removeObject',
    'moveObjectToIndex',
    'updateSlideBackground',
    'setSlideLayout',
  ],
  examples: [
    {
      title: 'A title-and-bullets slide with its content',
      input: {
        slide: 's2',
        layoutId: 'title-bullets',
        content: {
          title: 'Revenue grew in every region',
          bullets: { paragraphs: [{ text: 'Europe +12%' }, { text: 'Americas +8%' }] },
        },
      },
    },
    {
      title: "The pack's picture slide, a portrait kept to its top",
      input: {
        slide: 's3',
        archetype: 'picture',
        content: {
          picture: { assetId: 'asset-fixture', focus: 'top' },
          statement: 'Our people make the difference',
        },
      },
    },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const { pack, tokens } = packAndTokens(ctx)
    const slide = resolveSlide(deck, input.slide)
    const objects = objectsOf(deck, slide)
    const slides = listSlides(deck)
    const layoutId =
      input.layoutId ??
      layoutForArchetype(pack, input.archetype!, new Set(Object.keys(input.content ?? {}))).id
    const plan = planLayout({
      pack,
      layoutId,
      ...(input.archetype !== undefined ? { archetype: input.archetype } : {}),
      tokens,
      meta: readDeckMeta(deck.doc),
      objects: objects.objects.toArray(),
      current: readSlideLayout(slide.map.get('layout')),
      ...(input.content !== undefined
        ? { content: input.content as Record<string, SlotContent> }
        : {}),
      ...(input.surface !== undefined ? { surface: input.surface } : {}),
      slideNumber: slides.findIndex((s) => s.id === slide.id) + 1,
    })
    executePlan(deck, slide.id, plan)
    return {
      slide: slide.id,
      layoutId,
      added: plan.add.length,
      updated: plan.update.length,
      removed: plan.remove.length,
      unplaced: plan.unplaced,
    }
  },
})

/** The pack's grid as guides: margins, column edges, band tops — the ones the deck does not have yet. */
function addPackGuides(deck: DeckMutationContext, pack: StylePack): number {
  const g = pack.grid
  const vertical = new Set<number>([g.margins.left, SLIDE_WIDTH - g.margins.right])
  for (const [l, r] of g.columns) {
    vertical.add(l)
    vertical.add(r)
  }
  const horizontal = new Set<number>(
    [
      g.margins.top,
      SLIDE_HEIGHT - g.margins.bottom,
      g.bands.title,
      g.bands.subtitle,
      g.bands.content,
      g.bands.footer,
    ].filter((v): v is number => v !== undefined),
  )
  const guides = getDeckGuidesCtx(deck.doc)
  const existing = listDeckGuides(guides)
  const has = (o: 'horizontal' | 'vertical', p: number): boolean =>
    existing.some((e) => e.orientation === o && Math.abs(e.position - p) < 0.5)
  let added = 0
  for (const p of vertical)
    if (!has('vertical', p)) {
      addGuide(guides, 'vertical', p)
      added++
    }
  for (const p of horizontal)
    if (!has('horizontal', p)) {
      addGuide(guides, 'horizontal', p)
      added++
    }
  return added
}

const BuiltSlideOutput = z.object({
  slide: z.string(),
  index: z.number(),
  layoutId: z.string(),
  archetype: ArchetypeSchema.optional(),
  emptySlots: z
    .array(z.string())
    .describe('Slots left without content: fill them, or pick another layout'),
  unplaced: z.array(z.string()).describe('Objects of a reused slide the layout had no place for'),
})

/** At most this many distinct pictures in one spec (each is looked up in the media). */
const MAX_SPEC_PICTURES = 60

/** Refuse a spec over the size a deck keeps. */
function specSize(spec: DeckSpec): void {
  const bytes = new TextEncoder().encode(JSON.stringify(spec)).length
  if (bytes > MAX_SPEC_BYTES)
    throw new CommandError(
      'invalid_input',
      `the spec is ${Math.round(bytes / 1024)} kB; a deck keeps at most ${MAX_SPEC_BYTES / 1024} kB`,
    )
}

/**
 * Build the deck from a spec (A5.3): its meta and spec, then its slides in
 * the spec's order — reused, added, the rest removed — each laid out with
 * its plan, its notes and brief. Inside the command's one transaction.
 */
function buildFromSpec(
  deck: DeckMutationContext,
  pack: StylePack,
  tokens: FolderTokensSnapshot,
  spec: DeckSpec,
  replace: boolean,
  markdown: NotesMarkdown | null,
) {
  specSize(spec)
  const before = listSlides(deck)
  const build = planBuild({
    spec,
    pack,
    tokens,
    slides: before.map((s) => ({
      id: s.id,
      ...(s.layout !== undefined ? { layout: s.layout } : {}),
      ...(s.specKey !== undefined ? { specKey: s.specKey } : {}),
      objects: objectsOf(deck, resolveSlide(deck, { id: s.id })).objects.toArray(),
    })),
  })
  if (build.handMade.length > 0 && !replace)
    throw new CommandError(
      'conflict',
      `slides ${build.handMade.join(', ')} were not built from a spec, and a build keeps only its ` +
        'own slides — replace: true removes them',
    )
  // An earlier build's slides the spec no longer has go; slides made by hand with `replace`.
  const goes = [...build.superseded, ...build.handMade]

  const titles = new Map(before.map((s) => [s.id, titleGuess(s)]))
  setDeckMeta(deck.doc, build.meta)
  setDeckSpec(deck.doc, spec as unknown as Record<string, unknown>)

  // The slides in the spec's order: reused ones moved into place, new ones
  // added, then what the spec does not keep removed (never the deck's last).
  const ids = build.slides.map((b) => b.slideId ?? addSlide(deck).id)
  ids.forEach((id, i) => moveSlide(deck, id, i))
  for (const id of goes) removeSlide(deck, id)
  // The outline (indents) stays well-formed where slides went, as slide.delete keeps it.
  normalizeOutline(deck)

  const slides = build.slides.map((b, i) => {
    const id = ids[i]!
    executePlan(deck, id, b.plan)
    // A kept slide keeps its notes (people may have written them since).
    if (!b.kept && b.notes !== undefined && markdown !== null)
      setSlideNotes(deck, id, markdown.notesFromMarkdown(b.notes))
    setSlideBrief(deck, id, b.brief ?? null)
    setSlideSpecKey(deck, id, b.specKey)
    return {
      slide: id,
      index: i,
      layoutId: b.layoutId,
      ...(b.archetype !== undefined ? { archetype: b.archetype } : {}),
      emptySlots: b.plan.emptySlots,
      unplaced: b.plan.unplaced,
    }
  })
  // What the agent should look at first: the check, unmeasured.
  const all = listSlides(deck)
  const report = checkDeck({
    pack,
    tokens,
    meta: readDeckMeta(deck.doc),
    slides: all.map((slide, index) => ({ slide, index })),
    measurement: null,
    deck: all,
  })
  return {
    slides,
    removed: goes.map((id) => {
      const title = titles.get(id)
      return { slide: id, ...(title !== undefined ? { title } : {}) }
    }),
    check: { errors: report.errors, warnings: report.warnings },
  }
}

/** What style.deck.apply loads for a spec: the notes' Markdown converter, and the pictures it cannot find. */
interface SpecLoad {
  markdown: NotesMarkdown | null
  missingPictures: string[]
}

export const styleDeckApply = defineCommand({
  ...layoutCommand,
  id: 'style.deck.apply',
  domain: 'style',
  title: "Re-style a deck with its folder's pack",
  description:
    "Re-lay every slide of the deck that follows a pack layout with its folder's style pack, keeping each " +
    "slot's content, and redraw the pack's footer, page numbers and decoration. `variant`: one value per pack " +
    'axis (style.pack.get "summary" lists them), its colours follow; `fields` fills footer fields (null ' +
    "clears one); `lang` picks the footer language; `guides` (default true) adds the pack's grid as guides. A " +
    'slide whose layout the pack lacks is left as it is, one on a surface its layout no longer offers goes to ' +
    'the default; both are listed. `spec` instead builds the whole deck from a deck spec (the build-deck ' +
    'playbook), checked against the pack first; building again keeps the slides of unchanged spec slides, ' +
    'edits included, and builds the rest fresh; slides not built from a spec are refused unless `replace: ' +
    'true`. The deck keeps the spec to build again (query.deck { spec: true }), as deck content every viewer ' +
    'has (spec: null forgets it). `relayout: "archetype"` also restyles slides on another pack\'s layout: each ' +
    "takes this pack's layout for its archetype, its content by slot and role, this pack's colours and text " +
    'styles by purpose; `slides` limits it. Not in ops.apply. Undo: one step.',
  input: z
    .strictObject({
      variant: z.record(z.string().min(1).max(48), z.string().min(1).max(48)).optional(),
      fields: z.record(z.string().min(1).max(48), z.string().max(400).nullable()).optional(),
      lang: z
        .string()
        .regex(/^[a-z]{2}$/)
        .nullable()
        .optional(),
      guides: z.boolean().optional(),
      spec: DeckSpecSchema.nullable()
        .optional()
        .describe('A deck spec to build; null forgets the one the deck keeps'),
      replace: z
        .boolean()
        .optional()
        .describe('With spec: remove the slides the spec does not keep'),
      relayout: z
        .literal('archetype')
        .optional()
        .describe("Restyle slides on another pack's layouts onto this pack's, by archetype"),
      slides: z
        .array(SlideRefSchema)
        .min(1)
        .max(500)
        .optional()
        .describe('With relayout: only these'),
    })
    .refine(
      (i) =>
        i.spec === undefined ||
        i.spec === null ||
        (i.variant === undefined && i.fields === undefined && i.lang === undefined),
      { message: "with spec, the variant, fields and language are the spec's" },
    )
    .refine((i) => i.spec == null || i.relayout === undefined, {
      message: 'give spec or relayout, not both',
    })
    .refine((i) => i.slides === undefined || i.relayout !== undefined, {
      message: 'slides names what relayout restyles',
    }),
  output: z.object({
    slides: z.number().describe('Slides re-laid, or built'),
    unmatched: z
      .array(z.string())
      .describe(
        'Slides whose layout the pack lacks: they keep another look until slide.applyLayout',
      ),
    surfaceReset: z
      .array(z.string())
      .describe(
        "Slides back on their layout's default surface: the one they had is no longer offered",
      ),
    guidesAdded: z.number(),
    restyled: z
      .array(z.string())
      .optional()
      .describe("With relayout: slides moved from another pack's layout onto this pack's"),
    built: z
      .object({
        slides: z.array(BuiltSlideOutput),
        removed: z
          .array(z.object({ slide: z.string(), title: z.string().optional() }))
          .describe('Slides the build removed (replace: true)'),
        check: z
          .object({ errors: z.number(), warnings: z.number() })
          .describe('query.check of the built deck, unmeasured: where to look first'),
      })
      .optional()
      .describe('With spec: each slide built'),
  }),
  implementedWith: [
    'setDeckMeta',
    'setDeckSpec',
    'addGuide',
    'addObject',
    'updateObject',
    'removeObject',
    'moveObjectToIndex',
    'updateSlideBackground',
    'setSlideLayout',
    'setSlideBrief',
    'setSlideSpecKey',
    'setSlideNotes',
    'rewriteTokenRefs',
    'addSlide',
    'moveSlide',
    'removeSlide',
  ],
  examples: [
    { title: 'Switch the deck to the dark variant', input: { variant: { background: 'dark' } } },
    { title: "Fill the footer's client field", input: { fields: { client: 'Example AG' } } },
    {
      title: "Restyle the slides copied in from another brand's deck",
      input: { relayout: 'archetype' },
    },
    {
      title: 'Build the deck from a spec: a cover and a content slide',
      input: {
        spec: {
          schemaVersion: 1,
          packId: 'example',
          fields: { client: 'Acme' },
          slides: [
            { archetype: 'cover', slots: { title: 'Q3 review', subtitle: 'Board meeting' } },
            {
              archetype: 'content',
              message: 'Every region grew',
              slots: {
                title: 'Revenue grew in every region',
                bullets: 'Europe +12 %\n\nAsia +15 %',
              },
              notes: 'Start with **Asia**.',
            },
          ],
        },
        replace: true,
      },
    },
  ],
  async load(ctx, input): Promise<SpecLoad> {
    const spec = input.spec
    if (spec === undefined || spec === null) return { markdown: null, missingPictures: [] }
    // Cheap refusals first, before any media lookup: the size, a master as
    // the target, and the spec against the pack (only pictures in slots that
    // take one are looked up).
    specSize(spec)
    if (ctx.target?.componentId !== undefined)
      throw new CommandError('invalid_input', 'a component master is one slide: build decks only')
    if (ctx.stylePack !== undefined && ctx.stylePack !== null)
      refuseIssues(
        validateDeckSpec(spec, storedStylePack(ctx.stylePack)),
        storedStylePack(ctx.stylePack).id,
      )
    const markdown = spec.slides.some((s) => s.notes !== undefined)
      ? await loadNotesMarkdown()
      : null
    // Every picture the spec names must be one the deck shows (its own or
    // its folder's), as media.url answers for it: not_found for one that is
    // not, unknown or not readable alike. Checked on the server, which has
    // the media service; the editor builds no specs.
    const missingPictures: string[] = []
    const media = ctx.services?.media
    if (media !== undefined) {
      const wanted = new Map<string, string[]>()
      for (const [i, slide] of spec.slides.entries())
        for (const [slot, value] of Object.entries(slide.slots ?? {}))
          if (typeof value === 'object' && 'assetId' in value)
            wanted.set(value.assetId, [
              ...(wanted.get(value.assetId) ?? []),
              `slides.${i}.slots.${slot}`,
            ])
      if (wanted.size > MAX_SPEC_PICTURES)
        throw new CommandError(
          'invalid_input',
          `the spec names ${wanted.size} pictures; a build takes at most ${MAX_SPEC_PICTURES}`,
        )
      const owner = targetDocument(ctx)
      for (const [assetId, paths] of wanted) {
        const ok = await media
          .url({ userId: ctx.actor.userId, assetId, variant: 'thumb', owner })
          .then(
            () => true,
            (e: unknown) => {
              if (e instanceof CommandError && e.code === 'not_found') return false
              throw e
            },
          )
        if (!ok) for (const path of paths) missingPictures.push(`${path}: no picture '${assetId}'`)
      }
    }
    return { markdown, missingPictures }
  },
  handler(ctx, input, loaded: SpecLoad) {
    const deck = requireDeck(ctx)
    const { pack, tokens } = packAndTokens(ctx)
    // The spec is part of the deck, so every viewer's copy holds it: null forgets it.
    if (input.spec === null) setDeckSpec(deck.doc, null)
    if (input.spec !== undefined && input.spec !== null) {
      if (loaded.missingPictures.length > 0)
        throw new CommandError(
          'invalid_input',
          `the spec names pictures that are not in the deck's or its folder's media (media.upload adds one): ${loaded.missingPictures.join('; ')}`,
        )
      const built = buildFromSpec(
        deck,
        pack,
        tokens,
        input.spec,
        input.replace === true,
        loaded.markdown,
      )
      const guidesAdded = input.guides !== false ? addPackGuides(deck, pack) : 0
      return {
        slides: built.slides.length,
        unmatched: [],
        surfaceReset: [],
        guidesAdded,
        built,
      }
    }
    // The variant must name the pack's axes and values.
    for (const [axis, value] of Object.entries(input.variant ?? {})) {
      const a = pack.tokens.axes.find((x) => x.id === axis)
      if (a === undefined)
        throw new CommandError(
          'invalid_input',
          `the pack has no variant axis '${axis}'; it has ${pack.tokens.axes.map((x) => x.id).join(', ')}`,
        )
      if (!a.values.some((v) => v.id === value))
        throw new CommandError(
          'invalid_input',
          `axis '${axis}' has no value '${value}'; it has ${a.values.map((v) => v.id).join(', ')}`,
        )
    }
    const meta = readDeckMeta(deck.doc)
    const variant = { ...(meta.variant ?? {}), ...(input.variant ?? {}) }
    const fields = { ...(meta.fields ?? {}) }
    for (const [k, v] of Object.entries(input.fields ?? {})) {
      if (v === null) delete fields[k]
      else fields[k] = v
    }
    setDeckMeta(deck.doc, {
      ...(input.variant !== undefined ? { variant } : {}),
      ...(input.fields !== undefined
        ? { fields: Object.keys(fields).length > 0 ? fields : null }
        : {}),
      ...(input.lang !== undefined ? { lang: input.lang } : {}),
    })
    const nextMeta = readDeckMeta(deck.doc)

    let relaid = 0
    const unmatched: string[] = []
    const surfaceReset: string[] = []
    const restyled: string[] = []
    const slides = listSlides(deck)
    // The slides a restyle takes: those named, else every slide on another pack's layout.
    const named =
      input.slides === undefined ? null : new Set(input.slides.map((r) => resolveSlide(deck, r).id))
    slides.forEach((s, index) => {
      const ref = s.layout
      const restyle = input.relayout === 'archetype' && (named === null || named.has(s.id))
      if (ref === undefined) {
        // A slide on no layout is classified first (roles, then slide.applyLayout).
        if (restyle && named !== null) unmatched.push(s.id)
        return
      }
      // Another pack's layout of the same id (a slide copied in) is not this one.
      let layout =
        ref.packId === pack.id ? pack.layouts.find((l) => l.id === ref.layoutId) : undefined
      const slide = resolveSlide(deck, { id: s.id })
      if (layout === undefined) {
        layout = restyle ? restyleLayout(pack, ref) : undefined
        if (layout === undefined) {
          unmatched.push(s.id)
          return
        }
        // Its colours and text styles onto this pack's, as they were drawn.
        rebindToPack(slide.map, pack, tokens, {
          ...(meta.variant !== undefined ? { variant: meta.variant } : {}),
          ...(ref.surface !== undefined ? { surface: ref.surface } : {}),
        })
        restyled.push(s.id)
      }
      // A surface the layout no longer offers (the pack was edited, or another
      // pack's slide): its default.
      const offered =
        ref.surface !== undefined &&
        layout.surface !== undefined &&
        !('fixed' in layout.surface) &&
        layout.surface.choose.includes(ref.surface)
      if (
        ref.surface !== undefined &&
        !offered &&
        layout.surface !== undefined &&
        !('fixed' in layout.surface)
      )
        surfaceReset.push(s.id)
      const plan = planLayout({
        pack,
        layoutId: layout.id,
        tokens,
        meta: nextMeta,
        objects: objectsOf(deck, slide).objects.toArray(),
        current: ref,
        ...(offered ? { surface: ref.surface } : {}),
        ...(ref.archetype !== undefined ? { archetype: ref.archetype } : {}),
        slideNumber: index + 1,
      })
      executePlan(deck, s.id, plan)
      relaid++
    })

    const guidesAdded = input.guides !== false ? addPackGuides(deck, pack) : 0
    return {
      slides: relaid,
      unmatched,
      surfaceReset,
      guidesAdded,
      ...(input.relayout !== undefined ? { restyled } : {}),
    }
  },
})

export const layoutCommands = [slideApplyLayout, styleDeckApply]
