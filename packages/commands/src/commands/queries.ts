/**
 * commands/src/commands/queries.ts — read-only commands that give a model
 * what it needs to act: a compact deck outline, one slide in full, one
 * object in full. Output is JSON only (no live Yjs types) in the same forms
 * the write commands accept — "#rrggbb" colours, text with "\n\n" between
 * paragraphs plus a paragraph/run structure when formatted — so a model can
 * read a value and send it straight back.
 */

import { z } from 'zod'
import * as Y from 'yjs'
import {
  getDeckGuidesCtx,
  getPlainString,
  getSlideNotesText,
  listDeckGuides,
  listSlides,
  readDeckMeta,
  readDeckSpec,
  yMapToAnimationStep,
  type AnimationsMutationContext,
} from '@narrative/slide-model'
import { DeckSpecSchema, MAX_SPEC_BYTES } from '../stylePack/deckSpec.js'
import {
  ArchetypeSchema,
  layoutAnimationSteps,
  type AnimationStep,
  type Slide,
} from '@narrative/shared'
import { defineCommand } from '../registry.js'
import {
  ObjectIdSchema,
  SlideRefSchema,
  animationsOf,
  objectsOf,
  requireDeck,
  requireObjects,
  resolveSlide,
} from '../refs.js'
import { ObjectOutputSchema, objectForModel, toJsonForModel } from '../read/plain.js'
import { displayOf } from '../text/body.js'

const query = {
  domain: 'query',
  role: 'viewer',
  effects: [],
  readOnly: true,
  undo: 'n/a',
  confirm: 'never',
  hosts: ['browser', 'server'],
  acceptsComponent: true,
} as const

const TITLE_MAX = 80

const TransitionOutput = z.object({
  kind: z.string(),
  durationMs: z.number(),
  direction: z.string().optional(),
})

const GuideOutput = z.object({
  id: z.string(),
  orientation: z.enum(['horizontal', 'vertical']),
  position: z.number(),
})

const StepOutput = z
  .looseObject({
    id: z.string(),
    objectId: z.string(),
    preset: z.string(),
    trigger: z.string(),
    duration: z.number(),
    delay: z.number(),
    easing: z.string(),
    params: z.record(z.string(), z.unknown()).optional(),
    start: z
      .number()
      .describe(
        "Seconds from the slide start at which the step begins, as the editor's timeline shows it",
      ),
  })
  .describe('An animation step, in play order')

/** A slide's animation steps as the model reads them, each with its timeline `start`. */
function timedStepsForModel(anims: AnimationsMutationContext): Array<Record<string, unknown>> {
  const steps: AnimationStep[] = []
  for (let i = 0; i < anims.animations.length; i++)
    steps.push(yMapToAnimationStep(anims.animations.get(i)))
  return layoutAnimationSteps(steps).map(({ step, start }) => ({
    ...(toJsonForModel(step) as Record<string, unknown>),
    start: Math.round(start * 1e6) / 1e6,
  }))
}

/**
 * A slide's likely title: the text of its largest text box (ties go to the
 * topmost), first paragraph, trimmed. Undefined when the slide has no text.
 */
export function titleGuess(slide: Slide): string | undefined {
  let best: { size: number; y: number; text: string } | undefined
  for (const o of slide.objects) {
    if (o.type !== 'text') continue
    const raw =
      o.text instanceof Y.Text ? getPlainString(o.text) : typeof o.text === 'string' ? o.text : ''
    const first = displayOf(raw)
      .display.split('\n\n')
      .map((p) => p.replace(/\s+/g, ' ').trim())
      .find((p) => p.length > 0)
    if (first === undefined) continue
    const size = typeof o.fontSize === 'number' ? o.fontSize : 0
    if (best === undefined || size > best.size || (size === best.size && o.y < best.y)) {
      best = { size, y: o.y, text: first }
    }
  }
  if (best === undefined) return undefined
  return best.text.length > TITLE_MAX ? `${best.text.slice(0, TITLE_MAX - 1)}…` : best.text
}

/** The pack layout a slide follows (A4.4). */
const SlideLayoutOutput = z.object({
  packId: z.string(),
  layoutId: z.string(),
  surface: z.string().optional(),
  archetype: ArchetypeSchema.optional().describe('What the slide does in the deck (cover, content…)'),
})

