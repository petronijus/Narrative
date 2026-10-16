/**
 * commands/src/commands/check.ts — `query.check`, the brand checker (agentic
 * A4.5): a deck against its folder's style pack. The render worker measures
 * the text with the real fonts first (`load`); the rules are
 * stylePack/check.ts.
 */

import { z } from 'zod'
import { QA_RULE_IDS } from '@narrative/shared'
import { listSlides, readDeckMeta } from '@narrative/slide-model'
import { defineCommand } from '../registry.js'
import { requireServices } from '../services.js'
import { requireDeck, SlideRefSchema, type SlideRef } from '../refs.js'
import { CommandError } from '../errors.js'
import {
  MAX_MEASURE_SLIDES,
  type RenderSlideRef,
  type TextMeasurement,
} from '../services/render.js'
import { checkDeck, type CheckFinding } from '../stylePack/check.js'
import { storedStylePack } from '../stylePack/parse.js'
import { serverCommand, targetDeckId } from './serverShared.js'

/** Findings one answer lists; the counts cover all of them. */
export const MAX_CHECK_FINDINGS = 200

function toRenderRef(ref: SlideRef): RenderSlideRef {
  if (typeof ref === 'string') return { id: ref }
  return 'index' in ref ? { index: ref.index } : { id: ref.id }
}

export const queryCheck = defineCommand({
  ...serverCommand,
  id: 'query.check',
  domain: 'query',
  title: 'Check the deck against its brand',
  description:
    "Check slides against the deck's folder style pack, as the brand's QA does: text that does not fit (measured " +
    'with the real fonts; a growing box against what is below it), partial overlaps, content outside the ' +
    'margins, text colours outside the pack, a background of another variant, missing footer or page number, ' +
    'placeholder text, empty picture regions, and the editorial rules (capitals, italics, bullet glyphs, title ' +
    'periods and length, the accent budget, typography, emoji); on the whole deck, one layout on most slides. ' +
    'Each finding names its slide, object (and table ' +
    'cell), the rule and an error or warning level; fix the errors before you report a slide done. `fit: false` ' +
    `skips the measurement (a few seconds per 20 slides; at most ${MAX_MEASURE_SLIDES} slides measured at once). ` +
    'A font that did not load leaves the fit unverified ' +
    '(`fitVerified: false`, an error). Any reader of the deck.',
  input: z.strictObject({
    slides: z
      .union([z.literal('all'), z.array(SlideRefSchema).min(1).max(MAX_MEASURE_SLIDES)])
      .default('all')
      .describe('"all" (default) or the slides to check'),
    fit: z.boolean().default(true).describe('Measure the text (default true)'),
  }),
  output: z.object({
    pack: z.string().describe("The pack's id"),
    slides: z.number().describe('Slides checked'),
    fitVerified: z.boolean(),
    errors: z.number(),
    warnings: z.number(),
    findings: z.array(
      z.object({
        level: z.enum(['error', 'warn']),
        rule: z.enum(QA_RULE_IDS),
        slideId: z.string().optional(),
        index: z.number().optional(),
        objectId: z.string().optional(),
        cell: z.object({ row: z.number(), col: z.number() }).optional(),
        message: z.string(),
      }),
    ),
    findingsTruncated: z.boolean().optional(),
  }),
  role: 'viewer',
  scope: 'deck',
  // Nothing changes: the deck is read, and measured on the render page.
  effects: [],
  readOnly: true,
  undo: 'n/a',
  confirm: 'never',
  readsStylePack: true,
  readsFolderTokens: true,
  examples: [
    { title: 'Check the whole deck', input: {} },
    {
      title: 'Check two slides without measuring the text',
      input: { slides: ['s1', 's2'], fit: false },
    },
  ],
  async load(ctx, input): Promise<TextMeasurement | null> {
    if (!input.fit) return null
    return requireServices(ctx).render.measure({
      userId: ctx.actor.userId,
      deckId: targetDeckId(ctx),
      slides: input.slides === 'all' ? 'all' : input.slides.map(toRenderRef),
    })
  },
  handler(ctx, input, measurement) {
    // A deck's check: a master is checked where it is stamped.
    targetDeckId(ctx)
    const deck = requireDeck(ctx)
    if (ctx.stylePack === undefined)
      throw new CommandError('conflict', "the folder's style pack cannot be read here")
    if (ctx.stylePack === null)
      throw new CommandError(
        'not_found',
        "the deck's folder has no style pack to check against (style.pack.get reads it)",
      )
    const pack = storedStylePack(ctx.stylePack)
    const all = listSlides(deck)
    const picked =
      input.slides === 'all'
        ? all.map((slide, index) => ({ slide, index }))
        : input.slides.map((ref) => {
            const r = toRenderRef(ref)
            const index = 'index' in r ? r.index : all.findIndex((s) => s.id === r.id)
            const slide = index >= 0 ? all[index] : undefined
            if (slide === undefined)
              throw new CommandError(
                'not_found',
                'index' in r
                  ? `slide index ${r.index} is out of range (the deck has ${all.length} slides)`
                  : `slide ${r.id} not found`,
              )
            return { slide, index }
          })
    // The cap is the measurement's; unmeasured, a whole deck of any size is one check.
    if (input.fit && picked.length > MAX_MEASURE_SLIDES)
      throw new CommandError(
        'invalid_input',
        `the deck has ${picked.length} slides; one measured check takes at most ${MAX_MEASURE_SLIDES} — ` +
          'name them in parts, or check the whole deck with fit: false',
      )
    const report = checkDeck({
      pack,
      tokens: ctx.folderTokens ?? null,
      meta: readDeckMeta(deck.doc),
      slides: picked,
      measurement,
      ...(input.slides === 'all' ? { deck: all } : {}),
    })
    // Errors first, then by slide.
    const order = (f: CheckFinding) => (f.level === 'error' ? 0 : 1)
    const findings = [...report.findings].sort(
      (a, b) => order(a) - order(b) || (a.index ?? -1) - (b.index ?? -1),
    )
    return {
      pack: pack.id,
      slides: picked.length,
      fitVerified: report.fitVerified,
      errors: report.errors,
      warnings: report.warnings,
      findings: findings.slice(0, MAX_CHECK_FINDINGS),
      ...(findings.length > MAX_CHECK_FINDINGS ? { findingsTruncated: true } : {}),
    }
  },
})

export const checkCommands = [queryCheck]
