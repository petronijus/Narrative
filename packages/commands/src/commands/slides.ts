/**
 * commands/src/commands/slides.ts — the `slide.*` domain: structure,
 * outline metadata, transition and background. Speaker-notes writing
 * arrives with the notes API (A2).
 */

import { z } from 'zod'
import * as Y from 'yjs'
import {
  SlideBackgroundInputSchema,
  SlidePushDirectionSchema,
  SlideTransitionSchema,
  type SlideBackground,
  type SlideTransition,
} from '@narrative/shared'
import {
  addSlide,
  clearSlideTransitionDirection,
  duplicateSlide,
  moveSlide,
  moveSlidesBlock,
  removeSlide,
  getSlideNotesDoc,
  setSlideCollapsed,
  setSlideIndent,
  setSlideNotes,
  setSlideName,
  setSlideSkipped,
  updateSlideBackground,
  updateSlideTransition,
  type DeckMutationContext,
} from '@narrative/slide-model'
import type * as notesMarkdownModule from '../notes/markdown.js'
import { defineCommand } from '../registry.js'
import { CommandError } from '../errors.js'
import { SlideRefSchema, requireDeck, resolveSlide, type ResolvedSlide } from '../refs.js'
import {
  MAX_SLIDE_INDENT,
  levelOf,
  maxLevelBelow,
  normalizeOutline,
  shiftBlockLevels,
} from '../outline.js'

export { MAX_SLIDE_INDENT }

/** The slides a list of refs names, each once, in deck order. */
function resolveUniqueInDeckOrder(
  deck: DeckMutationContext,
  refs: ReadonlyArray<z.infer<typeof SlideRefSchema>>,
): ResolvedSlide[] {
  const resolved = refs.map((ref) => resolveSlide(deck, ref))
  return [...new Map(resolved.map((s) => [s.id, s])).values()].sort((a, b) => a.index - b.index)
}

function slideOrder(deck: DeckMutationContext): string[] {
  const order: string[] = []
  for (let i = 0; i < deck.slides.length; i++) order.push(deck.slides.get(i).get('id') as string)
  return order
}

function indexOfSlide(deck: DeckMutationContext, id: string): number {
  for (let i = 0; i < deck.slides.length; i++) if (deck.slides.get(i).get('id') === id) return i
  return -1
}

/** Give the slides `ids` (consecutive, in this order) the levels of `levels`. */
function applyLevels(
  deck: DeckMutationContext,
  ids: readonly string[],
  levels: readonly number[],
): void {
  ids.forEach((id, i) => {
    const index = indexOfSlide(deck, id)
    const level = levels[i]
    if (index === -1 || level === undefined) return
    if (levelOf(deck.slides.get(index)) !== level) setSlideIndent(deck, id, level)
  })
}

const SlideIdOutput = z.object({ slideId: z.string() })
const EmptyOutput = z.object({})

const slideEditor = {
  domain: 'slide',
  role: 'editor',
  effects: ['doc'],
  undo: 'undoable',
  confirm: 'never',
  hosts: ['browser', 'server'],
  acceptsComponent: true,
} as const

export const slideAdd = defineCommand({
  ...slideEditor,
  id: 'slide.add',
  title: 'Add slide',
  description:
    'Insert a new empty slide (white background, no objects, no transition). ' +
    'Omit `index` to append at the end; `index` is the 0-based position the new slide will occupy. ' +
    'To copy an existing slide with its content use slide.duplicate instead.',
  input: z.object({ index: z.number().int().min(0).optional() }).strict(),
  output: SlideIdOutput,
  implementedWith: ['addSlide'],
  examples: [
    { title: 'Append a slide at the end', input: {} },
    { title: 'Insert a slide as the second slide', input: { index: 1 } },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    return { slideId: addSlide(deck, input.index).id }
  },
})

export const slideDuplicate = defineCommand({
  ...slideEditor,
  id: 'slide.duplicate',
  title: 'Duplicate slide',
  description:
    'Copy a slide whole — objects with their rich text, tables, animations, transition, background, ' +
    'speaker notes, name and outline state — and insert the copy right after the source (or at `index`). ' +
    'Object ids are kept on purpose so Magic Move pairs objects across the two slides; ' +
    'use it before moving things on the copy to author a Magic Move.',
  input: z.object({ slide: SlideRefSchema, index: z.number().int().min(0).optional() }).strict(),
  output: SlideIdOutput,
  implementedWith: ['duplicateSlide'],
  examples: [
    { title: 'Duplicate the first slide', input: { slide: { index: 0 } } },
    { title: 'Duplicate slide s2 and put the copy at the end', input: { slide: 's2', index: 3 } },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const source = resolveSlide(deck, input.slide)
    const copy = duplicateSlide(deck, source.id, input.index)
    if (copy === null)
      throw new CommandError('failed', `slide '${source.id}' could not be duplicated`)
    return { slideId: copy.id }
  },
})