/** The deck's meta (A4.2d): its pack variant, footer field values and language. */
const DeckMetaOutput = z.object({
  variant: z.record(z.string(), z.string()).optional(),
  fields: z.record(z.string(), z.string()).optional(),
  lang: z.string().optional(),
})

export const queryDeck = defineCommand({
  ...query,
  id: 'query.deck',
  title: 'Deck outline',
  description:
    "A compact outline of the whole deck, built to fit a model's context: every slide with its id, 0-based " +
    'index, name, a title guessed from its largest text, outline indent, skipped flag, transition kind and object ' +
    "/ animation counts and its style pack layout, plus the deck's alignment guides and its meta (pack variant, " +
    'footer fields, language; set with style.deck.apply). A deck built from a spec says how many slides it has ' +
    '(`specSlides`); `spec: true` returns the spec itself, to build again. Start here, then read one slide with ' +
    'query.slide. ' +
    'Slides are 1920 x 1080 px.',
  input: z.strictObject({
    spec: z.boolean().optional().describe('Also return the deck spec it was built from'),
  }),
  output: z.object({
    slideCount: z.number(),
    slides: z.array(
      z.object({
        id: z.string(),
        index: z.number(),
        name: z.string().optional(),
        title: z.string().optional(),
        indent: z.number().optional(),
        skipped: z.boolean().optional(),
        collapsed: z.boolean().optional(),
        transition: z.string(),
        objectCount: z.number(),
        animationCount: z.number(),
        layout: SlideLayoutOutput.optional(),
      }),
    ),
    guides: z.array(GuideOutput),
    meta: DeckMetaOutput,
    specSlides: z.number().optional().describe('Slides of the spec the deck was built from'),
    spec: z.record(z.string(), z.unknown()).optional().describe('The spec, with spec: true'),
    specInvalid: z
      .boolean()
      .optional()
      .describe('The deck holds a spec that is not a valid one: build it again'),
  }),
  implementedWith: ['listSlides', 'listDeckGuides', 'readDeckMeta', 'readDeckSpec'],
  examples: [
    { title: 'Outline the deck', input: {} },
    { title: 'Outline the deck with the spec it was built from', input: { spec: true } },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const slides = listSlides(deck)
    // The stored spec as a spec, or not at all: any client may write the
    // document, and what is returned here goes into a model's context.
    const stored = readDeckSpec(deck.doc)
    const parsed = stored === null ? null : DeckSpecSchema.safeParse(stored)
    const spec =
      parsed?.success === true &&
      new TextEncoder().encode(JSON.stringify(parsed.data)).length <= MAX_SPEC_BYTES
        ? parsed.data
        : null
    const specSlides = spec?.slides.length
    return {
      slideCount: slides.length,
      slides: slides.map((s, index) => {
        const title = titleGuess(s)
        return {
          id: s.id,
          index,
          ...(s.name !== undefined ? { name: s.name } : {}),
          ...(title !== undefined ? { title } : {}),
          ...(s.indent !== undefined ? { indent: s.indent } : {}),
          ...(s.skipped === true ? { skipped: true } : {}),
          ...(s.collapsed === true ? { collapsed: true } : {}),
          transition: s.transition.kind,
          objectCount: s.objects.length,
          animationCount: s.animations.length,
          ...(s.layout !== undefined ? { layout: s.layout } : {}),
        }
      }),
      guides: listDeckGuides(getDeckGuidesCtx(deck.doc)),
      meta: readDeckMeta(deck.doc),
      ...(specSlides !== undefined ? { specSlides } : {}),
      ...(stored !== null && spec === null ? { specInvalid: true } : {}),
      ...(input.spec === true && spec !== null ? { spec } : {}),
    }
  },
})

