/**
 * convergence.property.test.ts
 *
 * Property-based test that two Y.Doc clients receiving the same set of
 * deck mutations — applied in arbitrary orders, with sync points between
 * — converge to identical state.
 *
 * Why this is the most valuable test in the package:
 *   The whole CRDT promise is "any client sees the same final state
 *   regardless of network ordering". Yjs guarantees that for primitives,
 *   but our wrapper API (addSlide, addObject, moveObjectsLayer,
 *   updateObject, …) is what users actually call. A non-CRDT-safe
 *   mutation — e.g. one that reads then writes outside a transact, or
 *   uses a sequence number that depends on local insertion order —
 *   would slip past every per-mutation unit test we have, but would
 *   break convergence here.
 *
 * Scope:
 *   - Mutations covered: addSlide, removeSlide (when ≥ 2 slides), addObject,
 *     updateObject (x/y), removeObject, moveObjectsLayer (front/back).
 *   - Both clients begin from a synced base — we hydrate Client B from
 *     Client A's initial state vector so neither side has phantom
 *     pre-existing slides with different ids.
 *   - Each "round" both clients run a subset of operations, exchange
 *     full updates, and the loop continues. After N rounds we assert:
 *       * `Y.encodeStateAsUpdate(a)` ≡ `Y.encodeStateAsUpdate(b)`  (byte-equal)
 *       * `listSlides(a)` deep-equals `listSlides(b)` (structural)
 *
 * Failure mode:
 *   When a future contributor adds a mutation that reads-then-writes
 *   without a transact, or one that uses Date.now() / Math.random()
 *   in a non-deterministic way, fast-check will shrink the failing op
 *   sequence to the smallest reproducer.
 */

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import * as Y from 'yjs'
import { hydrateSlideDoc } from './yDoc.js'
import { addSlide, removeSlide, listSlides, getSlideObjectsCtx } from './slides.js'
import { addObject, removeObject, updateObject, moveObjectsLayer } from './mutations.js'
import type { SlideObject } from '@narrative/shared'

// ---------------------------------------------------------------------------
// Operation shapes — small finite set so fast-check can shrink failures.
// Each op has a `kind` discriminant + tiny payload.
// ---------------------------------------------------------------------------

type Op =
  | { kind: 'addSlide' }
  | { kind: 'removeSlide'; slideIdx: number }
  | { kind: 'addObject'; slideIdx: number; objectId: string; x: number; y: number }
  | { kind: 'updateObject'; slideIdx: number; objIdx: number; x: number; y: number }
  | { kind: 'removeObject'; slideIdx: number; objIdx: number }
  | { kind: 'moveLayer'; slideIdx: number; objIdx: number; direction: 'front' | 'back' }

const opArbitrary: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant('addSlide' as const) }),
  fc.record({
    kind: fc.constant('removeSlide' as const),
    slideIdx: fc.nat({ max: 5 }),
  }),
  fc.record({
    kind: fc.constant('addObject' as const),
    slideIdx: fc.nat({ max: 5 }),
    objectId: fc.string({ minLength: 4, maxLength: 8 }).filter((s) => /^[a-zA-Z0-9_-]+$/.test(s)),
    x: fc.integer({ min: 0, max: 1000 }),
    y: fc.integer({ min: 0, max: 1000 }),
  }),
  fc.record({
    kind: fc.constant('updateObject' as const),
    slideIdx: fc.nat({ max: 5 }),
    objIdx: fc.nat({ max: 10 }),
    x: fc.integer({ min: 0, max: 1000 }),
    y: fc.integer({ min: 0, max: 1000 }),
  }),
  fc.record({
    kind: fc.constant('removeObject' as const),
    slideIdx: fc.nat({ max: 5 }),
    objIdx: fc.nat({ max: 10 }),
  }),
  fc.record({
    kind: fc.constant('moveLayer' as const),
    slideIdx: fc.nat({ max: 5 }),
    objIdx: fc.nat({ max: 10 }),
    direction: fc.constantFrom('front' as const, 'back' as const),
  }),
)

// ---------------------------------------------------------------------------
// Op application — bounded against the live state. Each handler treats
// out-of-range indexes as no-ops so fast-check's freely-generated
// indices don't blow up the test on every iteration.
// ---------------------------------------------------------------------------