export const slideDelete = defineCommand({
  ...slideEditor,
  id: 'slide.delete',
  title: 'Delete slides',
  description:
    'Delete one or more slides with everything on them. A deck always keeps at least one slide: ' +
    'deleting the last remaining slide replaces it with an empty one. Outline children of a deleted slide ' +
    'stay and move up a level where they would otherwise be two levels below the slide above them. ' +
    '`landOn` is the slide an editor shows next: the nearest remaining slide above the first deleted one, ' +
    'else the first remaining slide. To hide a slide from the presentation without deleting it use slide.skip.',
  input: z.object({ slides: z.array(SlideRefSchema).min(1).max(500) }).strict(),
  output: z.object({ deleted: z.array(z.string()), landOn: z.string() }),
  implementedWith: ['removeSlide', 'setSlideIndent'],
  examples: [{ title: 'Delete the third slide', input: { slides: [{ index: 2 }] } }],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const doomed = resolveUniqueInDeckOrder(deck, input.slides)
    const ids = doomed.map((s) => s.id)
    const gone = new Set(ids)
    const before = slideOrder(deck)
    const firstIndex = doomed[0]!.index
    let landOn = before
      .slice(0, firstIndex)
      .reverse()
      .find((id) => !gone.has(id))
    landOn ??= before.find((id) => !gone.has(id))
    for (const id of ids) removeSlide(deck, id)
    normalizeOutline(deck)
    // Everything deleted: the deck now holds the one empty slide removeSlide left.
    return { deleted: ids, landOn: landOn ?? (deck.slides.get(0).get('id') as string) }
  },
})

export const slideMove = defineCommand({
  ...slideEditor,
  id: 'slide.move',
  title: 'Move slides',
  description:
    'Move one or more slides, as a block keeping their current relative order, so the block starts at ' +
    '`toIndex` (0-based, counted in the deck BEFORE the move; clamped to the deck length). ' +
    'Outline children are NOT moved implicitly — list them too if they should follow their parent. ' +
    '`level` sets the outline level of the first moved slide; the others shift by the same amount, so the ' +
    "block's own structure stays. Afterwards no slide is more than one level deeper than the slide above it " +
    '(deeper ones are raised), the rule the slides panel drags by.',
  input: z
    .object({
      slides: z.array(SlideRefSchema).min(1).max(500),
      toIndex: z.number().int().min(0),
      level: z
        .number()
        .int()
        .min(0)
        .max(MAX_SLIDE_INDENT)
        .optional()
        .describe('Outline level for the first moved slide (0 = top; omitted = levels kept)'),
    })
    .strict(),
  output: z.object({ order: z.array(z.string()) }),
  implementedWith: ['moveSlide', 'moveSlidesBlock', 'setSlideIndent'],
  examples: [
    { title: 'Move slide s3 to the front', input: { slides: ['s3'], toIndex: 0 } },
    {
      title: 'Move the first two slides to the end',
      input: { slides: [{ index: 0 }, { index: 1 }], toIndex: 3 },
    },
    {
      title: 'Move slide s3 under slide s1 as its child',
      input: { slides: ['s3'], toIndex: 1, level: 1 },
    },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const unique = resolveUniqueInDeckOrder(deck, input.slides)
    const ids = unique.map((s) => s.id)
    const levels = unique.map((s) => levelOf(s.map))
    const [only] = unique
    const first = unique[0]!.index
    const contiguous = unique.every((s, i) => s.index === first + i)
    // A contiguous block dropped onto its own span stays where it is (only
    // its level may change); re-inserting it would clone every slide.
    const inPlace = contiguous && input.toIndex >= first && input.toIndex <= first + unique.length
    if (inPlace) {
      // nothing to move
    } else if (unique.length === 1 && only !== undefined) {
      // moveSlide takes the FINAL index; the command's `toIndex` is pre-move.
      const target = input.toIndex > only.index ? input.toIndex - 1 : input.toIndex
      moveSlide(deck, only.id, target)
    } else {
      moveSlidesBlock(deck, ids, input.toIndex)
    }
    if (input.level !== undefined) {
      const start = indexOfSlide(deck, ids[0]!)
      const above = start > 0 ? levelOf(deck.slides.get(start - 1)) : undefined
      applyLevels(deck, ids, shiftBlockLevels(levels, input.level, above))
    }
    normalizeOutline(deck)
    return { order: slideOrder(deck) }
  },
})