export const querySlide = defineCommand({
  ...query,
  id: 'query.slide',
  title: 'Read slide',
  description:
    'Everything on one slide: every object with all its properties in stacking order (first = backmost), the ' +
    'animation steps in play order, the transition, the background (null = default white), the style pack layout ' +
    'it follows (slide.applyLayout), its brief (the message and claims of the spec that built it) and the speaker notes ' +
    'as plain text (slide.notes.get has them as Markdown with their formatting). Text bodies come as plain `text` (blank line between paragraphs) plus `paragraphs` with runs ' +
    'and list attributes when formatted; colours as "#rrggbb" or { $token }. For one object use query.object. ' +
    'It also reads a component master: target the component (componentId) and read slide { index: 0 } — edit ' +
    'the master with the same object and text commands.',
  input: z.strictObject({ slide: SlideRefSchema }),
  output: z.object({
    id: z.string(),
    index: z.number(),
    name: z.string().optional(),
    skipped: z.boolean().optional(),
    indent: z.number().optional(),
    collapsed: z.boolean().optional(),
    transition: TransitionOutput,
    background: z.record(z.string(), z.unknown()).nullable(),
    objects: z.array(ObjectOutputSchema),
    animations: z.array(StepOutput),
    layout: SlideLayoutOutput.optional(),
    brief: z
      .object({
        message: z.string().optional(),
        claims: z
          .array(
            z.object({
              kind: z.enum(['sourced', 'source-needed', 'illustrative']),
              text: z.string(),
              source: z.string().optional(),
            }),
          )
          .optional(),
      })
      .optional(),
    notes: z.string(),
  }),
  implementedWith: ['listSlides', 'yMapToPlainObject', 'getParagraphDeltas', 'getSlideNotesText'],
  examples: [
    { title: 'Read the first slide', input: { slide: { index: 0 } } },
    { title: 'Read a slide by id', input: { slide: 's2' } },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const ref = resolveSlide(deck, input.slide)
    const slide = listSlides(deck)[ref.index]!
    const objects = objectsOf(deck, ref)
    const anims = animationsOf(deck, ref)
    const objectList: Array<Record<string, unknown>> = []
    for (let i = 0; i < objects.objects.length; i++) {
      try {
        objectList.push(objectForModel(objects.objects.get(i)))
      } catch {
        // A malformed record (no type) is skipped, as listSlides does.
      }
    }
    const animations = timedStepsForModel(anims)
    return {
      id: slide.id,
      index: ref.index,
      ...(slide.name !== undefined ? { name: slide.name } : {}),
      ...(slide.skipped === true ? { skipped: true } : {}),
      ...(slide.indent !== undefined ? { indent: slide.indent } : {}),
      ...(slide.collapsed === true ? { collapsed: true } : {}),
      transition: slide.transition,
      background:
        slide.background === undefined
          ? null
          : (toJsonForModel(slide.background) as Record<string, unknown>),
      objects: objectList as Array<z.input<typeof ObjectOutputSchema>>,
      animations: animations as Array<z.input<typeof StepOutput>>,
      ...(slide.layout !== undefined ? { layout: slide.layout } : {}),
      ...(slide.brief !== undefined ? { brief: slide.brief } : {}),
      notes: getSlideNotesText(deck, slide.id) ?? '',
    }
  },
})

export const queryObject = defineCommand({
  ...query,
  id: 'query.object',
  title: 'Read object',
  description:
    'One object with all its properties (same shape as in query.slide) plus the animation steps that target it ' +
    'and its stacking position (0 = backmost). Use it before text.format / text.list to see the exact text ' +
    'offsets, or before object.update to see current values.',
  input: z.strictObject({ slide: SlideRefSchema, object: ObjectIdSchema }),
  output: z.object({
    slide: z.object({ id: z.string(), index: z.number() }),
    stackIndex: z.number(),
    object: ObjectOutputSchema,
    animations: z.array(StepOutput),
  }),
  implementedWith: ['yMapToPlainObject', 'getParagraphDeltas'],
  examples: [
    { title: 'Read the formatted text box', input: { slide: 's1', object: 't1' } },
    { title: 'Read the table', input: { slide: 's1', object: 'tbl1' } },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const ref = resolveSlide(deck, input.slide)
    const objects = objectsOf(deck, ref)
    const map = requireObjects(objects, [input.object], ref.id).get(input.object)!
    let stackIndex = 0
    for (let i = 0; i < objects.objects.length; i++) {
      if (objects.objects.get(i) === map) stackIndex = i
    }
    const animations = timedStepsForModel(animationsOf(deck, ref)).filter(
      (s) => s['objectId'] === input.object,
    )
    return {
      slide: { id: ref.id, index: ref.index },
      stackIndex,
      object: objectForModel(map) as z.input<typeof ObjectOutputSchema>,
      animations: animations as Array<z.input<typeof StepOutput>>,
    }
  },
})

export const queryCommands = [queryDeck, querySlide, queryObject]
