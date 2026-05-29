/**
 * state/componentDocCache.test.ts
 *
 * M16 P6 — Unit tests for the component-doc connection cache.
 *
 * HocuspocusProvider is mocked: tests must not open real WS sockets. The
 * mock surfaces a `synced` event hook so we can simulate the first-sync
 * round-trip explicitly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Track every mocked provider instance so tests can drive `synced` and
// inspect destroy().
interface MockProvider {
  destroyed: boolean
  listeners: Map<string, Set<() => void>>
  emit(event: string): void
  destroy(): void
  on(event: string, cb: () => void): void
  off(event: string, cb: () => void): void
}

const { providers } = vi.hoisted(() => {
  const providers: MockProvider[] = []
  return { providers }
})

vi.mock('@hocuspocus/provider', () => {
  class MockHocuspocusProvider {
    destroyed = false
    listeners = new Map<string, Set<() => void>>()
    on(event: string, cb: () => void) {
      let set = this.listeners.get(event)
      if (set === undefined) {
        set = new Set()
        this.listeners.set(event, set)
      }
      set.add(cb)
    }
    off(event: string, cb: () => void) {
      this.listeners.get(event)?.delete(cb)
    }
    emit(event: string) {
      const set = this.listeners.get(event)
      if (set === undefined) return
      for (const cb of set) cb()
    }
    destroy() {
      this.destroyed = true
    }
    constructor() {
      providers.push(this as unknown as MockProvider)
    }
  }
  return { HocuspocusProvider: MockHocuspocusProvider }
})

import {
  acquireComponentDoc,
  releaseComponentDoc,
  getComponentDoc,
  getComponentDocSyncStatus,
  subscribeToComponentDoc,
  disposeComponentDocCache,
  __getComponentDocCacheSizeForTests,
  __getComponentDocRefCountForTests,
  __flushComponentDocListenersForTests,
} from './componentDocCache'

beforeEach(() => {
  providers.length = 0
  vi.useFakeTimers()
})

afterEach(() => {
  disposeComponentDocCache()
  vi.useRealTimers()
})

describe('componentDocCache', () => {
  it('opens exactly one provider for repeated acquires of the same id', () => {
    acquireComponentDoc('a')
    acquireComponentDoc('a')
    acquireComponentDoc('a')
    expect(providers).toHaveLength(1)
    expect(__getComponentDocRefCountForTests('a')).toBe(3)
  })

  it('release×N matching acquire×N triggers linger then destroy after 30s', () => {
    acquireComponentDoc('a')
    acquireComponentDoc('a')
    acquireComponentDoc('a')

    releaseComponentDoc('a')
    releaseComponentDoc('a')
    expect(__getComponentDocRefCountForTests('a')).toBe(1)
    expect(providers[0]!.destroyed).toBe(false)

    releaseComponentDoc('a')
    expect(__getComponentDocRefCountForTests('a')).toBe(0)
    // Linger window: still alive immediately.
    expect(providers[0]!.destroyed).toBe(false)
    expect(__getComponentDocCacheSizeForTests()).toBe(1)

    // 29s — still alive.
    vi.advanceTimersByTime(29_000)
    expect(providers[0]!.destroyed).toBe(false)

    // 30s — destroyed.
    vi.advanceTimersByTime(2_000)
    expect(providers[0]!.destroyed).toBe(true)
    expect(__getComponentDocCacheSizeForTests()).toBe(0)
  })

  it('acquire during linger cancels the destroy timer', () => {
    acquireComponentDoc('a')
    releaseComponentDoc('a')
    expect(__getComponentDocRefCountForTests('a')).toBe(0)

    vi.advanceTimersByTime(10_000)
    acquireComponentDoc('a')
    expect(__getComponentDocRefCountForTests('a')).toBe(1)

    vi.advanceTimersByTime(60_000)
    expect(providers[0]!.destroyed).toBe(false)
    expect(__getComponentDocCacheSizeForTests()).toBe(1)
  })

  it('getComponentDoc returns the live Y.Doc for cached entries, null otherwise', () => {
    expect(getComponentDoc('missing')).toBeNull()
    acquireComponentDoc('a')
    expect(getComponentDoc('a')).not.toBeNull()
  })

  it('subscribeToComponentDoc fires after the synced event', () => {
    acquireComponentDoc('a')
    expect(getComponentDocSyncStatus('a')).toBe('pending')

    const listener = vi.fn()
    subscribeToComponentDoc('a', listener)

    providers[0]!.emit('synced')
    expect(getComponentDocSyncStatus('a')).toBe('synced')

    __flushComponentDocListenersForTests('a')
    expect(listener).toHaveBeenCalled()
  })

  it('unsubscribing prevents further callbacks', () => {
    acquireComponentDoc('a')
    const listener = vi.fn()
    const unsubscribe = subscribeToComponentDoc('a', listener)
    unsubscribe()

    providers[0]!.emit('synced')
    __flushComponentDocListenersForTests('a')
    expect(listener).not.toHaveBeenCalled()
  })

  it('disposeComponentDocCache destroys every entry regardless of refcount', () => {
    acquireComponentDoc('a')
    acquireComponentDoc('b')
    expect(__getComponentDocCacheSizeForTests()).toBe(2)

    disposeComponentDocCache()
    expect(__getComponentDocCacheSizeForTests()).toBe(0)
    for (const p of providers) expect(p.destroyed).toBe(true)
  })
})
