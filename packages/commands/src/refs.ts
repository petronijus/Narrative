/**
 * commands/src/refs.ts
 *
 * How commands address things. Commands never act on "the current
 * selection" — that is editor state an agent cannot see. They take explicit
 * references; the host resolves "this" (the user's selection, via
 * `editor.context`) into these before calling. Resolution happens before any
 * write, so a bad reference fails the command without touching the document.
 */

import { z } from 'zod'
import type * as Y from 'yjs'
import {
  getSlideAnimationsCtx,
  getSlideObjectsCtx,
  type AnimationsMutationContext,
  type DeckMutationContext,
  type ObjectsMutationContext,
} from '@narrative/slide-model'
import { CommandError, notFound } from './errors.js'
import type { CommandContext } from './types.js'

const Id = z.string().min(1).max(64)

/**
 * A slide, by id (a bare string is shorthand for `{ id }`) or by 0-based
 * position in the deck (`{ index }`, hidden/skipped slides included).
 */
export const SlideRefSchema = z
  .union([Id, z.object({ id: Id }).strict(), z.object({ index: z.number().int().min(0) }).strict()])
  .describe('Slide id, or { id }, or { index } (0-based position in the deck)')

export type SlideRef = z.infer<typeof SlideRefSchema>

export const ObjectIdSchema = Id.describe('Object id (unique within its slide)')
export const ObjectIdsSchema = z.array(ObjectIdSchema).min(1).max(500)

export function requireDeck(ctx: CommandContext): DeckMutationContext {
  if (ctx.deck === undefined) throw new CommandError('no_target', 'no target deck document')
  return ctx.deck
}

export interface ResolvedSlide {
  id: string
  index: number
  map: Y.Map<unknown>
}

export function resolveSlide(deck: DeckMutationContext, ref: SlideRef): ResolvedSlide {
  if (typeof ref === 'object' && 'index' in ref) {
    const map = ref.index < deck.slides.length ? deck.slides.get(ref.index) : undefined
    if (map === undefined) {
      throw new CommandError(
        'not_found',
        `slide index ${ref.index} is out of range (the deck has ${deck.slides.length} slides)`,
      )
    }
    return { id: map.get('id') as string, index: ref.index, map }
  }
  const id = typeof ref === 'string' ? ref : ref.id
  for (let i = 0; i < deck.slides.length; i++) {
    const map = deck.slides.get(i)
    if (map.get('id') === id) return { id, index: i, map }
  }
  throw notFound('slide', id)
}

export function objectsOf(deck: DeckMutationContext, slide: ResolvedSlide): ObjectsMutationContext {
  const ctx = getSlideObjectsCtx(deck, slide.id)
  if (ctx === null) throw new CommandError('failed', `slide '${slide.id}' has no objects array`)
  return ctx
}

export function animationsOf(
  deck: DeckMutationContext,
  slide: ResolvedSlide,
): AnimationsMutationContext {
  const ctx = getSlideAnimationsCtx(deck, slide.id)
  if (ctx === null) throw new CommandError('failed', `slide '${slide.id}' has no animations array`)
  return ctx
}

/** Index of each object id on the slide; throws `not_found` for the first missing id. */
export function requireObjects(
  objects: ObjectsMutationContext,
  ids: ReadonlyArray<string>,
  slideId: string,
): Map<string, Y.Map<unknown>> {
  const found = new Map<string, Y.Map<unknown>>()
  const wanted = new Set(ids)
  for (let i = 0; i < objects.objects.length; i++) {
    const m = objects.objects.get(i)
    const id = m.get('id') as string
    if (wanted.has(id)) found.set(id, m)
  }
  for (const id of ids) {
    if (!found.has(id))
      throw new CommandError('not_found', `object '${id}' does not exist on slide '${slideId}'`)
  }
  return found
}