export const slideCopyTo = defineCommand({
  ...slideEditor,
  id: 'slide.copyTo',
  title: 'Copy slides',
  description:
    'Copy one or more slides of this deck, as a block in their deck order, so the copies start at `index` ' +
    '(0-based position in the deck as it is now; omitted = at the end). Each copy is whole — objects with ' +
    'their rich text, tables, animations, transition, background, speaker notes, name — and keeps its object ' +
    'ids (Magic Move pairs them with the originals). The copies keep their relative outline levels, shifted ' +
    'so the first fits under the slide it lands below. To copy one slide right after itself use ' +
    'slide.duplicate; to bring slides from ANOTHER deck use deck.insertFrom.',
  input: z
    .object({
      slides: z.array(SlideRefSchema).min(1).max(500),
      index: z.number().int().min(0).optional(),
    })
    .strict(),
  output: z.object({ slideIds: z.array(z.string()) }),
  implementedWith: ['duplicateSlide', 'setSlideIndent'],
  examples: [
    { title: 'Copy the first two slides to the end', input: { slides: [{ index: 0 }, 's2'] } },
    { title: 'Copy slide s3 to the front', input: { slides: ['s3'], index: 0 } },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const sources = resolveUniqueInDeckOrder(deck, input.slides)
    const levels = sources.map((s) => levelOf(s.map))
    const at = Math.min(input.index ?? deck.slides.length, deck.slides.length)
    const slideIds: string[] = []
    sources.forEach((source, i) => {
      const copy = duplicateSlide(deck, source.id, at + i)
      if (copy === null)
        throw new CommandError('failed', `slide '${source.id}' could not be copied`)
      slideIds.push(copy.id)
    })
    const above = at > 0 ? levelOf(deck.slides.get(at - 1)) : undefined
    applyLevels(deck, slideIds, shiftBlockLevels(levels, levels[0]!, above))
    normalizeOutline(deck)
    return { slideIds }
  },
})

export const slideRename = defineCommand({
  ...slideEditor,
  id: 'slide.rename',
  idempotent: true,
  title: 'Rename slide',
  description:
    'Set the name shown for a slide in the slides panel and the presenter view. ' +
    'An empty (or whitespace-only) name clears it, so the slide falls back to "Slide N".',
  input: z.object({ slide: SlideRefSchema, name: z.string().max(200) }).strict(),
  output: EmptyOutput,
  implementedWith: ['setSlideName'],
  examples: [{ title: 'Name the first slide', input: { slide: { index: 0 }, name: 'Opening' } }],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    setSlideName(deck, resolveSlide(deck, input.slide).id, input.name)
    return {}
  },
})

export const slideSkip = defineCommand({
  ...slideEditor,
  id: 'slide.skip',
  idempotent: true,
  title: 'Skip slide in presentation',
  description:
    'Mark a slide as skipped (hidden from present mode, still visible and editable in the editor) ' +
    'or un-skip it. Skipped slides do not count towards page numbers.',
  input: z.object({ slide: SlideRefSchema, skipped: z.boolean() }).strict(),
  output: EmptyOutput,
  implementedWith: ['setSlideSkipped'],
  examples: [
    { title: 'Hide slide s2 from the presentation', input: { slide: 's2', skipped: true } },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    setSlideSkipped(deck, resolveSlide(deck, input.slide).id, input.skipped)
    return {}
  },
})

