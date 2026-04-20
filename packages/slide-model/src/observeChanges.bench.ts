/**
 * observeChanges.bench.ts
 *
 * Performance benchmark pro subscribeToObjectChangesWithFlush.
 *
 * Scénáře:
 * 1. 1000 mutations (drag simulace) — kolik callback emisí, jak rychle?
 * 2. Coalescing: 1000 updates na stejný objekt → 1 flush → 1 emise
 * 3. 100 různých objektů × 10 updates = 1000 mutations → 100 updated entries per flush
 *
 * Výsledky nejsou automaticky validovány — pro M29 load testing.
 * Tento benchmark dokumentuje M3 baseline.
 *
 * Spuštění: pnpm --filter @narrative/slide-model bench
 * Nebo: node ../../node_modules/vitest/vitest.mjs bench
 */

import { describe, bench, beforeEach } from 'vitest'
import { createSlideDoc } from './yDoc.js'
import { addObject, updateObject, type ObjectsMutationContext } from './mutations.js'
import { getSlideObjectsCtx } from './slides.js'
import type { SlideMutationContext } from './slideMutationContext.js'
import { subscribeToObjectChangesWithFlush } from './observe.js'
import { registerObjectType, _clearRegistry } from './registry.js'
import type { RectangleObject, SlideObject } from '@narrative/shared'

function makeCtx(): ObjectsMutationContext {
  const { doc, slides } = createSlideDoc()
  const dk: SlideMutationContext = { doc, slides }
  const firstSlideId = slides.get(0).get('id') as string
  const ctx = getSlideObjectsCtx(dk, firstSlideId)
  if (ctx === null) throw new Error('makeCtx: no slide-0 objects ctx')
  return ctx
}

const makeRect = (id: string): RectangleObject => ({
  id,
  type: 'rectangle',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  fill: 0xff0000,
  rotation: 0,
  opacity: 1,
})

beforeEach(() => {
  _clearRegistry()
  registerObjectType<RectangleObject>({
    type: 'rectangle',
    defaultProps: () => ({
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      fill: 0xff0000,
      rotation: 0,
      opacity: 1,
    }),
  })
})

describe('M3 baseline benchmark', () => {
  bench('1000 mutations na 1 objekt (drag simulace) — single flush', () => {
    const ctx = makeCtx()
    addObject(ctx, makeRect('r1'))

    let callbackCount = 0
    const { unsubscribe, flush } = subscribeToObjectChangesWithFlush(ctx, () => {
      callbackCount++
    })

    // Clear initial emission count
    callbackCount = 0

    // Simuluj drag: 1000 x updates v jednom "frame"
    for (let i = 0; i < 1000; i++) {
      updateObject<RectangleObject>(ctx, 'r1', { x: i })
    }

    flush() // Jeden flush = jedna emise

    // Expect 1 callback (coalesced)
    if (callbackCount !== 1) {
      throw new Error(`Expected 1 callback, got ${callbackCount}`)
    }

    unsubscribe()
  })

  bench('100 objektů × 10 updates = 1000 mutations — single flush, 100 updated entries', () => {
    const ctx = makeCtx()

    // Přidej 100 objektů
    for (let i = 0; i < 100; i++) {
      addObject(ctx, makeRect(`r${i}`))
    }

    let lastChangeSet: { updated: Array<{ id: string; patch: Partial<SlideObject> }> } | undefined
    const { unsubscribe, flush } = subscribeToObjectChangesWithFlush(ctx, (changes) => {
      lastChangeSet = changes
    })

    // Update každého objektu 10×
    for (let i = 0; i < 100; i++) {
      for (let j = 0; j < 10; j++) {
        updateObject<RectangleObject>(ctx, `r${i}`, { x: j })
      }
    }

    flush()

    if (lastChangeSet === undefined || lastChangeSet.updated.length !== 100) {
      throw new Error(`Expected 100 updated entries, got ${lastChangeSet?.updated.length ?? 0}`)
    }

    unsubscribe()
  })

  bench('60 rAF-style ticks × 1 update = 60 mutations, 60 emissions', () => {
    const ctx = makeCtx()
    addObject(ctx, makeRect('r1'))

    let callbackCount = 0
    const { unsubscribe, flush } = subscribeToObjectChangesWithFlush(ctx, () => {
      callbackCount++
    })
    callbackCount = 0 // reset initial

    // Simuluj 60 rAF ticks, každý tick 1 update + flush
    for (let tick = 0; tick < 60; tick++) {
      updateObject<RectangleObject>(ctx, 'r1', { x: tick })
      flush()
    }

    if (callbackCount !== 60) {
      throw new Error(`Expected 60 callbacks, got ${callbackCount}`)
    }

    unsubscribe()
  })
})
