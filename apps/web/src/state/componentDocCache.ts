/**
 * state/componentDocCache.ts
 *
 * M16 P6 — Module-level singleton cache for component master Y.Docs.
 *
 * Why a cache (not one provider per mount):
 *   A single slide can carry many ComponentInstance nodes pointing at the
 *   same `component:<id>` master. Opening one Hocuspocus WebSocket per
 *   instance would fan out into N parallel connections to the same doc and
 *   waste both server sockets and client memory.
 *
 *   The cache opens at most ONE WS per componentId regardless of how many
 *   subscribers (renderer nodes, override editors, future overlays) hold
 *   references. Subscribers `acquire()` on mount and `release()` on unmount;
 *   ref-count drops to zero → connection is scheduled for destruction after
 *   a 30 s linger window so common navigation patterns (slide switch,
 *   editor → present round-trip, scene-graph remount) reuse the live doc
 *   instead of paying another sync RTT.
 *
 * Linger choice (30 s):
 *   - Slide switch in the editor remounts the entire scene-graph; we don't
 *     want to re-open every WS for components present on both slides.
 *   - 30 s comfortably covers human navigation; longer would pin idle docs
 *     in memory; shorter would defeat the purpose for slow networks.
 *
 * Cleanup contract:
 *   `disposeComponentDocCache()` is called from Canvas.tsx on full editor
 *   unmount. It cancels all linger timers and destroys every still-cached
 *   provider+doc pair regardless of ref-count. After that the module is
 *   reusable for the next mount (the cache map is cleared).
 *
 * This module is the SOLE Yjs entry-point for the renderer. No Pixi imports
 * here; no Yjs mutation APIs called either — readers only.
 */

import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'

const HOCUSPOCUS_URL = import.meta.env['VITE_HOCUSPOCUS_URL'] ?? 'ws://localhost:3002'

/** How long to keep a component doc alive after the last subscriber leaves. */
const LINGER_MS = 30_000

interface CacheEntry {
  componentId: string
  doc: Y.Doc
  provider: HocuspocusProvider
  refCount: number
  /** True once Hocuspocus reports its first sync round-trip. */
  synced: boolean
  /** Subscribers to master-doc mutations (rAF-debounced). */
  listeners: Set<() => void>
  /** Pending rAF id for the listener flush — null when no flush is queued. */
  rafHandle: number | null
  /** Timer that destroys the entry when ref count is zero. */
  lingerTimer: number | null
  /** Y.Doc 'update' observer — kept so we can unregister on destroy. */
  docObserver: () => void
  /** Provider 'synced' handler — kept for unregister. */
  syncedHandler: () => void
}

const cache = new Map<string, CacheEntry>()

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Acquire a reference to the component master doc. Opens the WS connection
 * on first call; otherwise bumps ref count. Cancels any pending linger
 * destroy if one was scheduled.
 */
export function acquireComponentDoc(componentId: string): void {
  const existing = cache.get(componentId)
  if (existing !== undefined) {
    existing.refCount += 1
    if (existing.lingerTimer !== null) {
      window.clearTimeout(existing.lingerTimer)
      existing.lingerTimer = null
    }
    return
  }

  const doc = new Y.Doc()
  bumpDebugCounter(1)
  // 2026-05: auth carried by the narrative_session HttpOnly cookie on the
  // WS upgrade. No `token` arg needed.
  const provider = new HocuspocusProvider({
    url: HOCUSPOCUS_URL,
    name: `component:${componentId}`,
    document: doc,
  })

  const entry: CacheEntry = {
    componentId,
    doc,
    provider,
    refCount: 1,
    synced: false,
    listeners: new Set(),
    rafHandle: null,
    lingerTimer: null,
    docObserver: () => {
      scheduleListenerFlush(entry)
    },
    syncedHandler: () => {
      entry.synced = true
      // First sync delivers the initial state — fire listeners so the
      // renderer re-extracts a fresh snapshot from the freshly-populated doc.
      scheduleListenerFlush(entry)
    },
  }

  doc.on('update', entry.docObserver)
  provider.on('synced', entry.syncedHandler)

  cache.set(componentId, entry)
}

/**
 * Drop a reference. When the ref count hits zero the connection is kept
 * alive for `LINGER_MS` so tab switches don't churn the WS.
 */
export function releaseComponentDoc(componentId: string): void {
  const entry = cache.get(componentId)
  if (entry === undefined) return
  entry.refCount = Math.max(0, entry.refCount - 1)
  if (entry.refCount > 0) return

  if (entry.lingerTimer !== null) return // Already scheduled.
  entry.lingerTimer = window.setTimeout(() => {
    // Race: a new acquire may have arrived after the timer fired but
    // before this callback runs — refCount > 0 means "keep it".
    if (entry.refCount > 0) {
      entry.lingerTimer = null
      return
    }
    destroyEntry(entry)
  }, LINGER_MS)
}

