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

import { HOCUSPOCUS_URL } from '../lib/endpoints.js'
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { hocuspocusAuthOptions } from './hocuspocusAuth.js'
import { whenProviderSaved } from './providerSaved.js'

/** How long to keep a component doc alive after the last subscriber leaves. */
const LINGER_MS = 30_000

interface CacheEntry {
  componentId: string
  doc: Y.Doc
  provider: HocuspocusProvider
  refCount: number
  /** True once Hocuspocus reports its first sync round-trip. */
  synced: boolean
  /** The server refused the connection (no access, an ended render token) and has not let it in since. */
  refused: boolean
  /** Told when `synced` or `refused` changes (the render page of a master, ComponentRender.tsx). */
  statusListeners: Set<() => void>
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
export function acquireComponentDoc(
  componentId: string,
  opts: {
    /**
     * The page's query string: a `share_token` in it authenticates the
     * connection (the render page of the master's card, agentic A3).
     */
    search?: string
    /** Publish this client in the master's awareness (default true; the render page: false). */
    presence?: boolean
  } = {},
): void {
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
  // Sentinel triggers HocuspocusProvider's auth-frame; server reads the
  // real session from the `narrative_session` cookie on the WS upgrade.
  // See `docs/adr/0005-server-side-session-cookies.md`.
  const provider = new HocuspocusProvider({
    url: HOCUSPOCUS_URL,
    name: `component:${componentId}`,
    document: doc,
    ...hocuspocusAuthOptions(opts.search ?? ''),
    // No awareness: the render worker's browser must not show up as a peer.
    ...(opts.presence === false ? { awareness: null } : {}),
    onAuthenticationFailed() {
      const failed = cache.get(componentId)
      if (failed === undefined) return
      failed.refused = true
      for (const listener of [...failed.statusListeners]) listener()
    },
    // A refusal is over once the server lets the connection in again (a
    // passing failure, e.g. the connection throttle).
    onAuthenticated() {
      const entry = cache.get(componentId)
      if (entry === undefined || !entry.refused) return
      entry.refused = false
      for (const listener of [...entry.statusListeners]) listener()
    },
  })

  const entry: CacheEntry = {
    componentId,
    doc,
    provider,
    refCount: 1,
    synced: false,
    refused: false,
    statusListeners: new Set(),
    listeners: new Set(),
    rafHandle: null,
    lingerTimer: null,
    docObserver: () => {
      scheduleListenerFlush(entry)
    },
    syncedHandler: () => {
      entry.synced = true
      entry.refused = false
      for (const listener of [...entry.statusListeners]) listener()
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

/**
 * Resolves once the server holds every change made to the cached master so
 * far (state/providerSaved.ts); at once when the master is not cached (then
 * nothing local can be pending).
 */
export function whenComponentDocSaved(componentId: string): Promise<void> {
  const entry = cache.get(componentId)
  return entry === undefined ? Promise.resolve() : whenProviderSaved(entry.provider)
}

/** Returns 'synced' once the first server round-trip lands, else 'pending'. */
/** Be told when the master doc's sync status changes (synced, refused); returns the unsubscribe. */
export function subscribeToComponentDocStatus(
  componentId: string,
  listener: () => void,
): () => void {
  const entry = cache.get(componentId)
  if (entry === undefined) return () => undefined
  entry.statusListeners.add(listener)
  return () => {
    entry.statusListeners.delete(listener)
  }
}

export function getComponentDocSyncStatus(componentId: string): 'pending' | 'synced' | 'refused' {
  const entry = cache.get(componentId)
  if (entry === undefined) return 'pending'
  if (entry.refused) return 'refused'
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
