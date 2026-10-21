/**
 * state/providerSaved.test.ts — `whenProviderSaved` waits for the sync
 * server to acknowledge every local update (the provider's
 * `hasUnsyncedChanges`), and gives up after its timeout.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import { whenProviderReadySaved, whenProviderSaved } from './providerSaved.js'

/** The slice of a provider `whenProviderSaved` reads, with its events. */
function fakeProvider(state: { synced: boolean; unsynced: number }) {
  const handlers = new Map<string, Set<() => void>>()
  const provider = {
    get synced() {
      return state.synced
    },
    get hasUnsyncedChanges() {
      return state.unsynced > 0
    },
    on(event: string, fn: () => void) {
      if (!handlers.has(event)) handlers.set(event, new Set())
      handlers.get(event)!.add(fn)
    },
    off(event: string, fn: () => void) {
      handlers.get(event)?.delete(fn)
    },
  }
  const emit = (event: string) => handlers.get(event)?.forEach((fn) => fn())
  const listeners = () => [...handlers.values()].reduce((n, set) => n + set.size, 0)
  return { provider: provider as unknown as HocuspocusProvider, emit, listeners }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('whenProviderSaved', () => {
  it('resolves at once when nothing is pending', async () => {
    const { provider, listeners } = fakeProvider({ synced: true, unsynced: 0 })
    await expect(whenProviderSaved(provider)).resolves.toBeUndefined()
    expect(listeners()).toBe(0)
  })

  it('waits for the last acknowledgement, then stops listening', async () => {
    const state = { synced: true, unsynced: 2 }
    const { provider, emit, listeners } = fakeProvider(state)
    let done = false
    const saved = whenProviderSaved(provider).then(() => (done = true))

    state.unsynced = 1
    emit('unsyncedChanges')
    await Promise.resolve()
    expect(done).toBe(false)

    state.unsynced = 0
    emit('unsyncedChanges')
    await saved
    expect(done).toBe(true)
    expect(listeners()).toBe(0)
  })

  it('waits for the first sync as well', async () => {
    const state = { synced: false, unsynced: 0 }
    const { provider, emit } = fakeProvider(state)
    const saved = whenProviderSaved(provider)
    state.synced = true
    emit('synced')
    await expect(saved).resolves.toBeUndefined()
  })

  it('gives up after the timeout', async () => {
    vi.useFakeTimers()
    const { provider, listeners } = fakeProvider({ synced: true, unsynced: 1 })
    const saved = whenProviderSaved(provider, 1_000)
    vi.advanceTimersByTime(1_000)
    await expect(saved).rejects.toThrow('has not confirmed')
    expect(listeners()).toBe(0)
  })
})

describe('whenProviderReadySaved', () => {
  it('waits for the provider, then for its acknowledgements', async () => {
    vi.useFakeTimers()
    const state = { synced: true, unsynced: 1 }
    const { provider, emit } = fakeProvider(state)
    let resolveReady: (p: HocuspocusProvider) => void = () => undefined
    const ready = new Promise<HocuspocusProvider>((r) => (resolveReady = r))
    let saved = false
    const waiting = whenProviderReadySaved(ready, 1000).then(() => (saved = true))
    await vi.advanceTimersByTimeAsync(300)
    resolveReady(provider)
    await vi.advanceTimersByTimeAsync(0)
    expect(saved).toBe(false)
    state.unsynced = 0
    emit('unsyncedChanges')
    await waiting
    expect(saved).toBe(true)
  })

  it('gives up when the provider never comes (the document closed while its copy was read)', async () => {
    vi.useFakeTimers()
    const waiting = whenProviderReadySaved(new Promise<HocuspocusProvider>(() => undefined), 1000)
    const outcome = waiting.then(
      () => 'saved',
      () => 'rejected',
    )
    await vi.advanceTimersByTimeAsync(1000)
    expect(await outcome).toBe('rejected')
  })
})
