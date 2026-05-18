/**
 * slide-model/src/components.test.ts
 *
 * Unit tests for M16 P5 component helpers:
 *   - getComponentDocName
 *   - pruneAnimationsToScope
 *   - promoteToComponent
 *
 * All tests are pure — no real Postgres, no network. Uses real Yjs
 * in-memory documents.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import * as Y from 'yjs'
import { createSlideDoc } from './yDoc.js'
import { addObject } from './mutations.js'
import { addTable } from './tableMutations.js'
import { addAnimation } from './animationMutations.js'
import { getSlideObjectsCtx, getSlideAnimationsCtx, listSlides } from './slides.js'
import type { SlideMutationContext } from './slideMutationContext.js'
import type { RectangleObject, AnimationStep, TableObject } from '@narrative/shared'
import { getComponentDocName, pruneAnimationsToScope, promoteToComponent } from './components.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeckCtx(): SlideMutationContext {
  const { doc, slides } = createSlideDoc()
  return { doc, slides }
}

function getFirstSlideId(ctx: SlideMutationContext): string {
  return listSlides(ctx)[0]!.id
}

function makeRect(id: string, x: number, y: number): RectangleObject {
  return {
    id,
    type: 'rectangle',
    x,
    y,
    width: 100,
    height: 80,
    fill: 0xff0000,
    rotation: 0,
    opacity: 1,
  }
}

function makeStep(id: string, objectId: string): AnimationStep {
  return {
    id,
    objectId,
    preset: 'fadeIn',
    trigger: 'onEnter',
    duration: 0.5,
    delay: 0,
    easing: 'linear',
  }
}

// ---------------------------------------------------------------------------
// getComponentDocName
// ---------------------------------------------------------------------------

describe('getComponentDocName', () => {
  it('returns component:<id>', () => {
    expect(getComponentDocName('abc123')).toBe('component:abc123')
  })

  it('handles any string id', () => {
    expect(getComponentDocName('xyz-foo-bar')).toBe('component:xyz-foo-bar')
  })
})

// ---------------------------------------------------------------------------
// pruneAnimationsToScope
// ---------------------------------------------------------------------------

function makeFullStep(id: string, objectId: string): AnimationStep {
  return {
    id,
    objectId,
    preset: 'fadeIn',
    trigger: 'onEnter',
    duration: 0.5,
    delay: 0,
    easing: 'linear',
  }
}

describe('pruneAnimationsToScope', () => {
  it('keeps only steps whose objectId is in the scope set', () => {
    const steps: AnimationStep[] = [
      makeFullStep('s1', 'obj-a'),
      makeFullStep('s2', 'obj-b'),
      makeFullStep('s3', 'obj-c'),
    ]
    const scope = new Set(['obj-a', 'obj-c'])
    const result = pruneAnimationsToScope(steps, scope)
    expect(result).toHaveLength(2)
    expect(result.map((s) => s.id)).toEqual(['s1', 's3'])
  })

  it('returns empty array when no steps match', () => {
    const steps: AnimationStep[] = [makeFullStep('s1', 'obj-x')]
    const scope = new Set(['obj-a'])
    expect(pruneAnimationsToScope(steps, scope)).toHaveLength(0)
  })

  it('returns all steps when all match', () => {
    const steps: AnimationStep[] = [makeFullStep('s1', 'obj-a'), makeFullStep('s2', 'obj-b')]
    const scope = new Set(['obj-a', 'obj-b'])
    expect(pruneAnimationsToScope(steps, scope)).toHaveLength(2)
  })

  it('is pure — does not mutate the input array', () => {
    const steps: AnimationStep[] = [makeFullStep('s1', 'obj-a')]
    const scope = new Set<string>()
    pruneAnimationsToScope(steps, scope)
    expect(steps).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// promoteToComponent
// ---------------------------------------------------------------------------

describe('promoteToComponent', () => {
  let deckCtx: SlideMutationContext
  let slideId: string

  beforeEach(() => {
    deckCtx = makeDeckCtx()
    slideId = getFirstSlideId(deckCtx)

    // Register the rectangle type if not already registered
    // (index.ts registrations run when imported; here we import components.ts directly)
  })

  it('throws when objectIds is empty', () => {
    expect(() => promoteToComponent(deckCtx, slideId, [], 'folder-1')).toThrow(
      'objectIds must not be empty',
    )
  })

  it('throws when slideId does not exist', () => {
    const objCtx = getSlideObjectsCtx(deckCtx, slideId)!
    addObject(objCtx, makeRect('r1', 0, 0))
    expect(() => promoteToComponent(deckCtx, 'no-such-slide', ['r1'], 'folder-1')).toThrow(
      "slide 'no-such-slide' not found",
    )
  })

  it('returns a plan with a generated componentId', () => {
    const objCtx = getSlideObjectsCtx(deckCtx, slideId)!
    addObject(objCtx, makeRect('r1', 50, 60))
    const plan = promoteToComponent(deckCtx, slideId, ['r1'], 'folder-1')
    expect(typeof plan.componentId).toBe('string')
    expect(plan.componentId.length).toBeGreaterThan(0)
  })

  it('master tree contains all promoted objects with stable ids', () => {
    const objCtx = getSlideObjectsCtx(deckCtx, slideId)!
    addObject(objCtx, makeRect('r1', 0, 0))
    addObject(objCtx, makeRect('r2', 200, 0))

    const plan = promoteToComponent(deckCtx, slideId, ['r1', 'r2'], 'folder-1')

    const masterIds = plan.masterTree.map((o) => o.id)
    expect(masterIds).toContain('r1')
    expect(masterIds).toContain('r2')
  })

  it('master tree preserves the original object positions', () => {
    const objCtx = getSlideObjectsCtx(deckCtx, slideId)!
    // r1 at (50, 80) 100×80 → right/bottom edge at (150, 160)
    // r2 at (200, 10) 100×80 → right/bottom edge at (300, 90)
    // bounding box: x=50, y=10, w=250, h=150
    addObject(objCtx, makeRect('r1', 50, 80))
    addObject(objCtx, makeRect('r2', 200, 10))

    const plan = promoteToComponent(deckCtx, slideId, ['r1', 'r2'], 'folder-1')

    // promoteToComponent no longer emits an instance object — components
    // are now stamps. Verify master tree positions instead.
    const positions = plan.masterTree.map((o) => ({ x: o.x, y: o.y }))
    expect(positions).toEqual(
      expect.arrayContaining([
        { x: 50, y: 80 },
        { x: 200, y: 10 },
      ]),
    )
    expect(plan.componentId).toEqual(expect.any(String))
  })

  it('master tree keeps the original promoted object ids', () => {
    const objCtx = getSlideObjectsCtx(deckCtx, slideId)!
    addObject(objCtx, makeRect('r1', 0, 0))

    const plan = promoteToComponent(deckCtx, slideId, ['r1'], 'folder-1')

    expect(plan.masterTree.map((o) => o.id)).toContain('r1')
    expect(plan.removedObjectIds).toContain('r1')
  })

  it('removedObjectIds contains all promoted leaf ids', () => {
    const objCtx = getSlideObjectsCtx(deckCtx, slideId)!
    addObject(objCtx, makeRect('r1', 0, 0))
    addObject(objCtx, makeRect('r2', 100, 0))
    addObject(objCtx, makeRect('r3', 200, 0)) // not promoted

    const plan = promoteToComponent(deckCtx, slideId, ['r1', 'r2'], 'folder-1')

    expect(plan.removedObjectIds).toContain('r1')
    expect(plan.removedObjectIds).toContain('r2')
    expect(plan.removedObjectIds).not.toContain('r3')
  })

  it('master animations are pruned to promoted objects only', () => {
    const objCtx = getSlideObjectsCtx(deckCtx, slideId)!
    const animCtx = getSlideAnimationsCtx(deckCtx, slideId)!
    addObject(objCtx, makeRect('r1', 0, 0))
    addObject(objCtx, makeRect('r2', 100, 0))
    // addAnimation ignores the id field (always generates nanoid) — capture returned ids
    const addedR1 = addAnimation(animCtx, makeStep('step-r1', 'r1'))
    const addedR2 = addAnimation(animCtx, makeStep('step-r2', 'r2'))
    const addedOther = addAnimation(animCtx, makeStep('step-other', 'not-promoted'))

    const plan = promoteToComponent(deckCtx, slideId, ['r1'], 'folder-1')

    const animIds = plan.masterAnimations.map((a) => a.id)
    expect(animIds).toContain(addedR1.id)
    expect(animIds).not.toContain(addedR2.id)
    expect(animIds).not.toContain(addedOther.id)
  })

  it('group children are pulled into the subtree automatically', () => {
    const objCtx = getSlideObjectsCtx(deckCtx, slideId)!
    // r1 is the group root; r2 is a member of the group (groupId = r1.id)
    addObject(objCtx, { ...makeRect('r1', 0, 0) })
    addObject(objCtx, { ...makeRect('r2', 50, 50), groupId: 'r1' })
    addObject(objCtx, { ...makeRect('r3', 200, 200) }) // unrelated

    // Only select r1 — r2 should be pulled in via groupId expansion
    const plan = promoteToComponent(deckCtx, slideId, ['r1'], 'folder-1')

    const masterIds = new Set(plan.masterTree.map((o) => o.id))
    expect(masterIds.has('r1')).toBe(true)
    expect(masterIds.has('r2')).toBe(true)
    expect(masterIds.has('r3')).toBe(false)

    expect(plan.removedObjectIds).toContain('r1')
    expect(plan.removedObjectIds).toContain('r2')
    expect(plan.removedObjectIds).not.toContain('r3')
  })

  it('plan is fully plain-JSON serializable (no Yjs types)', () => {
    const objCtx = getSlideObjectsCtx(deckCtx, slideId)!
    addObject(objCtx, makeRect('r1', 0, 0))

    const plan = promoteToComponent(deckCtx, slideId, ['r1'], 'folder-1')

    // If JSON.stringify throws, the plan contains non-serializable values
    expect(() => JSON.stringify(plan)).not.toThrow()
  })

  // Regression — promoting a table used to leak Y.Text refs from the deck doc
  // into the masterTree (via rows[r][c].text), and the receiver tried to
  // re-encode them into the component doc, blowing the writeAny stack. The
  // plan must contain plain-string cell texts only.
  it('table plan: cell texts are plain strings (no Y.Text refs to source doc)', () => {
    const objCtx = getSlideObjectsCtx(deckCtx, slideId)!
    const tableId = addTable(objCtx, {
      x: 50,
      y: 60,
      width: 300,
      height: 200,
      rows: 2,
      cols: 3,
    })

    // Type some content into cells via Y.Text so the rows have real text.
    // We reach into the live Y.Map to mirror how the editor types.
    const objectsArr = (
      deckCtx.slides.toArray().find((s) => s.get('id') === slideId) as Y.Map<unknown>
    ).get('objects') as Y.Array<Y.Map<unknown>>
    let liveTable: Y.Map<unknown> | null = null
    for (let i = 0; i < objectsArr.length; i++) {
      const m = objectsArr.get(i)
      if (m.get('id') === tableId) {
        liveTable = m
        break
      }
    }
    expect(liveTable).not.toBeNull()
    const rowsY = liveTable!.get('rows') as Y.Array<Y.Array<Y.Map<unknown>>>
    const cellY = rowsY.get(0).get(1)
    const cellText = cellY.get('text') as Y.Text
    cellText.insert(0, 'Hello')

    const plan = promoteToComponent(deckCtx, slideId, [tableId], 'folder-1')

    const tbl = plan.masterTree.find((o) => o.id === tableId) as TableObject
    expect(tbl).toBeDefined()
    expect(tbl.type).toBe('table')
    expect(tbl.rows).toHaveLength(2)
    expect(tbl.rows[0]).toHaveLength(3)
    // Every cell.text must be a plain JS string (no toString/insert duck).
    for (const row of tbl.rows) {
      for (const cell of row) {
        expect(typeof cell.text).toBe('string')
      }
    }
    expect(tbl.rows[0]![1]!.text).toBe('Hello')

    // The whole plan must JSON-serialize (Y.Text would throw because of
    // circular doc refs).
    expect(() => JSON.stringify(plan)).not.toThrow()
  })

  it('different calls produce different componentIds', () => {
    const objCtx1 = getSlideObjectsCtx(deckCtx, slideId)!
    addObject(objCtx1, makeRect('r1', 0, 0))
    const plan1 = promoteToComponent(deckCtx, slideId, ['r1'], 'folder-1')

    // Add a second object and promote it separately
    addObject(objCtx1, makeRect('r2', 200, 0))
    const plan2 = promoteToComponent(deckCtx, slideId, ['r2'], 'folder-1')

    expect(plan1.componentId).not.toBe(plan2.componentId)
  })
})

// ---------------------------------------------------------------------------
// CRDT convergence property — two independent clients produce same plan
// ---------------------------------------------------------------------------

describe('promoteToComponent — CRDT convergence', () => {
  it('two clients reading same Y.Doc state produce identical plans', () => {
    // Build a doc and apply some updates
    const { doc: doc1, slides: slides1 } = createSlideDoc()
    const deckCtx1: SlideMutationContext = { doc: doc1, slides: slides1 }
    const slideId = listSlides(deckCtx1)[0]!.id

    const objCtx1 = getSlideObjectsCtx(deckCtx1, slideId)!
    addObject(objCtx1, makeRect('r1', 10, 20))
    addObject(objCtx1, makeRect('r2', 110, 20))

    // Sync to doc2
    const update = Y.encodeStateAsUpdate(doc1)
    const doc2 = new Y.Doc()
    Y.applyUpdate(doc2, update)
    const slides2 = doc2.getArray<Y.Map<unknown>>('slides')
    const deckCtx2: SlideMutationContext = { doc: doc2, slides: slides2 }

    const plan1 = promoteToComponent(deckCtx1, slideId, ['r1', 'r2'], 'folder-1')
    // plan2 reads the same data via doc2 — results should be structurally equivalent
    // (except componentId which is fresh-generated each time)
    const plan2 = promoteToComponent(deckCtx2, slideId, ['r1', 'r2'], 'folder-1')

    // Master trees should have the same object structure
    expect(plan1.masterTree.length).toBe(plan2.masterTree.length)
    const xs1 = plan1.masterTree.map((o) => o.x).sort()
    const xs2 = plan2.masterTree.map((o) => o.x).sort()
    expect(xs1).toEqual(xs2)
    expect(plan1.removedObjectIds.sort()).toEqual(plan2.removedObjectIds.sort())
  })
})