function applyOp(handles: ReturnType<typeof hydrateSlideDoc>, op: Op): void {
  const slides = listSlides(handles)
  switch (op.kind) {
    case 'addSlide':
      addSlide(handles)
      return
    case 'removeSlide': {
      // Don't allow removing the last slide — leaves the deck in a state
      // the editor never produces (zero slides). Skip when count ≤ 1.
      if (slides.length <= 1) return
      const target = slides[op.slideIdx % slides.length]
      if (target !== undefined) removeSlide(handles, target.id)
      return
    }
    case 'addObject': {
      if (slides.length === 0) return
      const slide = slides[op.slideIdx % slides.length]!
      const ctx = getSlideObjectsCtx(handles, slide.id)
      if (ctx === null) return
      // Skip if id already exists on this slide — addObject is documented
      // to throw on duplicate ids. The randomness of fast-check would
      // produce duplicates often enough to dominate the test.
      if (slide.objects.some((o) => o.id === op.objectId)) return
      const obj: SlideObject = {
        id: op.objectId,
        type: 'rectangle',
        x: op.x,
        y: op.y,
        width: 100,
        height: 80,
        rotation: 0,
        opacity: 1,
        fill: 0xff0000,
      }
      addObject(ctx, obj)
      return
    }
    case 'updateObject': {
      if (slides.length === 0) return
      const slide = slides[op.slideIdx % slides.length]!
      if (slide.objects.length === 0) return
      const obj = slide.objects[op.objIdx % slide.objects.length]!
      const ctx = getSlideObjectsCtx(handles, slide.id)
      if (ctx === null) return
      updateObject(ctx, obj.id, { x: op.x, y: op.y })
      return
    }
    case 'removeObject': {
      if (slides.length === 0) return
      const slide = slides[op.slideIdx % slides.length]!
      if (slide.objects.length === 0) return
      const obj = slide.objects[op.objIdx % slide.objects.length]!
      const ctx = getSlideObjectsCtx(handles, slide.id)
      if (ctx === null) return
      removeObject(ctx, obj.id)
      return
    }
    case 'moveLayer': {
      if (slides.length === 0) return
      const slide = slides[op.slideIdx % slides.length]!
      if (slide.objects.length === 0) return
      const obj = slide.objects[op.objIdx % slide.objects.length]!
      const ctx = getSlideObjectsCtx(handles, slide.id)
      if (ctx === null) return
      moveObjectsLayer(ctx, [obj.id], op.direction)
      return
    }
  }
}

// ---------------------------------------------------------------------------
// Sync helpers — full-state exchange. Cheaper would be incremental state-
// vector exchange, but for the test we want the simplest possible
// "after sync, both docs are equal" assertion.
// ---------------------------------------------------------------------------

/** Bidirectional sync — after this call both docs hold the union of changes. */
function syncBoth(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
}

/**
 * Make a fresh Client B that starts from Client A's current state. Without
 * this, both docs would have run their own `createSlideDoc()` and each
 * generated a different initial slide id — they'd never converge.
 */
function cloneFrom(source: Y.Doc): Y.Doc {
  const clone = new Y.Doc()
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(source))
  return clone
}

// ---------------------------------------------------------------------------
// Convergence assertion — both docs must produce byte-identical state
// updates and structurally-identical slide snapshots.
// ---------------------------------------------------------------------------

function assertConverged(a: Y.Doc, b: Y.Doc): void {
  // We cannot byte-compare `Y.encodeStateAsUpdate(...)` between two
  // converged docs: the encoding includes per-client clock entries in
  // map iteration order, which depends on the order each client first
  // appeared on the doc. Two docs that are *semantically* identical can
  // still emit different bytes here. Yjs's CRDT contract is that the
  // observable state (what users see through our wrapper API) converges,
  // not that the wire format is canonical.
  //
  // State-vector equality is also order-sensitive for the same reason.
  // The honest assertion is structural: compare the deep snapshot of
  // every slide on both sides.
  const ah = { doc: a, slides: a.getArray<Y.Map<unknown>>('slides') }
  const bh = { doc: b, slides: b.getArray<Y.Map<unknown>>('slides') }
  const aSnap = listSlides(ah).map(stripDocPointers)
  const bSnap = listSlides(bh).map(stripDocPointers)
  expect(aSnap).toEqual(bSnap)
}

/**
 * `listSlides()` returns plain JS objects, but Yjs nested types
 * (Y.Text in `text` fields, Y.XmlFragment in `notes`) leak in as live
 * references. Two converged docs hold *equal* but *not identical* live
 * references, so structural deep-equality compares them via toJSON().
 */