export const slideIndent = defineCommand({
  ...slideEditor,
  id: 'slide.indent',
  idempotent: true,
  title: 'Set slide outline level',
  description:
    `Set a slide's outline indent level (0 = top level, max ${MAX_SLIDE_INDENT}). ` +
    'A slide can be at most one level deeper than the slide above it, and the first slide is always level 0 — ' +
    'the same rules as dragging in the slides panel. Indented slides become children of the nearest ' +
    'shallower slide above them (sections); the outline does not affect present mode. Slides below it that ' +
    'would then be two levels deeper than the slide above them are raised with it.',
  input: z
    .object({ slide: SlideRefSchema, level: z.number().int().min(0).max(MAX_SLIDE_INDENT) })
    .strict(),
  output: EmptyOutput,
  implementedWith: ['setSlideIndent'],
  examples: [
    { title: 'Make slide s2 a child of the slide above it', input: { slide: 's2', level: 1 } },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const slide = resolveSlide(deck, input.slide)
    const above = slide.index > 0 ? levelOf(deck.slides.get(slide.index - 1)) : undefined
    if (input.level > maxLevelBelow(above)) {
      throw new CommandError(
        'conflict',
        above === undefined
          ? 'the first slide is always at outline level 0'
          : `slide '${slide.id}' can be at most one level deeper than the slide above it (level ${above})`,
      )
    }
    setSlideIndent(deck, slide.id, input.level)
    normalizeOutline(deck)
    return {}
  },
})

export const slideCollapse = defineCommand({
  ...slideEditor,
  id: 'slide.collapse',
  idempotent: true,
  title: 'Collapse slide section',
  description:
    "Collapse or expand a slide's outline children in the slides panel. Purely a panel view setting " +
    'shared with collaborators; it does not hide anything from present mode (use slide.skip for that).',
  input: z.object({ slide: SlideRefSchema, collapsed: z.boolean() }).strict(),
  output: EmptyOutput,
  implementedWith: ['setSlideCollapsed'],
  examples: [
    { title: 'Collapse the section starting at slide s1', input: { slide: 's1', collapsed: true } },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    setSlideCollapsed(deck, resolveSlide(deck, input.slide).id, input.collapsed)
    return {}
  },
})

const transitionShape = SlideTransitionSchema.shape

export const slideSetTransition = defineCommand({
  ...slideEditor,
  id: 'slide.setTransition',
  idempotent: true,
  title: 'Set slide transition',
  description:
    'Set how present mode moves INTO this slide: `kind` none | fade | push | cube | magic (Magic Move animates ' +
    'objects that share ids with the previous slide — see slide.duplicate), `durationMs` in milliseconds, ' +
    '`direction` left | right | up | down for push (null removes it). Fields you omit keep their value.',
  input: z
    .strictObject({
      slide: SlideRefSchema,
      kind: transitionShape.kind.optional(),
      durationMs: transitionShape.durationMs.optional(),
      direction: SlidePushDirectionSchema.nullable().optional(),
    })
    .refine(
      (v) => v.kind !== undefined || v.durationMs !== undefined || v.direction !== undefined,
      {
        message: 'Pass at least one of kind, durationMs, direction',
      },
    ),
  output: EmptyOutput,
  implementedWith: ['updateSlideTransition', 'clearSlideTransitionDirection'],
  examples: [
    {
      title: 'Fade into the second slide over 400 ms',
      input: { slide: 's2', kind: 'fade', durationMs: 400 },
    },
    {
      title: 'Push in from the right',
      input: { slide: { index: 2 }, kind: 'push', durationMs: 500, direction: 'right' },
    },
    { title: 'Drop the push direction again', input: { slide: 's1', direction: null } },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    const slide = resolveSlide(deck, input.slide)
    if (!(slide.map.get('transition') instanceof Y.Map)) {
      throw new CommandError('conflict', `slide '${slide.id}' has no transition record to update`)
    }
    const patch: Partial<SlideTransition> = {}
    if (input.kind !== undefined) patch.kind = input.kind
    if (input.durationMs !== undefined) patch.durationMs = input.durationMs
    if (input.direction !== undefined && input.direction !== null) patch.direction = input.direction
    if (Object.keys(patch).length > 0) updateSlideTransition(deck, slide.id, patch)
    if (input.direction === null) clearSlideTransitionDirection(deck, slide.id)
    return {}
  },
})

