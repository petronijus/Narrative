/**
 * agent/touched.ts
 *
 * Which slide and objects a transaction touched, read from the deep events
 * of the deck's `slides` array. The agent's awareness peer selects exactly
 * these, so people watching the canvas see what the agent just changed
 * (ADR 0011 point 8).
 *
 * Event paths are relative to `slides`:
 *   []                              slides added / removed / moved
 *   [slideIndex]                    a slide property (name, background, …)
 *   [slideIndex, 'objects']         objects added / removed / reordered
 *   [slideIndex, 'objects', i, …]   something inside object i
 *   [slideIndex, 'animations', …]   animation steps (their `objectId` is the target)
 * Indices in a path describe the document AFTER the transaction, which is
 * when observers run, so reading `slides.get(i)` there is consistent.
 */

import * as Y from 'yjs'

export interface Touched {
  /** The slide of the last touched thing, if any. */
  slideId: string | null
  /** Objects on `slideId` that were added or changed and still exist. */
  objectIds: string[]
}

function idOf(value: unknown): string | null {
  if (!(value instanceof Y.Map)) return null
  const id = value.get('id')
  return typeof id === 'string' ? id : null
}

function addedMaps(event: Y.YEvent<Y.AbstractType<unknown>>): Y.Map<unknown>[] {
  const out: Y.Map<unknown>[] = []
  for (const item of event.changes.added) {
    for (const value of item.content.getContent()) {
      if (value instanceof Y.Map) out.push(value)
    }
  }
  return out
}

/** Accumulates what a series of deep events touched. */
export class TouchCollector {
  private slideId: string | null = null
  private readonly bySlide = new Map<string, Set<string>>()

  constructor(private readonly slides: Y.Array<Y.Map<unknown>>) {}

  private touch(slideId: string, objectId?: string | null): void {
    this.slideId = slideId
    let set = this.bySlide.get(slideId)
    if (set === undefined) {
      set = new Set()
      this.bySlide.set(slideId, set)
    }
    if (objectId) set.add(objectId)
  }

  readonly observer = (events: Array<Y.YEvent<Y.AbstractType<unknown>>>): void => {
    for (const event of events) {
      const path = event.path
      if (path.length === 0) {
        for (const slide of addedMaps(event)) {
          const id = idOf(slide)
          if (id !== null) this.touch(id)
        }
        continue
      }
      const slideIndex = path[0]
      if (typeof slideIndex !== 'number' || slideIndex >= this.slides.length) continue
      const slide = this.slides.get(slideIndex)
      const slideId = idOf(slide)
      if (slideId === null) continue
      if (path[1] !== 'objects') {
        this.touch(slideId)
        continue
      }
      const objects = slide.get('objects')
      if (!(objects instanceof Y.Array)) continue
      if (path.length === 2) {
        const added = addedMaps(event)
        if (added.length === 0) this.touch(slideId)
        for (const object of added) this.touch(slideId, idOf(object))
        continue
      }
      const objectIndex = path[2]
      if (typeof objectIndex !== 'number' || objectIndex >= objects.length) continue
      this.touch(slideId, idOf(objects.get(objectIndex)))
    }
  }

  /** The last touched slide and the still-existing objects touched on it. */
  result(): Touched {
    if (this.slideId === null) return { slideId: null, objectIds: [] }
    const wanted = this.bySlide.get(this.slideId) ?? new Set<string>()
    const existing = new Set<string>()
    for (let i = 0; i < this.slides.length; i++) {
      const slide = this.slides.get(i)
      if (idOf(slide) !== this.slideId) continue
      const objects = slide.get('objects')
      if (objects instanceof Y.Array) {
        for (const object of objects.toArray()) {
          const id = idOf(object)
          if (id !== null && wanted.has(id)) existing.add(id)
        }
      }
      return { slideId: this.slideId, objectIds: [...existing] }
    }
    // The slide itself is gone (deleted by the transaction).
    return { slideId: null, objectIds: [] }
  }
}

/**
 * Run `fn` (which performs one transaction) while collecting what it touched
 * under `slides`. The observer is attached only for the duration of `fn`.
 */
export function collectTouched(slides: Y.Array<Y.Map<unknown>>, fn: () => void): Touched {
  const collector = new TouchCollector(slides)
  slides.observeDeep(collector.observer)
  try {
    fn()
  } finally {
    slides.unobserveDeep(collector.observer)
  }
  return collector.result()
}