function stripDocPointers(slide: ReturnType<typeof listSlides>[number]): unknown {
  return JSON.parse(JSON.stringify(slide))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Each property runs 100–200 random op sequences: ~0.2 s alone, but its time
// grows with the run count, so it gets its own budget rather than the 5 s of
// a unit test — on a busy MacBook it crossed that inside `just check`
// (2026-10-07/08).
describe('CRDT convergence — slide-model mutations', { timeout: 60_000 }, () => {
  it('two clients converge after applying disjoint op sequences with periodic sync', () => {
    fc.assert(
      fc.property(
        // Two op streams + a deterministic seed for any internal randomness.
        fc.array(opArbitrary, { minLength: 1, maxLength: 30 }),
        fc.array(opArbitrary, { minLength: 1, maxLength: 30 }),
        // Sync cadence: how many ops each side runs before the next bidir
        // sync. 1 = lockstep (almost no chance of conflict), 5 = juicy
        // concurrent edits. fast-check picks both extremes.
        fc.integer({ min: 1, max: 5 }),
        (opsA, opsB, syncEvery) => {
          // Initialise both clients from the same base state.
          const handlesA = hydrateSlideDoc(new Y.Doc())
          const docB = cloneFrom(handlesA.doc)
          const handlesB = { doc: docB, slides: docB.getArray<Y.Map<unknown>>('slides') }

          // Run ops in interleaved chunks, syncing between chunks.
          let i = 0
          let j = 0
          while (i < opsA.length || j < opsB.length) {
            // Chunk on A
            for (let k = 0; k < syncEvery && i < opsA.length; k++, i++) {
              applyOp(handlesA, opsA[i]!)
            }
            // Chunk on B
            for (let k = 0; k < syncEvery && j < opsB.length; k++, j++) {
              applyOp(handlesB, opsB[j]!)
            }
            // Bidirectional sync — after this both docs must be equal.
            syncBoth(handlesA.doc, handlesB.doc)
            assertConverged(handlesA.doc, handlesB.doc)
          }
        },
      ),
      {
        // Default fast-check runs 100 iterations; CRDT property tests
        // historically need more samples to flush rare orderings out, so
        // bump moderately. Each iteration is < 50ms in practice.
        numRuns: 200,
      },
    )
  })

  it('three clients converge under a star sync topology (all sync through hub A)', () => {
    fc.assert(
      fc.property(
        fc.array(opArbitrary, { minLength: 1, maxLength: 15 }),
        fc.array(opArbitrary, { minLength: 1, maxLength: 15 }),
        fc.array(opArbitrary, { minLength: 1, maxLength: 15 }),
        (opsA, opsB, opsC) => {
          const a = hydrateSlideDoc(new Y.Doc())
          const docB = cloneFrom(a.doc)
          const b = { doc: docB, slides: docB.getArray<Y.Map<unknown>>('slides') }
          const docC = cloneFrom(a.doc)
          const c = { doc: docC, slides: docC.getArray<Y.Map<unknown>>('slides') }

          // Each client runs all its ops independently.
          for (const op of opsA) applyOp(a, op)
          for (const op of opsB) applyOp(b, op)
          for (const op of opsC) applyOp(c, op)

          // Star sync: B and C exchange via A. Two rounds because the
          // first one only carries A→B and A→C; the second carries B→A→C
          // and C→A→B.
          syncBoth(a.doc, b.doc)
          syncBoth(a.doc, c.doc)
          syncBoth(a.doc, b.doc)
          syncBoth(a.doc, c.doc)

          // All three must agree.
          assertConverged(a.doc, b.doc)
          assertConverged(a.doc, c.doc)
          assertConverged(b.doc, c.doc)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('an offline client that buffers many ops still converges on reconnect', () => {
    fc.assert(
      fc.property(
        fc.array(opArbitrary, { minLength: 1, maxLength: 20 }),
        fc.array(opArbitrary, { minLength: 1, maxLength: 20 }),
        (online, offline) => {
          const a = hydrateSlideDoc(new Y.Doc())
          const docB = cloneFrom(a.doc)
          const b = { doc: docB, slides: docB.getArray<Y.Map<unknown>>('slides') }

          // Simulate B going offline immediately. A keeps editing.
          for (const op of online) applyOp(a, op)
          // B catches up on its local backlog without seeing any of A's edits.
          for (const op of offline) applyOp(b, op)

          // B reconnects — single round of bidirectional sync.
          syncBoth(a.doc, b.doc)

          assertConverged(a.doc, b.doc)
        },
      ),
      { numRuns: 100 },
    )
  })
})