export const slideSetBackground = defineCommand({
  ...slideEditor,
  id: 'slide.setBackground',
  idempotent: true,
  title: 'Set slide background',
  description:
    'Set a slide\'s background: { kind: "color", color, alpha? }, { kind: "linearGradient", angleDeg, stops }, ' +
    '{ kind: "radialGradient", centerX, centerY, radius, stops } (2..10 stops of { offset 0..1, color, alpha? }) ' +
    'or { kind: "image", assetId, fit: cover|contain, dim? } for an already uploaded asset. Colours "#RRGGBB" or ' +
    '0xRRGGBB. `null` resets to the default white. The whole background is replaced.',
  input: z.strictObject({
    slide: SlideRefSchema,
    background: SlideBackgroundInputSchema.nullable(),
  }),
  output: EmptyOutput,
  implementedWith: ['updateSlideBackground'],
  examples: [
    {
      title: 'Navy background',
      input: { slide: 's1', background: { kind: 'color', color: '#1b2a4a' } },
    },
    {
      title: 'Top-to-bottom gradient',
      input: {
        slide: 's2',
        background: {
          kind: 'linearGradient',
          angleDeg: 180,
          stops: [
            { offset: 0, color: '#ffffff' },
            { offset: 1, color: '#dfe7f3' },
          ],
        },
      },
    },
    { title: 'Back to the default', input: { slide: 's3', background: null } },
  ],
  handler(ctx, input) {
    const deck = requireDeck(ctx)
    updateSlideBackground(
      deck,
      resolveSlide(deck, input.slide).id,
      input.background as SlideBackground | null,
    )
    return {}
  },
})

/** The Markdown converter, loaded on first use (keeps the parser out of the editor's main bundle). */
type NotesMarkdown = typeof notesMarkdownModule
const loadNotesMarkdown = (): Promise<NotesMarkdown> => import('../notes/markdown.js')

/** Upper bound for notes sent as Markdown (a long talk is ~20 000 characters). */
export const MAX_NOTES_MARKDOWN = 100_000

export const slideNotesGet = defineCommand({
  domain: 'slide',
  role: 'viewer',
  effects: [],
  readOnly: true,
  undo: 'n/a',
  confirm: 'never',
  hosts: ['browser', 'server'],
  acceptsComponent: true,
  id: 'slide.notes.get',
  title: 'Read speaker notes',
  description:
    "A slide's speaker notes as Markdown with their formatting, in the syntax slide.notes.set takes; empty " +
    'notes read as "". query.slide gives them as plain text — read them here before editing them with ' +
    'slide.notes.set so the formatting survives.',
  input: z.strictObject({ slide: SlideRefSchema }),
  output: z.object({ markdown: z.string() }),
  implementedWith: ['getSlideNotesDoc'],
  examples: [{ title: 'Read the notes of the first slide', input: { slide: { index: 0 } } }],
  load: () => loadNotesMarkdown(),
  handler(ctx, input, markdown: NotesMarkdown) {
    const deck = requireDeck(ctx)
    const slide = resolveSlide(deck, input.slide)
    return { markdown: markdown.notesToMarkdown(getSlideNotesDoc(deck, slide.id) ?? []) }
  },
})

export const slideNotesSet = defineCommand({
  ...slideEditor,
  id: 'slide.notes.set',
  idempotent: true,
  title: 'Set speaker notes',
  description:
    "Replace a slide's speaker notes (what the presenter view shows) with Markdown: # headings, - and 1. lists " +
    '(nested by indenting), > quotes, ``` code blocks, ---, **bold**, *italic*, ~~strike~~, `code`, ' +
    '<u>underline</u>, [links](https://…). A newline inside a paragraph is a line break; a blank line starts a ' +
    'new paragraph. "" clears the notes. The whole notes are replaced — read them first with slide.notes.get ' +
    'to change only part.',
  input: z.strictObject({
    slide: SlideRefSchema,
    markdown: z.string().max(MAX_NOTES_MARKDOWN),
  }),
  output: EmptyOutput,
  implementedWith: ['setSlideNotes'],
  examples: [
    {
      title: 'Talking points for the first slide',
      input: {
        slide: { index: 0 },
        markdown:
          'Welcome everyone.\n\n- **Q3** revenue up 12 %\n- hiring plan\n\nAsk for questions.',
      },
    },
    { title: 'Clear the notes of slide s2', input: { slide: 's2', markdown: '' } },
  ],
  load: () => loadNotesMarkdown(),
  handler(ctx, input, markdown: NotesMarkdown) {
    const deck = requireDeck(ctx)
    const slide = resolveSlide(deck, input.slide)
    setSlideNotes(deck, slide.id, markdown.notesFromMarkdown(input.markdown))
    return {}
  },
})

export const slideCommands = [
  slideAdd,
  slideDuplicate,
  slideDelete,
  slideMove,
  slideCopyTo,
  slideRename,
  slideSkip,
  slideIndent,
  slideCollapse,
  slideSetTransition,
  slideSetBackground,
  slideNotesGet,
  slideNotesSet,
]
