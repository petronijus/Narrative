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
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { hocuspocusAuthOptions } from './hocuspocusAuth.js'
import { whenProviderReadySaved, whenProviderSaved } from './providerSaved.js'
import { localCopyUserFor, openDocumentCopy, type DocumentCopy } from './localDocCopy.js'

/** How long to keep a component doc alive after the last subscriber leaves. */
const LINGER_MS = 30_000

interface CacheEntry {
  componentId: string
  /** How the entry was opened, for a rebuild (ADR 0017). */
  opts: AcquireOptions
  doc: Y.Doc
  /** Null until the local copy, if any, is in the document (state/localDocCopy.ts). */
  provider: HocuspocusProvider | null
  /** Opened at once; the provider joins it (ADR 0017: overlaps the copy's read). */
  socket: HocuspocusProviderWebsocket
  /** Resolves with the provider once it exists. */
  providerReady: Promise<HocuspocusProvider>
  copy: DocumentCopy
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
interface AcquireOptions {
  /**
   * The page's query string: a `share_token` in it authenticates the
   * connection (the render page of the master's card, agentic A3).
   */
  search?: string
  /** Publish this client in the master's awareness (default true; the render page: false). */
  presence?: boolean
}

export function acquireComponentDoc(componentId: string, opts: AcquireOptions = {}): void {
  const existing = cache.get(componentId)
  if (existing !== undefined) {
    existing.refCount += 1
    if (existing.lingerTimer !== null) {
      window.clearTimeout(existing.lingerTimer)
      existing.lingerTimer = null
    }
    return
  }

  const opened = openEntryDoc(componentId, opts, () => entry)
  const entry: CacheEntry = {
    componentId,
    opts,
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
      tellStatus(entry)
      // First sync delivers the initial state — fire listeners so the
      // renderer re-extracts a fresh snapshot from the freshly-populated doc.
      scheduleListenerFlush(entry)
    },
    doc: opened.doc,
    copy: opened.copy,
    socket: opened.socket,
    provider: null,
    providerReady: opened.providerReady,
  }
  cache.set(componentId, entry)
  opened.start()
}

function tellStatus(entry: CacheEntry): void {
  for (const listener of [...entry.statusListeners]) listener()
}

/** The parts of an entry that belong to one document and its connection. */
interface EntryDoc extends Pick<CacheEntry, 'doc' | 'copy' | 'socket' | 'providerReady'> {
  /** Connect, once the parts are the entry's (now, or after the local copy is read). */
  start(): void
}

/**
 * A new document and its connection for a cache entry — on acquire, and
 * again when the server refused what the document held (ADR 0017: a stale
 * epoch, or a refused master showing its local copy), after which
 * subscribers are told and read the new document through `getComponentDoc`.
 * `entryOf` is called only from callbacks and `start`, once the entry holds
 * these parts.
 */
function openEntryDoc(
  componentId: string,
  opts: AcquireOptions,
  entryOf: () => CacheEntry,
): EntryDoc {
  const documentName = `component:${componentId}`
  const doc = new Y.Doc()
  bumpDebugCounter(1)
  /** This document is still the entry's (not rebuilt, not destroyed). */
  const current = (): boolean => cache.get(componentId) === entryOf() && entryOf().doc === doc
  const copy = openDocumentCopy({
    doc,
    documentName,
    // The render page (a render token in `search`) keeps no copy.
    user: localCopyUserFor(opts.search ?? ''),
    onRebuild: () => {
      if (!current()) return
      const entry = entryOf()
      closeEntryDoc(entry)
      entry.synced = false
      entry.refused = false
      const next = openEntryDoc(componentId, opts, entryOf)
      entry.doc = next.doc
      entry.copy = next.copy
      entry.socket = next.socket
      entry.provider = null
      entry.providerReady = next.providerReady
      next.start()
      tellStatus(entry)
      scheduleListenerFlush(entry)
    },
  })
  let resolveProvider: (p: HocuspocusProvider) => void = () => undefined
  const providerReady = new Promise<HocuspocusProvider>((resolve) => {
    resolveProvider = resolve
  })
  // The socket opens now, while a local copy is read; the provider joins it.
  const socket = new HocuspocusProviderWebsocket({
    url: hocuspocusAuthOptions(HOCUSPOCUS_URL, opts.search ?? '').url,
  })
  // The local copy, when there is one, reaches subscribers like a sync does.
  // (No update can arrive before the entry exists: the first comes from the
  // copy, after `ready`, or from the provider.)
  const onUpdate = (): void => entryOf().docObserver()
  doc.on('update', onUpdate)
  doc.on('destroy', () => doc.off('update', onUpdate))

  const start = (): void =>
    copy.whenReady(() => {
      if (!current()) return
      const entry = entryOf()
      // Sentinel triggers HocuspocusProvider's auth-frame; server reads the
      // real session from the `narrative_session` cookie on the WS upgrade.
      // See `docs/adr/0005-server-side-session-cookies.md`.
      const provider = new HocuspocusProvider({
        name: documentName,
        document: doc,
        websocketProvider: socket,
        // Claims the epoch of what the document holds (ADR 0017, point 4).
        token: copy.token,
        // No awareness: the render worker's browser must not show up as a peer.
        ...(opts.presence === false ? { awareness: null } : {}),
        onAuthenticationFailed({ reason }: { reason: string }) {
          if (copy.rebuildsOn(reason) || !current()) return
          entry.refused = true
          tellStatus(entry)
        },
        // A refusal is over once the server lets the connection in again (a
        // passing failure, e.g. the connection throttle).
        onAuthenticated() {
          if (!current() || !entry.refused) return
          entry.refused = false
          tellStatus(entry)
        },
      })
      provider.on('synced', entry.syncedHandler)
      copy.attach(provider)
      provider.attach()
      entry.provider = provider
      resolveProvider(provider)
    })
  return { doc, copy, socket, providerReady, start }
}

/** Close the entry's copy, connection and document (the entry itself stays). */
function closeEntryDoc(entry: CacheEntry): void {
  entry.copy.close()
  const provider = entry.provider
  if (provider !== null) {
    try {
      provider.off('synced', entry.syncedHandler)
    } catch {
      // Hocuspocus emits don't always have a stable off() — ignore.
    }
    try {
      provider.destroy()
    } catch {
      // ignore
    }
  }
  entry.provider = null
  try {
    entry.socket.destroy()
  } catch {
    // ignore
  }
  try {
    entry.doc.destroy()
  } catch {
    // ignore
  }
  bumpDebugCounter(-1)
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
  if (entry === undefined) return Promise.resolve()
  return entry.provider !== null
    ? whenProviderSaved(entry.provider)
    : whenProviderReadySaved(entry.providerReady)
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
  closeEntryDoc(entry)
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
