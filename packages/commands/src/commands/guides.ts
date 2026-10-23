/**
 * commands/src/commands/guides.ts — the `guide.*` domain: the deck's
 * alignment guides (shared by every slide, like Keynote / Figma rulers).
 */

import { z } from 'zod'
import {
  addGuide,
  getDeckGuidesCtx,
  listDeckGuides,
  removeGuide,
  updateGuide,
  type DeckGuidesContext,
} from '@narrative/slide-model'
import type { DeckGuide } from '@narrative/shared'
import { defineCommand } from '../registry.js'
import { CommandError } from '../errors.js'
import { requireDeck } from '../refs.js'

const guideEditor = {
  domain: 'guide',
  role: 'editor',
  effects: ['doc'],
  undo: 'undoable',
  confirm: 'never',
  hosts: ['browser', 'server'],
  acceptsComponent: true,
} as const

export const SLIDE_WIDTH = 1920
export const SLIDE_HEIGHT = 1080

const GuideIdSchema = z.string().min(1).max(64).describe('Guide id (query.deck lists them)')
const Orientation = z.enum(['horizontal', 'vertical'])

function limitOf(orientation: DeckGuide['orientation']): number {
  return orientation === 'vertical' ? SLIDE_WIDTH : SLIDE_HEIGHT
}

function requireGuide(guides: DeckGuidesContext, id: string): DeckGuide {
  const guide = listDeckGuides(guides).find((g) => g.id === id)
  if (guide === undefined) throw new CommandError('not_found', `guide '${id}' does not exist`)
  return guide
}

function checkPosition(
  orientation: DeckGuide['orientation'],
  position: number,
  at: PropertyKey[],
): void {
  const limit = limitOf(orientation)
  if (position < 0 || position > limit) {
    const message = `a ${orientation} guide sits at 0..${limit} px (got ${position})`
    throw new CommandError('invalid_input', message, { issues: [{ path: at, message }] })
  }
}

const PLACEMENT =
  'Vertical: an x position (0..1920 px), horizontal: a y (0..1080 px). Guides are deck-wide, only help ' +
  'alignment in the editor and never render in the presentation.'

export const guideAdd = defineCommand({
  ...guideEditor,
  id: 'guide.add',
  title: 'Add guide',
  description: `Add an alignment guide to the deck. ${PLACEMENT}`,
  input: z.strictObject({ orientation: Orientation, position: z.number() }).superRefine((v, c) => {
    const limit = limitOf(v.orientation)
    if (v.position < 0 || v.position > limit) {
      c.addIssue({
        code: 'custom',
        message: `a ${v.orientation} guide sits at 0..${limit} px`,
        path: ['position'],
      })
    }
  }),
  output: z.object({ guideId: z.string() }),
  implementedWith: ['addGuide'],
  examples: [
    { title: 'Mark a 160 px left margin', input: { orientation: 'vertical', position: 160 } },
    {
      title: 'Mark the horizontal centre line',
      input: { orientation: 'horizontal', position: 540 },
    },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    return { guideId: addGuide(getDeckGuidesCtx(deck.doc), input.orientation, input.position) }
  },
})

export const guideUpdate = defineCommand({
  ...guideEditor,
  id: 'guide.update',
  idempotent: true,
  title: 'Move guide',
  description: `Move a guide (its orientation cannot change: remove it and add another). ${PLACEMENT}`,
  input: z.strictObject({ guide: GuideIdSchema, position: z.number() }),
  output: z.object({}),
  implementedWith: ['updateGuide', 'listDeckGuides'],
  examples: [
    { title: 'Move the centre guide to the right margin', input: { guide: 'gd1', position: 1760 } },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const guides = getDeckGuidesCtx(deck.doc)
    const guide = requireGuide(guides, input.guide)
    checkPosition(guide.orientation, input.position, ['position'])
    updateGuide(guides, input.guide, { position: input.position })
    return {}
  },
})

export const guideRemove = defineCommand({
  ...guideEditor,
  id: 'guide.remove',
  title: 'Remove guides',
  description:
    'Remove alignment guides from the deck (all slides share them). Objects do not move.',
  input: z.strictObject({ guides: z.array(GuideIdSchema).min(1).max(200) }),
  output: z.object({ removed: z.array(z.string()) }),
  implementedWith: ['removeGuide'],
  examples: [{ title: 'Remove the centre guide', input: { guides: ['gd1'] } }],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const guides = getDeckGuidesCtx(deck.doc)
    const ids = [...new Set(input.guides)]
    for (const id of ids) requireGuide(guides, id)
    for (const id of ids) removeGuide(guides, id)
    return { removed: ids }
  },
})

export const guideCommands = [guideAdd, guideUpdate, guideRemove]
