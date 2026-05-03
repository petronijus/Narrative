/**
 * instanceOverrides.test.ts — M16 P7
 *
 * Tests for the Yjs override mutation helpers. Uses real in-memory Y.Docs.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import * as Y from 'yjs'
import { createSlideDoc } from './yDoc.js'
import { addObject } from './mutations.js'
import { getSlideObjectsCtx, listSlides } from './slides.js'
import { createUndoManager } from './undo.js'
import type { SlideMutationContext } from './slideMutationContext.js'
import type { ComponentInstanceObject } from '@narrative/shared'
import {
  setLeafOverride,
  setLeafOverridePatch,
  seedInstanceTextCopy,
  clearLeafOverride,
  setAnimationOverride,
  clearAnimationOverride,
  resetAllOverrides,
  instanceMasterMissing,
  type MasterPresenceProbe,
} from './instanceOverrides.js'
import { yMapToPlainObject } from './bindings.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeck(): {
  ctx: SlideMutationContext
  slideId: string
} {
  const { doc, slides } = createSlideDoc()
  const ctx: SlideMutationContext = { doc, slides }
  const slideId = listSlides(ctx)[0]!.id
  return { ctx, slideId }
}

function addInstance(
  ctx: SlideMutationContext,
  slideId: string,
  id = 'inst-1',
): ComponentInstanceObject {
  const objCtx = getSlideObjectsCtx(ctx, slideId)!
  const obj: ComponentInstanceObject = {
    id,
    type: 'componentInstance',
    componentId: 'comp-x',
    x: 0,
    y: 0,
    width: 200,
    height: 150,
    rotation: 0,
    opacity: 1,
  }
  addObject(objCtx, obj)
  return obj
}

function readInstancePlain(
  ctx: SlideMutationContext,
  slideId: string,
  id: string,
): ComponentInstanceObject {
  const objCtx = getSlideObjectsCtx(ctx, slideId)!
  for (let i = 0; i < objCtx.objects.length; i++) {
    const m = objCtx.objects.get(i)
    if (m.get('id') === id) {
      return yMapToPlainObject<ComponentInstanceObject>(m)
    }
  }
  throw new Error(`instance not found: ${id}`)
}

// ---------------------------------------------------------------------------
// setLeafOverride
// ---------------------------------------------------------------------------

describe('setLeafOverride', () => {
  let env: ReturnType<typeof makeDeck>
  beforeEach(() => {
    env = makeDeck()
    addInstance(env.ctx, env.slideId)
  })

  it('writes a single field into overrides.leaves[leafId]', () => {
    const objCtx = getSlideObjectsCtx(env.ctx, env.slideId)!
    setLeafOverride(objCtx, 'inst-1', 'leaf-a', { fill: 0xff00ff })

    const plain = readInstancePlain(env.ctx, env.slideId, 'inst-1')
    expect(plain.overrides?.leaves?.['leaf-a']?.fill).toBe(0xff00ff)
  })

  it('merges multiple fields across separate calls', () => {
    const objCtx = getSlideObjectsCtx(env.ctx, env.slideId)!
    setLeafOverride(objCtx, 'inst-1', 'leaf-a', { fill: 0xff0000 })
    setLeafOverride(objCtx, 'inst-1', 'leaf-a', { stroke: 0x00ff00 })

    const plain = readInstancePlain(env.ctx, env.slideId, 'inst-1')
    expect(plain.overrides?.leaves?.['leaf-a']).toEqual({
      fill: 0xff0000,
      stroke: 0x00ff00,
    })
  })

  it('writes a transform with x/y inside a nested map', () => {
    const objCtx = getSlideObjectsCtx(env.ctx, env.slideId)!
    setLeafOverride(objCtx, 'inst-1', 'leaf-a', { transform: { x: 10, y: -5 } })

    const plain = readInstancePlain(env.ctx, env.slideId, 'inst-1')
    expect(plain.overrides?.leaves?.['leaf-a']?.transform).toEqual({ x: 10, y: -5 })
  })

  it('explicit undefined deletes the key', () => {
    const objCtx = getSlideObjectsCtx(env.ctx, env.slideId)!
    setLeafOverride(objCtx, 'inst-1', 'leaf-a', { fill: 0xff0000 })
    setLeafOverride(objCtx, 'inst-1', 'leaf-a', { fill: undefined })

    const plain = readInstancePlain(env.ctx, env.slideId, 'inst-1')
    expect(plain.overrides?.leaves?.['leaf-a']?.fill).toBeUndefined()
  })

  it('no-op when instance id does not exist', () => {
    const objCtx = getSlideObjectsCtx(env.ctx, env.slideId)!
    setLeafOverride(objCtx, 'nope', 'leaf-a', { fill: 0xff0000 })
    // Should not throw and not corrupt the doc.
    const plain = readInstancePlain(env.ctx, env.slideId, 'inst-1')
    expect(plain.overrides).toBeUndefined()
  })

  it('runs in a single transaction (one undo step)', () => {
    const objCtx = getSlideObjectsCtx(env.ctx, env.slideId)!
    const undo = createUndoManager(env.ctx)

    setLeafOverride(objCtx, 'inst-1', 'leaf-a', {
      fill: 0xff0000,
      stroke: 0x00ff00,
      transform: { x: 5, y: 7 },
    })

    let plain = readInstancePlain(env.ctx, env.slideId, 'inst-1')
    expect(plain.overrides?.leaves?.['leaf-a']?.fill).toBe(0xff0000)

    undo.undo()

    plain = readInstancePlain(env.ctx, env.slideId, 'inst-1')
    // After one undo step the override slot should be gone entirely
    // (the helper created the nested Y.Maps inside the same transact).
    expect(plain.overrides?.leaves?.['leaf-a']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// clearLeafOverride
// ---------------------------------------------------------------------------

describe('clearLeafOverride', () => {
  it('removes the entire leaf entry', () => {
    const env = makeDeck()
    addInstance(env.ctx, env.slideId)
    const objCtx = getSlideObjectsCtx(env.ctx, env.slideId)!

    setLeafOverride(objCtx, 'inst-1', 'leaf-a', { fill: 0xff0000 })
    setLeafOverride(objCtx, 'inst-1', 'leaf-b', { fill: 0x00ff00 })
    clearLeafOverride(objCtx, 'inst-1', 'leaf-a')

    const plain = readInstancePlain(env.ctx, env.slideId, 'inst-1')
    expect(plain.overrides?.leaves?.['leaf-a']).toBeUndefined()
    expect(plain.overrides?.leaves?.['leaf-b']?.fill).toBe(0x00ff00)
  })

  it('no-op when leaf has no override', () => {
    const env = makeDeck()
    addInstance(env.ctx, env.slideId)
    const objCtx = getSlideObjectsCtx(env.ctx, env.slideId)!
    clearLeafOverride(objCtx, 'inst-1', 'never-set')
    // Just check it didn't throw.
    expect(true).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// setAnimationOverride / clearAnimationOverride
// ---------------------------------------------------------------------------

describe('setAnimationOverride', () => {
  it('writes trigger / delay / duration / ease', () => {
    const env = makeDeck()
    addInstance(env.ctx, env.slideId)
    const objCtx = getSlideObjectsCtx(env.ctx, env.slideId)!

    setAnimationOverride(objCtx, 'inst-1', 'step-1', {
      trigger: 'onClick',
      delay: 1,
      duration: 2,
      ease: 'sine.inOut',
    })

    const plain = readInstancePlain(env.ctx, env.slideId, 'inst-1')
    expect(plain.overrides?.animations?.['step-1']).toEqual({
      trigger: 'onClick',
      delay: 1,
      duration: 2,
      ease: 'sine.inOut',
    })
  })

  it('writes finite `order` and clears it on non-finite / undefined', () => {
    const env = makeDeck()
    addInstance(env.ctx, env.slideId)
    const objCtx = getSlideObjectsCtx(env.ctx, env.slideId)!

    setAnimationOverride(objCtx, 'inst-1', 'step-1', { order: 2 })
    let plain = readInstancePlain(env.ctx, env.slideId, 'inst-1')
    expect(plain.overrides?.animations?.['step-1']?.order).toBe(2)

    // Non-finite values are dropped and clear the existing slot.
    setAnimationOverride(objCtx, 'inst-1', 'step-1', { order: Number.NaN })
    plain = readInstancePlain(env.ctx, env.slideId, 'inst-1')
    expect(plain.overrides?.animations?.['step-1']?.order).toBeUndefined()

    // Re-set, then explicitly clear with undefined.
    setAnimationOverride(objCtx, 'inst-1', 'step-1', { order: 5 })
    setAnimationOverride(objCtx, 'inst-1', 'step-1', { order: undefined })
    plain = readInstancePlain(env.ctx, env.slideId, 'inst-1')
    expect(plain.overrides?.animations?.['step-1']?.order).toBeUndefined()
  })

  it('disabled true sets the slot, anything else clears it', () => {
    const env = makeDeck()
    addInstance(env.ctx, env.slideId)
    const objCtx = getSlideObjectsCtx(env.ctx, env.slideId)!

    setAnimationOverride(objCtx, 'inst-1', 'step-1', { disabled: true })
    let plain = readInstancePlain(env.ctx, env.slideId, 'inst-1')
    expect(plain.overrides?.animations?.['step-1']?.disabled).toBe(true)

    setAnimationOverride(objCtx, 'inst-1', 'step-1', { disabled: undefined })
    plain = readInstancePlain(env.ctx, env.slideId, 'inst-1')
    expect(plain.overrides?.animations?.['step-1']?.disabled).toBeUndefined()
  })
})

describe('clearAnimationOverride', () => {
  it('removes the entire step entry', () => {
    const env = makeDeck()
    addInstance(env.ctx, env.slideId)
    const objCtx = getSlideObjectsCtx(env.ctx, env.slideId)!
    setAnimationOverride(objCtx, 'inst-1', 'step-1', { delay: 1 })
    clearAnimationOverride(objCtx, 'inst-1', 'step-1')

    const plain = readInstancePlain(env.ctx, env.slideId, 'inst-1')
    expect(plain.overrides?.animations?.['step-1']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// resetAllOverrides
// ---------------------------------------------------------------------------

describe('resetAllOverrides', () => {
  it('drops the whole overrides slot', () => {
    const env = makeDeck()
    addInstance(env.ctx, env.slideId)
    const objCtx = getSlideObjectsCtx(env.ctx, env.slideId)!

    setLeafOverride(objCtx, 'inst-1', 'leaf-a', { fill: 0xff0000 })
    setAnimationOverride(objCtx, 'inst-1', 'step-1', { delay: 1 })
    resetAllOverrides(objCtx, 'inst-1')

    const plain = readInstancePlain(env.ctx, env.slideId, 'inst-1')
    expect(plain.overrides).toBeUndefined()
  })

  it('single undo restores all overrides at once', () => {
    const env = makeDeck()
    addInstance(env.ctx, env.slideId)
    const objCtx = getSlideObjectsCtx(env.ctx, env.slideId)!
    const undo = createUndoManager(env.ctx)

    setLeafOverride(objCtx, 'inst-1', 'leaf-a', { fill: 0xff0000 })
    setLeafOverride(objCtx, 'inst-1', 'leaf-b', { stroke: 0x00ff00 })
    undo.stopCapturing()
    resetAllOverrides(objCtx, 'inst-1')

    let plain = readInstancePlain(env.ctx, env.slideId, 'inst-1')
    expect(plain.overrides).toBeUndefined()

    undo.undo()
    plain = readInstancePlain(env.ctx, env.slideId, 'inst-1')
    expect(plain.overrides?.leaves?.['leaf-a']?.fill).toBe(0xff0000)
    expect(plain.overrides?.leaves?.['leaf-b']?.stroke).toBe(0x00ff00)
  })
})

// ---------------------------------------------------------------------------
// Dangling-id preservation
// ---------------------------------------------------------------------------

describe('dangling override preservation', () => {
  it('overrides on leaf ids that no longer exist in the master remain in the doc', () => {
    // The mutation helpers don't know about the master at all — they
    // treat any id as opaque. The "dangling" guarantee in the spec is
    // that nothing automatically prunes them. This test enforces that
    // contract: writing a leaf override and then never adding the leaf
    // to a master leaves the slot intact.
    const env = makeDeck()
    addInstance(env.ctx, env.slideId)
    const objCtx = getSlideObjectsCtx(env.ctx, env.slideId)!

    setLeafOverride(objCtx, 'inst-1', 'ghost-leaf', { fill: 0x123456 })

    // Simulate further unrelated mutations on the instance.
    setLeafOverride(objCtx, 'inst-1', 'real-leaf', { fill: 0xabcdef })

    const plain = readInstancePlain(env.ctx, env.slideId, 'inst-1')
    expect(plain.overrides?.leaves?.['ghost-leaf']?.fill).toBe(0x123456)
    expect(plain.overrides?.leaves?.['real-leaf']?.fill).toBe(0xabcdef)
  })
})

// ---------------------------------------------------------------------------
// instanceMasterMissing
// ---------------------------------------------------------------------------

describe('instanceMasterMissing', () => {
  function makeProbe(opts: { status?: 'pending' | 'synced'; has?: boolean }): MasterPresenceProbe {
    return {
      getStatus: () => opts.status ?? 'synced',
      hasMaster: () => opts.has ?? true,
    }
  }

  it('true when componentId is empty', () => {
    expect(instanceMasterMissing({ componentId: '' }, makeProbe({}))).toBe(true)
    expect(instanceMasterMissing({}, makeProbe({}))).toBe(true)
  })

  it('false when status is pending (still loading)', () => {
    expect(
      instanceMasterMissing({ componentId: 'x' }, makeProbe({ status: 'pending', has: false })),
    ).toBe(false)
  })

  it('true when synced + master absent', () => {
    expect(
      instanceMasterMissing({ componentId: 'x' }, makeProbe({ status: 'synced', has: false })),
    ).toBe(true)
  })

  it('false when synced + master present', () => {
    expect(
      instanceMasterMissing({ componentId: 'x' }, makeProbe({ status: 'synced', has: true })),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Storage integrity — overrides are nested Y.Maps under the hood
// ---------------------------------------------------------------------------

describe('storage layout', () => {
  it('uses nested Y.Maps so concurrent merges are field-granular', () => {
    const env = makeDeck()
    addInstance(env.ctx, env.slideId)
    const objCtx = getSlideObjectsCtx(env.ctx, env.slideId)!
    setLeafOverride(objCtx, 'inst-1', 'leaf-a', { fill: 0xff0000 })

    const yMap = objCtx.objects.get(0)
    const overrides = yMap.get('overrides')
    expect(overrides).toBeInstanceOf(Y.Map)
    const leaves = (overrides as Y.Map<unknown>).get('leaves')
    expect(leaves).toBeInstanceOf(Y.Map)
    const leafA = (leaves as Y.Map<unknown>).get('leaf-a')
    expect(leafA).toBeInstanceOf(Y.Map)
  })
})

// ---------------------------------------------------------------------------
// setLeafOverridePatch — generic patch adapter
// ---------------------------------------------------------------------------

describe('setLeafOverridePatch', () => {
  it('writes rotation and opacity as plain values', () => {
    const env = makeDeck()
    addInstance(env.ctx, env.slideId)
    const objCtx = getSlideObjectsCtx(env.ctx, env.slideId)!

    setLeafOverridePatch(objCtx, 'inst-1', 'leaf-a', { rotation: 45, opacity: 0.5 })

    const plain = readInstancePlain(env.ctx, env.slideId, 'inst-1')
    expect(plain.overrides?.leaves?.['leaf-a']).toMatchObject({ rotation: 45, opacity: 0.5 })
  })

  it('writes fontSize and fontWeight', () => {
    const env = makeDeck()
    addInstance(env.ctx, env.slideId)
    const objCtx = getSlideObjectsCtx(env.ctx, env.slideId)!

    setLeafOverridePatch(objCtx, 'inst-1', 'leaf-a', { fontSize: 32, fontWeight: 'bold' })

    const plain = readInstancePlain(env.ctx, env.slideId, 'inst-1')
    expect(plain.overrides?.leaves?.['leaf-a']).toMatchObject({ fontSize: 32, fontWeight: 'bold' })
  })

  it('writes cornerRadius', () => {
    const env = makeDeck()
    addInstance(env.ctx, env.slideId)
    const objCtx = getSlideObjectsCtx(env.ctx, env.slideId)!

    setLeafOverridePatch(objCtx, 'inst-1', 'leaf-a', { cornerRadius: 8 })

    const plain = readInstancePlain(env.ctx, env.slideId, 'inst-1')
    expect(plain.overrides?.leaves?.['leaf-a']).toMatchObject({ cornerRadius: 8 })
  })

  it('writes assetId and fill together', () => {
    const env = makeDeck()
    addInstance(env.ctx, env.slideId)
    const objCtx = getSlideObjectsCtx(env.ctx, env.slideId)!

    setLeafOverridePatch(objCtx, 'inst-1', 'leaf-a', { assetId: 'img-123', fill: 0x00ff00 })

    const plain = readInstancePlain(env.ctx, env.slideId, 'inst-1')
    expect(plain.overrides?.leaves?.['leaf-a']).toMatchObject({
      assetId: 'img-123',
      fill: 0x00ff00,
    })
  })

  it('writes fillStyle as plain JSON (atomic sub-object)', () => {
    const env = makeDeck()
    addInstance(env.ctx, env.slideId)
    const objCtx = getSlideObjectsCtx(env.ctx, env.slideId)!

    const fillStyle = {
      kind: 'linearGradient' as const,
      stops: [
        { offset: 0, color: 0xff0000 },
        { offset: 1, color: 0x0000ff },
      ],
      angleDeg: 90,
    }
    setLeafOverridePatch(objCtx, 'inst-1', 'leaf-a', { fillStyle })

    const plain = readInstancePlain(env.ctx, env.slideId, 'inst-1')
    expect(plain.overrides?.leaves?.['leaf-a']).toMatchObject({
      fillStyle: { kind: 'linearGradient', angleDeg: 90 },
    })
  })

  it('stores transform via nested Y.Map (additive semantics preserved)', () => {
    const env = makeDeck()
    addInstance(env.ctx, env.slideId)
    const objCtx = getSlideObjectsCtx(env.ctx, env.slideId)!

    setLeafOverridePatch(objCtx, 'inst-1', 'leaf-a', { transform: { x: 10, y: -5 } })

    const plain = readInstancePlain(env.ctx, env.slideId, 'inst-1')
    expect(plain.overrides?.leaves?.['leaf-a']?.transform).toEqual({ x: 10, y: -5 })

    // Confirm it used a Y.Map (not plain JSON) for transform
    const yMap = objCtx.objects.get(0)
    const leaves = (yMap.get('overrides') as Y.Map<unknown>).get('leaves') as Y.Map<unknown>
    const leafMap = leaves.get('leaf-a') as Y.Map<unknown>
    expect(leafMap.get('transform')).toBeInstanceOf(Y.Map)
  })

  it('setLeafOverride still works (delegates to setLeafOverridePatch)', () => {
    const env = makeDeck()
    addInstance(env.ctx, env.slideId)
    const objCtx = getSlideObjectsCtx(env.ctx, env.slideId)!

    setLeafOverride(objCtx, 'inst-1', 'leaf-a', { fill: 0xaabbcc, stroke: 0x112233 })

    const plain = readInstancePlain(env.ctx, env.slideId, 'inst-1')
    expect(plain.overrides?.leaves?.['leaf-a']).toMatchObject({ fill: 0xaabbcc, stroke: 0x112233 })
  })
})

// ---------------------------------------------------------------------------
// seedInstanceTextCopy
// ---------------------------------------------------------------------------

describe('seedInstanceTextCopy', () => {
  it('writes text into overrides.leaves for each master text leaf', () => {
    const env = makeDeck()
    addInstance(env.ctx, env.slideId)
    const objCtx = getSlideObjectsCtx(env.ctx, env.slideId)!

    seedInstanceTextCopy(objCtx, 'inst-1', [
      { id: 'title', text: 'Hello world' },
      { id: 'body', text: 'Body copy' },
    ])

    const plain = readInstancePlain(env.ctx, env.slideId, 'inst-1')
    expect(plain.overrides?.leaves?.['title']?.text).toBe('Hello world')
    expect(plain.overrides?.leaves?.['body']?.text).toBe('Body copy')
  })

  it('is idempotent: does not overwrite an existing text override', () => {
    const env = makeDeck()
    addInstance(env.ctx, env.slideId)
    const objCtx = getSlideObjectsCtx(env.ctx, env.slideId)!

    // First seed
    seedInstanceTextCopy(objCtx, 'inst-1', [{ id: 'title', text: 'Original' }])
    // User edit (simulate by direct setLeafOverridePatch)
    setLeafOverridePatch(objCtx, 'inst-1', 'title', { text: 'User edited' })
    // Second seed — should NOT overwrite user edit
    seedInstanceTextCopy(objCtx, 'inst-1', [{ id: 'title', text: 'Original' }])

    const plain = readInstancePlain(env.ctx, env.slideId, 'inst-1')
    expect(plain.overrides?.leaves?.['title']?.text).toBe('User edited')
  })

  it('no-op when masterTextLeaves is empty', () => {
    const env = makeDeck()
    addInstance(env.ctx, env.slideId)
    const objCtx = getSlideObjectsCtx(env.ctx, env.slideId)!

    seedInstanceTextCopy(objCtx, 'inst-1', [])

    const plain = readInstancePlain(env.ctx, env.slideId, 'inst-1')
    expect(plain.overrides).toBeUndefined()
  })

  it('no-op when instance id does not exist', () => {
    const env = makeDeck()
    addInstance(env.ctx, env.slideId)
    const objCtx = getSlideObjectsCtx(env.ctx, env.slideId)!

    // Should not throw
    seedInstanceTextCopy(objCtx, 'no-such-instance', [{ id: 'x', text: 'hi' }])
  })
})
