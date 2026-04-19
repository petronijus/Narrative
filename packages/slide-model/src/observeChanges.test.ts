/**
 * observeChanges.test.ts
 *
 * Testy pro subscribeToObjectChanges — incremental diff API s batching.
 *
 * POZNÁMKA: Testy běží v Node.js (bez requestAnimationFrame).
 * Používáme subscribeToObjectChangesWithFlush pro explicitní flush
 * místo čekání na rAF tick.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createSlideDoc } from './yDoc.js'
import { addObject, removeObject, updateObject, type MutationContext } from './mutations.js'
import { subscribeToObjectChangesWithFlush } from './observe.js'
import type { ObjectChangeSet } from './observe.js'
import { registerObjectType, _clearRegistry } from './registry.js'
import type { RectangleObject } from '@narrative/shared'

function makeCtx(): MutationContext {
  const { doc, objects } = createSlideDoc()
  return { doc, objects }
}

const makeRect = (id: string, x = 0, y = 0): RectangleObject => ({
  id,
  type: 'rectangle',
  x,
  y,
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

// ---------------------------------------------------------------------------
// Initial emission
// ---------------------------------------------------------------------------

describe('initial emission', () => {
  it('emituje synchronně při subscribe — prázdný doc', () => {
    const ctx = makeCtx()
    const cb = vi.fn<(changes: ObjectChangeSet) => void>()

    const { unsubscribe } = subscribeToObjectChangesWithFlush(ctx, cb)

    expect(cb).toHaveBeenCalledOnce()
    const call = cb.mock.calls[0]![0]
    expect(call.added).toHaveLength(0)
    expect(call.removed).toHaveLength(0)
    expect(call.updated).toHaveLength(0)
    expect(call.snapshot).toHaveLength(0)

    unsubscribe()
  })

  it('initial emission obsahuje všechny existující objekty jako added', () => {
    const ctx = makeCtx()
    addObject(ctx, makeRect('r1'))
    addObject(ctx, makeRect('r2', 50, 50))

    const cb = vi.fn<(changes: ObjectChangeSet) => void>()
    const { unsubscribe } = subscribeToObjectChangesWithFlush(ctx, cb)

    expect(cb).toHaveBeenCalledOnce()
    const call = cb.mock.calls[0]![0]
    expect(call.added).toHaveLength(2)
    expect(call.removed).toHaveLength(0)
    expect(call.updated).toHaveLength(0)
    expect(call.snapshot).toHaveLength(2)
    expect(call.added.map((o) => o.id)).toContain('r1')
    expect(call.added.map((o) => o.id)).toContain('r2')

    unsubscribe()
  })
})

// ---------------------------------------------------------------------------
// Single add
// ---------------------------------------------------------------------------

describe('single add', () => {
  it('flush po add emituje added: [obj]', () => {
    const ctx = makeCtx()
    const cb = vi.fn<(changes: ObjectChangeSet) => void>()
    const { unsubscribe, flush } = subscribeToObjectChangesWithFlush(ctx, cb)
    cb.mockClear()

    addObject(ctx, makeRect('r1'))
    flush()

    expect(cb).toHaveBeenCalledOnce()
    const call = cb.mock.calls[0]![0]
    expect(call.added).toHaveLength(1)
    expect(call.added[0]!.id).toBe('r1')
    expect(call.removed).toHaveLength(0)
    expect(call.updated).toHaveLength(0)
    expect(call.snapshot).toHaveLength(1)

    unsubscribe()
  })
})

// ---------------------------------------------------------------------------
// Single remove
// ---------------------------------------------------------------------------

describe('single remove', () => {
  it('flush po remove emituje removed: [id]', () => {
    const ctx = makeCtx()
    addObject(ctx, makeRect('r1'))

    const cb = vi.fn<(changes: ObjectChangeSet) => void>()
    const { unsubscribe, flush } = subscribeToObjectChangesWithFlush(ctx, cb)
    cb.mockClear()

    removeObject(ctx, 'r1')
    flush()

    expect(cb).toHaveBeenCalledOnce()
    const call = cb.mock.calls[0]![0]
    expect(call.removed).toHaveLength(1)
    expect(call.removed[0]).toBe('r1')
    expect(call.added).toHaveLength(0)
    expect(call.updated).toHaveLength(0)
    expect(call.snapshot).toHaveLength(0)

    unsubscribe()
  })
})

// ---------------------------------------------------------------------------
// Single update
// ---------------------------------------------------------------------------

describe('single update', () => {
  it('flush po update x, y emituje updated: [{ id, patch: { x, y } }]', () => {
    const ctx = makeCtx()
    addObject(ctx, makeRect('r1'))

    const cb = vi.fn<(changes: ObjectChangeSet) => void>()
    const { unsubscribe, flush } = subscribeToObjectChangesWithFlush(ctx, cb)
    cb.mockClear()

    updateObject<RectangleObject>(ctx, 'r1', { x: 42, y: 77 })
    flush()

    expect(cb).toHaveBeenCalledOnce()
    const call = cb.mock.calls[0]![0]
    expect(call.updated).toHaveLength(1)
    expect(call.updated[0]!.id).toBe('r1')
    expect(call.updated[0]!.patch).toMatchObject({ x: 42, y: 77 })
    expect(call.added).toHaveLength(0)
    expect(call.removed).toHaveLength(0)
    // snapshot obsahuje aktualizovaný objekt
    expect(call.snapshot[0]).toMatchObject({ id: 'r1', x: 42, y: 77 })

    unsubscribe()
  })
})

// ---------------------------------------------------------------------------
// Coalescing updates
// ---------------------------------------------------------------------------

describe('coalescing updates', () => {
  it('dva updates na stejný objekt ve stejném frame → jeden updated entry se sloučeným patchem', () => {
    const ctx = makeCtx()
    addObject(ctx, makeRect('r1'))

    const cb = vi.fn<(changes: ObjectChangeSet) => void>()
    const { unsubscribe, flush } = subscribeToObjectChangesWithFlush(ctx, cb)
    cb.mockClear()

    // Dva updates bez flush mezi nimi — akumulují se v pending batch
    updateObject<RectangleObject>(ctx, 'r1', { x: 10 })
    updateObject<RectangleObject>(ctx, 'r1', { y: 20 })
    flush()

    expect(cb).toHaveBeenCalledOnce()
    const call = cb.mock.calls[0]![0]
    // Jeden entry pro r1
    expect(call.updated).toHaveLength(1)
    expect(call.updated[0]!.id).toBe('r1')
    // Patch obsahuje oba changes sloučené
    expect(call.updated[0]!.patch).toMatchObject({ x: 10, y: 20 })

    unsubscribe()
  })

  it('update různých objektů → dva updated entries', () => {
    const ctx = makeCtx()
    addObject(ctx, makeRect('r1'))
    addObject(ctx, makeRect('r2'))

    const cb = vi.fn<(changes: ObjectChangeSet) => void>()
    const { unsubscribe, flush } = subscribeToObjectChangesWithFlush(ctx, cb)
    cb.mockClear()

    updateObject<RectangleObject>(ctx, 'r1', { x: 10 })
    updateObject<RectangleObject>(ctx, 'r2', { x: 20 })
    flush()

    expect(cb).toHaveBeenCalledOnce()
    const call = cb.mock.calls[0]![0]
    expect(call.updated).toHaveLength(2)

    unsubscribe()
  })
})

// ---------------------------------------------------------------------------
// Net-zero (add + remove stejného ID ve stejném frame)
// ---------------------------------------------------------------------------

describe('net-zero: add + remove stejného ID ve stejném frame', () => {
  it('add + remove stejného ID → žádná emise', () => {
    const ctx = makeCtx()
    const cb = vi.fn<(changes: ObjectChangeSet) => void>()
    const { unsubscribe, flush } = subscribeToObjectChangesWithFlush(ctx, cb)
    cb.mockClear()

    addObject(ctx, makeRect('r1'))
    removeObject(ctx, 'r1')
    flush()

    // Žádná emise — net-zero
    expect(cb).not.toHaveBeenCalled()

    unsubscribe()
  })
})

// ---------------------------------------------------------------------------
// Multiple rAF ticks
// ---------------------------------------------------------------------------

describe('multiple flush ticks', () => {
  it('60 updatů ve 2 flush tickách → 2 emise', () => {
    const ctx = makeCtx()
    addObject(ctx, makeRect('r1'))

    const cb = vi.fn<(changes: ObjectChangeSet) => void>()
    const { unsubscribe, flush } = subscribeToObjectChangesWithFlush(ctx, cb)
    cb.mockClear()

    // Tick 1: 30 updatů na x
    for (let i = 0; i < 30; i++) {
      updateObject<RectangleObject>(ctx, 'r1', { x: i })
    }
    flush()

    // Tick 2: dalších 30 updatů na y
    for (let i = 0; i < 30; i++) {
      updateObject<RectangleObject>(ctx, 'r1', { y: i })
    }
    flush()

    // Dvě emise (jedna per flush tick)
    expect(cb).toHaveBeenCalledTimes(2)

    // První emise: aktualizovaný x
    const call1 = cb.mock.calls[0]![0]
    expect(call1.updated).toHaveLength(1)
    expect(call1.updated[0]!.patch).toHaveProperty('x')

    // Druhá emise: aktualizovaný y
    const call2 = cb.mock.calls[1]![0]
    expect(call2.updated).toHaveLength(1)
    expect(call2.updated[0]!.patch).toHaveProperty('y')

    unsubscribe()
  })
})

// ---------------------------------------------------------------------------
// Unsubscribe
// ---------------------------------------------------------------------------

describe('unsubscribe', () => {
  it('unsubscribe zastaví emise — flush po unsubscribe neemituje', () => {
    const ctx = makeCtx()
    const cb = vi.fn<(changes: ObjectChangeSet) => void>()
    const { unsubscribe, flush } = subscribeToObjectChangesWithFlush(ctx, cb)
    cb.mockClear()

    addObject(ctx, makeRect('r1'))
    // Unsubscribnu PŘED flush
    unsubscribe()
    flush()

    expect(cb).not.toHaveBeenCalled()
  })

  it('unsubscribe zastaví callback na Yjs events', () => {
    const ctx = makeCtx()
    const cb = vi.fn<(changes: ObjectChangeSet) => void>()
    const { unsubscribe, flush } = subscribeToObjectChangesWithFlush(ctx, cb)
    cb.mockClear()

    unsubscribe()
    addObject(ctx, makeRect('r1'))
    flush()

    expect(cb).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Flush je synchronní
// ---------------------------------------------------------------------------

describe('flush synchronicity', () => {
  it('flush() vyvolá callback synchronně (ne async)', () => {
    const ctx = makeCtx()
    let called = false
    const { unsubscribe, flush } = subscribeToObjectChangesWithFlush(ctx, () => {
      called = true
    })

    // Vynuluj initial call
    called = false

    addObject(ctx, makeRect('r1'))
    expect(called).toBe(false) // bez flush ještě nebyla emise

    flush()
    expect(called).toBe(true) // flush je synchronní

    unsubscribe()
  })
})

// ---------------------------------------------------------------------------
// Snapshot konzistence
// ---------------------------------------------------------------------------

describe('snapshot consistency', () => {
  it('snapshot po add → obsahuje objekt', () => {
    const ctx = makeCtx()
    const cb = vi.fn<(changes: ObjectChangeSet) => void>()
    const { unsubscribe, flush } = subscribeToObjectChangesWithFlush(ctx, cb)
    cb.mockClear()

    addObject(ctx, makeRect('r1', 10, 20))
    flush()

    const snapshot = cb.mock.calls[0]![0].snapshot
    expect(snapshot).toHaveLength(1)
    expect(snapshot[0]).toMatchObject({ id: 'r1', x: 10, y: 20 })

    unsubscribe()
  })

  it('snapshot po remove → neobsahuje odebraný objekt', () => {
    const ctx = makeCtx()
    addObject(ctx, makeRect('r1'))
    addObject(ctx, makeRect('r2'))

    const cb = vi.fn<(changes: ObjectChangeSet) => void>()
    const { unsubscribe, flush } = subscribeToObjectChangesWithFlush(ctx, cb)
    cb.mockClear()

    removeObject(ctx, 'r1')
    flush()

    const snapshot = cb.mock.calls[0]![0].snapshot
    expect(snapshot).toHaveLength(1)
    expect(snapshot[0]!.id).toBe('r2')

    unsubscribe()
  })

  it('snapshot reflektuje kumulativní state přes více flush ticků', () => {
    const ctx = makeCtx()
    const cb = vi.fn<(changes: ObjectChangeSet) => void>()
    const { unsubscribe, flush } = subscribeToObjectChangesWithFlush(ctx, cb)
    cb.mockClear()

    addObject(ctx, makeRect('r1'))
    flush()
    expect(cb.mock.calls[0]![0].snapshot).toHaveLength(1)

    addObject(ctx, makeRect('r2'))
    flush()
    expect(cb.mock.calls[1]![0].snapshot).toHaveLength(2)

    removeObject(ctx, 'r1')
    flush()
    expect(cb.mock.calls[2]![0].snapshot).toHaveLength(1)
    expect(cb.mock.calls[2]![0].snapshot[0]!.id).toBe('r2')

    unsubscribe()
  })
})

// ---------------------------------------------------------------------------
// Prázdný flush neemituje
// ---------------------------------------------------------------------------

describe('empty flush', () => {
  it('flush bez pending changes neemituje callback', () => {
    const ctx = makeCtx()
    const cb = vi.fn<(changes: ObjectChangeSet) => void>()
    const { unsubscribe, flush } = subscribeToObjectChangesWithFlush(ctx, cb)
    cb.mockClear()

    // Žádná mutace — prázdný flush
    flush()

    expect(cb).not.toHaveBeenCalled()

    unsubscribe()
  })
})
