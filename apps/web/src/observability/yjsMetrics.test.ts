/**
 * observability/yjsMetrics.test.ts
 *
 * Unit testy pro Yjs metrics tracker.
 * Mock Y.Doc events a HocuspocusProvider.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as Y from 'yjs'
import { createYjsMetrics } from './yjsMetrics.js'

// Minimální mock pro HocuspocusProvider
function createMockProvider() {
  const awarenessListeners = new Map<string, Array<() => void>>()

  const mockAwareness = {
    on(event: string, cb: () => void) {
      if (!awarenessListeners.has(event)) {
        awarenessListeners.set(event, [])
      }
      awarenessListeners.get(event)!.push(cb)
    },
    off(event: string, cb: () => void) {
      const listeners = awarenessListeners.get(event) ?? []
      const idx = listeners.indexOf(cb)
      if (idx !== -1) listeners.splice(idx, 1)
    },
    emit(event: string) {
      for (const cb of awarenessListeners.get(event) ?? []) {
        cb()
      }
    },
  }

  return {
    awareness: mockAwareness,
    _emitAwareness() {
      mockAwareness.emit('change')
    },
  }
}

describe('createYjsMetrics', () => {
  let doc: Y.Doc
  let provider: ReturnType<typeof createMockProvider>

  beforeEach(() => {
    doc = new Y.Doc()
    provider = createMockProvider()
  })

  it('vrátí nulové metriky při inicializaci', () => {
    const tracker = createYjsMetrics(doc, provider as never)
    const stats = tracker.stats()

    expect(stats.updatesReceived).toBe(0)
    expect(stats.updatesSent).toBe(0)
    expect(stats.bytesReceived).toBe(0)
    expect(stats.bytesSent).toBe(0)
    expect(stats.awarenessChanges).toBe(0)

    tracker.destroy()
    doc.destroy()
  })

  it('inkrement updatesSent pro lokální update (origin=null)', () => {
    const tracker = createYjsMetrics(doc, provider as never)

    // Lokální mutace bez origin → updatesSent++
    doc.transact(() => {
      doc.getArray('objects').push([new Y.Map()])
    })

    const stats = tracker.stats()
    expect(stats.updatesSent).toBe(1)
    expect(stats.bytesSent).toBeGreaterThan(0)
    expect(stats.updatesReceived).toBe(0)

    tracker.destroy()
    doc.destroy()
  })

  it('inkrement updatesReceived pro remote update (origin=non-null)', () => {
    const tracker = createYjsMetrics(doc, provider as never)

    // Simuluj remote update: aplikuj update s non-null origin
    const remoteDoc = new Y.Doc()
    remoteDoc.getArray('objects').push([new Y.Map()])
    const update = Y.encodeStateAsUpdate(remoteDoc)

    // Aplikuj s 'server' origin → updatesReceived++
    Y.applyUpdate(doc, update, 'server')

    const stats = tracker.stats()
    expect(stats.updatesReceived).toBe(1)
    expect(stats.bytesReceived).toBeGreaterThan(0)
    expect(stats.updatesSent).toBe(0)

    tracker.destroy()
    doc.destroy()
    remoteDoc.destroy()
  })

  it('inkrement awarenessChanges při awareness události', () => {
    const tracker = createYjsMetrics(doc, provider as never)

    provider._emitAwareness()
    provider._emitAwareness()
    provider._emitAwareness()

    const stats = tracker.stats()
    expect(stats.awarenessChanges).toBe(3)

    tracker.destroy()
    doc.destroy()
  })

  it('destroy odregistruje všechny listenery', () => {
    const offSpy = vi.spyOn(provider.awareness, 'off')
    const tracker = createYjsMetrics(doc, provider as never)

    tracker.destroy()

    expect(offSpy).toHaveBeenCalledWith('change', expect.any(Function))

    // Po destroy — awareness event nesmí inkrementovat counter
    provider._emitAwareness()
    const stats = tracker.stats()
    expect(stats.awarenessChanges).toBe(0)

    doc.destroy()
  })

  it('stats() je idempotentní — vícenásobné volání vrátí stejná data', () => {
    const tracker = createYjsMetrics(doc, provider as never)

    doc.transact(() => {
      doc.getArray('objects').push([new Y.Map()])
    })

    const s1 = tracker.stats()
    const s2 = tracker.stats()

    expect(s1).toEqual(s2)

    tracker.destroy()
    doc.destroy()
  })
})
