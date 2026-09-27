/**
 * tests/agent-eval/scenarios/helpers.ts — fixture building blocks shared by
 * the scenarios. Everything goes through `World`, so a fixture builds the
 * same way on the live stack and in the memory world.
 */

import type { World } from '../lib/types.js'

export interface ObjectSpec {
  /** Fixture key the object's id is returned under. */
  key?: string
  /** `object.create`'s `object` input. */
  object: Record<string, unknown>
}

export interface SlideSpec {
  objects: ObjectSpec[]
  transition?: { kind: string; durationMs?: number; direction?: string }
  animations?: Array<{ key?: string; objectKey: string } & Record<string, unknown>>
}

export interface BuiltDeck {
  deckId: string
  title: string
  slideIds: string[]
  /** Object ids by fixture key, per slide. */
  objects: Array<Record<string, string>>
  /** Animation step ids by fixture key, per slide. */
  animations: Array<Record<string, string>>
}

function resultField(result: unknown, field: string, what: string): string {
  const value = (result as Record<string, unknown> | null)?.[field]
  if (typeof value !== 'string') throw new Error(`fixture: ${what} returned no ${field}`)
  return value
}

/**
 * A deck with the given slides, built in one `ops.apply` batch after
 * `deck.create` (animations need object ids, so they go in a second batch).
 */
export async function buildDeck(
  world: World,
  title: string,
  slides: SlideSpec[],
  folderId?: string,
): Promise<BuiltDeck> {
  const { deckId, firstSlideId } = await world.createDeck(title, folderId)
  const ops: Array<{ command: string; input: unknown }> = []
  const slots: Array<{ kind: 'slide' } | { kind: 'object'; slide: number; key?: string }> = []
  for (let i = 1; i < slides.length; i++) {
    ops.push({ command: 'slide.add', input: {} })
    slots.push({ kind: 'slide' })
  }
  slides.forEach((spec, i) => {
    for (const o of spec.objects) {
      ops.push({ command: 'object.create', input: { slide: { index: i }, object: o.object } })
      slots.push(
        o.key === undefined
          ? { kind: 'object', slide: i }
          : { kind: 'object', slide: i, key: o.key },
      )
    }
  })
  slides.forEach((spec, i) => {
    if (spec.transition === undefined) return
    ops.push({ command: 'slide.setTransition', input: { slide: { index: i }, ...spec.transition } })
    slots.push({ kind: 'object', slide: -1 })
  })
  const results = ops.length === 0 ? [] : await world.batch({ deckId }, ops)
  const slideIds = [firstSlideId]
  const objects: Array<Record<string, string>> = slides.map(() => ({}))
  results.forEach((result, i) => {
    const slot = slots[i]!
    if (slot.kind === 'slide') slideIds.push(resultField(result, 'slideId', 'slide.add'))
    else if (slot.slide >= 0 && slot.key !== undefined)
      objects[slot.slide]![slot.key] = resultField(result, 'objectId', 'object.create')
  })

  const animations: Array<Record<string, string>> = slides.map(() => ({}))
  const animOps: Array<{ command: string; input: unknown }> = []
  const animSlots: Array<{ slide: number; key?: string }> = []
  slides.forEach((spec, i) => {
    for (const a of spec.animations ?? []) {
      const { key, objectKey, ...rest } = a
      const objectId = objects[i]![objectKey]
      if (objectId === undefined)
        throw new Error(`fixture: animation on unknown object '${objectKey}'`)
      animOps.push({
        command: 'animation.add',
        input: { slide: { index: i }, object: objectId, ...rest },
      })
      animSlots.push(key === undefined ? { slide: i } : { slide: i, key })
    }
  })
  if (animOps.length > 0) {
    const animResults = await world.batch({ deckId }, animOps)
    animResults.forEach((result, i) => {
      const slot = animSlots[i]!
      if (slot.key !== undefined)
        animations[slot.slide]![slot.key] = resultField(result, 'animationId', 'animation.add')
    })
  }
  return { deckId, title, slideIds, objects, animations }
}

/** How a prompt names a deck: title and id, as a user pasting from the app would. */
export function deckRef(deck: { title: string; deckId: string }): string {
  return `"${deck.title}" (deckId ${deck.deckId})`
}

/** A title text box at the top of the slide. */
export function titleBox(
  text: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'text',
    x: 120,
    y: 80,
    width: 1680,
    height: 120,
    text,
    fontSize: 64,
    fontWeight: 'bold',
    ...extra,
  }
}

/** A body text box below the title. */
export function bodyBox(
  text: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'text',
    x: 120,
    y: 280,
    width: 1680,
    height: 400,
    text,
    fontSize: 28,
    ...extra,
  }
}

/** A title-plus-body slide with the ids returned under `title` / `body`. */
export function titledSlide(title: string, body?: string): SlideSpec {
  const objects: ObjectSpec[] = [{ key: 'title', object: titleBox(title) }]
  if (body !== undefined) objects.push({ key: 'body', object: bodyBox(body) })
  return { objects }
}