/**
 * Returns the live Y.Doc for a component if cached, else null. The caller
 * must have a matching `acquireComponentDoc` outstanding — otherwise the
 * doc may be torn down at any moment.
 */
export function getComponentDoc(componentId: string): Y.Doc | null {
  return cache.get(componentId)?.doc ?? null
}

/** Returns 'synced' once the first server round-trip lands, else 'pending'. */
export function getComponentDocSyncStatus(componentId: string): 'pending' | 'synced' {
  const entry = cache.get(componentId)
  if (entry === undefined) return 'pending'
  return entry.synced ? 'synced' : 'pending'
}

/**
 * Subscribe to master doc mutations. The callback is debounced via
 * `requestAnimationFrame`, so a burst of Yjs ops produces a single
 * notification per frame. Returns an unsubscribe.
 */
export function subscribeToComponentDoc(componentId: string, callback: () => void): () => void {
  const entry = cache.get(componentId)
  if (entry === undefined) {
    // Subscribing without acquiring is a programming error. We could throw,
    // but the renderer always pairs acquire+subscribe in the same effect so
    // returning a no-op tear-down keeps callers simple in the rare race
    // where the entry was destroyed between calls.
    return () => {}
  }
  entry.listeners.add(callback)
  return () => {
    entry.listeners.delete(callback)
  }
}

/**
 * Full teardown — called from Canvas.tsx on editor unmount. After this
 * call the cache is empty and any outstanding `getComponentDoc` results
 * are dangling references; callers MUST have already torn down their
 * subscribers before invoking this.
 */
export function disposeComponentDocCache(): void {
  for (const entry of cache.values()) {
    if (entry.lingerTimer !== null) {
      window.clearTimeout(entry.lingerTimer)
      entry.lingerTimer = null
    }
    destroyEntry(entry)
  }
  cache.clear()
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * @internal Used only by tests to force-flush the rAF debouncer so we don't
 * rely on the test runner's rAF polyfill timing.
 */
export function __flushComponentDocListenersForTests(componentId: string): void {
  const entry = cache.get(componentId)
  if (entry === undefined) return
  if (entry.rafHandle !== null) {
    window.cancelAnimationFrame(entry.rafHandle)
    entry.rafHandle = null
  }
  for (const cb of entry.listeners) cb()
}

/** @internal Inspection helper for tests. */
export function __getComponentDocCacheSizeForTests(): number {
  return cache.size
}

/** @internal */
export function __getComponentDocRefCountForTests(componentId: string): number {
  return cache.get(componentId)?.refCount ?? 0
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function scheduleListenerFlush(entry: CacheEntry): void {
  if (entry.rafHandle !== null) return
  entry.rafHandle = window.requestAnimationFrame(() => {
    entry.rafHandle = null
    // Snapshot the listener set: a callback may unsubscribe itself, which
    // mutates the set we're iterating.
    for (const cb of [...entry.listeners]) {
      try {
        cb()
      } catch {
        // Swallow — one buggy listener must not block the rest from learning
        // about the master change. The renderer's own diff path will keep
        // the scene consistent on the next frame.
      }
    }
  })
}

function destroyEntry(entry: CacheEntry): void {
  if (entry.rafHandle !== null) {
    window.cancelAnimationFrame(entry.rafHandle)
    entry.rafHandle = null
  }
  entry.listeners.clear()
  try {
    entry.doc.off('update', entry.docObserver)
  } catch {
    // Already torn down — ignore.
  }
  try {
    entry.provider.off('synced', entry.syncedHandler)
  } catch {
    // Hocuspocus emits don't always have a stable off() — ignore.
  }
  try {
    entry.provider.destroy()
  } catch {
    // ignore
  }
  try {
    entry.doc.destroy()
  } catch {
    // ignore
  }
  bumpDebugCounter(-1)
  cache.delete(entry.componentId)
}

/**
 * Dev-only Y.Doc-instance counter. Exposed at `window.__yjsDocCount` so
 * QA / engineers can assert "no leak" when toggling component editor
 * routes without taking heap snapshots. Production builds skip the
 * shim entirely (the import.meta.env guard is removed by Vite's
 * tree-shake when DEV is false).
 */
function bumpDebugCounter(delta: number): void {
  if (!import.meta.env.DEV) return
  if (typeof window === 'undefined') return
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any
  w.__yjsDocCount = (typeof w.__yjsDocCount === 'number' ? w.__yjsDocCount : 0) + delta
}
