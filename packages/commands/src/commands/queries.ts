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
  yMapToAnimationStep,
} from '@narrative/slide-model'
import type { Slide } from '@narrative/shared'
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
  })
  .describe('An animation step, in play order')

/**
 * A slide's likely title: the text of its largest text box (ties go to the
 * topmost), first paragraph, trimmed. Undefined when the slide has no text.
 */
function titleGuess(slide: Slide): string | undefined {
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

export const queryDeck = defineCommand({
  ...query,
  id: 'query.deck',
  title: 'Deck outline',
  description:
    "A compact outline of the whole deck, built to fit a model's context: every slide with its id, 0-based " +
    'index, name, a title guessed from its largest text, outline indent, skipped flag, transition kind and object ' +
    "/ animation counts, plus the deck's alignment guides. Start here, then read one slide with query.slide. " +
    'Slides are 1920 x 1080 px.',
  input: z.strictObject({}),
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
      }),
    ),
    guides: z.array(GuideOutput),
  }),
  implementedWith: ['listSlides', 'listDeckGuides'],
  examples: [{ title: 'Outline the deck', input: {} }],
  handler(ctx) {
    const deck = requireDeck(ctx)
    const slides = listSlides(deck)
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
        }
      }),
      guides: listDeckGuides(getDeckGuidesCtx(deck.doc)),
    }
  },
})

export const querySlide = defineCommand({
  ...query,
  id: 'query.slide',
  title: 'Read slide',
  description:
    'Everything on one slide: every object with all its properties in stacking order (first = backmost), the ' +
    'animation steps in play order, the transition, the background (null = default white) and the speaker notes ' +
    'as plain text. Text bodies come as plain `text` (blank line between paragraphs) plus `paragraphs` with runs ' +
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
    const animations: unknown[] = []
    for (let i = 0; i < anims.animations.length; i++) {
      animations.push(toJsonForModel(yMapToAnimationStep(anims.animations.get(i))))
    }
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
    const anims = animationsOf(deck, ref)
    const animations: unknown[] = []
    for (let i = 0; i < anims.animations.length; i++) {
      const step = anims.animations.get(i)
      if (step.get('objectId') === input.object)
        animations.push(toJsonForModel(yMapToAnimationStep(step)))
    }
    return {
      slide: { id: ref.id, index: ref.index },
      stackIndex,
      object: objectForModel(map) as z.input<typeof ObjectOutputSchema>,
      animations: animations as Array<z.input<typeof StepOutput>>,
    }
  },
})

export const queryCommands = [queryDeck, querySlide, queryObject]
