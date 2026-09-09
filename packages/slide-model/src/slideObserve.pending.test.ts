/**
 * slide-model/src/slideObserve.pending.test.ts
 *
 * Subscribing to a slide that is not in the deck *yet* used to return a dead
 * no-op subscription: the callback never fired, not even the initial emit.
 *
 * That is a race a real session hits — the route knows the slide id before
 * Hocuspocus has delivered the deck. The consequences cascade:
 * `useSlideObjects` keeps an empty list forever, the stale-selection sanitiser
 * in EditorLayout then drops every selection the moment it is made, and the
 * canvas hit test has nothing to hit — so clicking an object selects nothing
 * and double-click never opens the text editor. Diagnosed 2026-09-09 while
 * working out why the text-editing e2e specs could not enter edit mode.
 */

import { describe, it, expect, vi } from 'vitest'
import * as Y from 'yjs'
import { subscribeToSlideObjects, subscribeToSlideObjectsWithFlush } from './slideObserve.js'
import { createSlideDoc } from './yDoc.js'
import { addSlide, getSlideObjectsCtx, type SlideMutationContext } from './slides.js'
import { addObject } from './mutations.js'
import type { SlideObject } from '@narrative/shared'

function rect(id: string): SlideObject {
  return {
    id,
    type: 'rect',
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    rotation: 0,
    opacity: 1,
    fill: 0xff0000,
  } as unknown as SlideObject
}

function makeCtx(): SlideMutationContext {
  const { doc, slides } = createSlideDoc()
  return { doc, slides }
}

/** A peer's deck carrying one extra slide with `objectIds` on it. */
function remoteDeckWith(objectIds: string[]): { update: Uint8Array; slideId: string } {
  const remote = makeCtx()
  const slide = addSlide(remote)
  const objectsCtx = getSlideObjectsCtx(remote, slide.id)
  if (objectsCtx === null) throw new Error('remote slide objects ctx missing')
  for (const id of objectIds) addObject(objectsCtx, rect(id))
  return { update: Y.encodeStateAsUpdate(remote.doc), slideId: slide.id }
}

describe('subscribeToSlideObjects — slide not present yet', () => {
  it('delivers the slide once it arrives over sync', () => {
    const ctx = makeCtx()
    const { update, slideId } = remoteDeckWith(['r1'])

    const snapshots: string[][] = []
    const { unsubscribe, flush } = subscribeToSlideObjectsWithFlush(ctx, slideId, (changes) => {
      snapshots.push(changes.snapshot.map((o) => o.id))
    })
    expect(snapshots).toEqual([]) // nothing to report while the slide is absent

    Y.applyUpdate(ctx.doc, update)
    flush()

    expect(snapshots.at(-1)).toEqual(['r1'])
    unsubscribe()
  })

  it('keeps reporting edits made after the late binding', () => {
    const ctx = makeCtx()
    const { update, slideId } = remoteDeckWith([])

    const snapshots: string[][] = []
    const { unsubscribe, flush } = subscribeToSlideObjectsWithFlush(ctx, slideId, (changes) => {
      snapshots.push(changes.snapshot.map((o) => o.id))
    })
    Y.applyUpdate(ctx.doc, update)

    const objectsCtx = getSlideObjectsCtx(ctx, slideId)
    expect(objectsCtx).not.toBeNull()
    addObject(objectsCtx!, rect('later'))
    flush()

    expect(snapshots.at(-1)).toEqual(['later'])
    unsubscribe()
  })

  it('unsubscribing before the slide arrives stops the callback for good', () => {
    const ctx = makeCtx()
    const { update } = remoteDeckWith(['r1'])
    const { slideId } = remoteDeckWith([]) // an id this doc will never see
    const cb = vi.fn()

    const unsubscribe = subscribeToSlideObjects(ctx, slideId, cb)
    unsubscribe()

    Y.applyUpdate(ctx.doc, update)
    addSlide(ctx)

    expect(cb).not.toHaveBeenCalled()
  })
})
