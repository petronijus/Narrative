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
import { SLIDE_HEIGHT, SLIDE_WIDTH, type StylePack } from '@narrative/shared'
import {
  addGuide,
  addObject,
  getDeckGuidesCtx,
  listDeckGuides,
  listSlides,
  moveObjectToIndex,
  readDeckMeta,
  readSlideLayout,
  removeObject,
  setDeckMeta,
  setSlideLayout,
  updateObject,
  updateSlideBackground,
  type DeckMutationContext,
  type FolderTokensSnapshot,
} from '@narrative/slide-model'
import { defineCommand } from '../registry.js'
import { requireDeck, resolveSlide, objectsOf, SlideRefSchema } from '../refs.js'
import { CommandError } from '../errors.js'
import type { CommandContext } from '../types.js'
import { planLayout, type LayoutPlan, type SlotContent } from '../stylePack/layout.js'
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
  return { pack: ctx.stylePack, tokens: ctx.folderTokens }
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

/** A slot's content: text (a string or paragraphs) or a picture `{ assetId }`. */
const SlotContentSchema = z.union([
  z.strictObject({ assetId: z.string().min(1).max(64) }),
  TextBodyInputSchema,
])

export const slideApplyLayout = defineCommand({
  ...layoutCommand,
  id: 'slide.applyLayout',
  domain: 'slide',
  title: 'Lay a slide out with a pack layout',
  description:
    'Lay a slide out with one of its folder\'s style pack layouts (style.pack.get "layouts" lists them by ' +
    "purpose and slots): each slot becomes a box in the brand's text style and place, a picture, or the pack's " +
    "component; the pack's footer, page number and decoration are drawn. `content` fills slots by name: text " +
    '(a string or { paragraphs }) or a picture { assetId }. On a slide that has a layout already, the text and ' +
    "pictures of its slots move into the new layout's slots of the same name or role; objects without a slot " +
    'stay as they are. `surface`: where the layout offers a choice (a photo tone). The pack must have been ' +
    'compiled. Undo: one step.',
  input: z.strictObject({
    slide: SlideRefSchema,
    layoutId: z.string().min(1).max(48),
    content: z.record(z.string().min(1).max(200), SlotContentSchema).optional(),
    surface: z.string().min(1).max(48).optional(),
  }),
  output: z.object({
    slide: z.string(),
    added: z.number(),
    updated: z.number(),
    removed: z.number(),
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
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const { pack, tokens } = packAndTokens(ctx)
    const slide = resolveSlide(deck, input.slide)
    const objects = objectsOf(deck, slide)
    const slides = listSlides(deck)
    const plan = planLayout({
      pack,
      layoutId: input.layoutId,
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
      added: plan.add.length,
      updated: plan.update.length,
      removed: plan.remove.length,
    }
  },
})

export const styleDeckApply = defineCommand({
  ...layoutCommand,
  id: 'style.deck.apply',
  domain: 'style',
  title: "Re-style a deck with its folder's pack",
  description:
    "Re-lay every slide of the deck that follows a pack layout with its folder's style pack, keeping each " +
    "slot's content, and redraw the pack's footer, page numbers and decoration. `variant` sets the deck's " +
    'variant, one value per pack axis (style.pack.get "summary" lists them) — its colours follow; `fields` ' +
    "fills the footer's fields (null clears one); `lang` picks the footer language; `guides` (default true) " +
    "adds the pack's grid as guides. A slide whose layout this pack does not have is left as it is and " +
    'listed. Undo: one step.',
  input: z.strictObject({
    variant: z.record(z.string().min(1).max(48), z.string().min(1).max(48)).optional(),
    fields: z.record(z.string().min(1).max(48), z.string().max(400).nullable()).optional(),
    lang: z
      .string()
      .regex(/^[a-z]{2}$/)
      .nullable()
      .optional(),
    guides: z.boolean().optional(),
  }),
  output: z.object({
    slides: z.number().describe('Slides re-laid'),
    unmatched: z.array(z.string()).describe('Slides whose layout the pack does not have'),
    guidesAdded: z.number(),
  }),
  implementedWith: [
    'setDeckMeta',
    'addGuide',
    'addObject',
    'updateObject',
    'removeObject',
    'moveObjectToIndex',
    'updateSlideBackground',
    'setSlideLayout',
  ],
  examples: [
    { title: 'Switch the deck to the dark variant', input: { variant: { background: 'dark' } } },
    { title: "Fill the footer's client field", input: { fields: { client: 'Example AG' } } },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const { pack, tokens } = packAndTokens(ctx)
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
    const slides = listSlides(deck)
    slides.forEach((s, index) => {
      const ref = s.layout
      if (ref === undefined) return
      if (!pack.layouts.some((l) => l.id === ref.layoutId)) {
        unmatched.push(s.id)
        return
      }
      const slide = resolveSlide(deck, { id: s.id })
      const plan = planLayout({
        pack,
        layoutId: ref.layoutId,
        tokens,
        meta: nextMeta,
        objects: objectsOf(deck, slide).objects.toArray(),
        current: ref,
        ...(ref.surface !== undefined ? { surface: ref.surface } : {}),
        slideNumber: index + 1,
      })
      executePlan(deck, s.id, plan)
      relaid++
    })

    // The pack's grid as guides: margins, column edges, band tops — the
    // ones the deck does not have yet (guides people placed stay).
    let guidesAdded = 0
    if (input.guides !== false) {
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
      for (const p of vertical)
        if (!has('vertical', p)) {
          addGuide(guides, 'vertical', p)
          guidesAdded++
        }
      for (const p of horizontal)
        if (!has('horizontal', p)) {
          addGuide(guides, 'horizontal', p)
          guidesAdded++
        }
    }
    return { slides: relaid, unmatched, guidesAdded }
  },
})

export const layoutCommands = [slideApplyLayout, styleDeckApply]
