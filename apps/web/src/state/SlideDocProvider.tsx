/**
 * state/SlideDocProvider.tsx
 *
 * React context provider for SlideDoc.
 *
 * M4: Uses HocuspocusProvider for realtime sync over WebSocket.
 * M6: mutationCtx extended with animations Y.Array (SlideMutationContext).
 * M8: Awareness integration — peer cursors, selections, avatar chips.
 * M9: Multi-slide schema restructure.
 *   - hydrateSlideDoc() runs backward-compat migration on load.
 *   - Context now exposes deckCtx ({ doc, slides }) instead of mutationCtx.
 *   - UndoManager tracks the top-level slides Y.Array (deep tracking).
 *   - Per-slide scoped contexts obtained via getSlideObjectsCtx / getSlideAnimationsCtx.
 *
 * M10: Auth integration.
 *   - The WebSocket upgrade carries the `narrative_session` HttpOnly cookie
 *     automatically (same-site with the SPA), so Hocuspocus' onAuthenticate
 *     can resolve the user without a `token` arg from the client.
 *   - share_token from URL query params is passed as a WS URL parameter for
 *     the anonymous viewer path (no session cookie required).
 *   - When BYPASS_AUTH=true on server (dev), missing auth is fine.
 *
 * Lifecycle:
 *   mount   → HocuspocusProvider.connect() (WS handshake, server hydrates Y.Doc)
 *   unmount → HocuspocusProvider.destroy() (cleanup WS + Yjs subscriptions)
 *
 * Connection URL: HOCUSPOCUS_URL (lib/endpoints.ts; env VITE_HOCUSPOCUS_URL)
 * Document name = deckId from props (passed from URL param /deck/:id)
 *
 * M16 P6 — Optional `doc` prop.
 *   When supplied, the provider treats the given Y.Doc as the slide doc and
 *   skips the Hocuspocus connection entirely. This is the contract used by
 *   `<ComponentMasterEditor>` so the master Y.Doc obtained from
 *   `componentDocCache` can drive the same editor stack (Inspector,
 *   selection, undo, ...) without a deckId.
 *
 *   Contract:
 *     - When `doc` is supplied, `deckId` becomes a logical identity used only
 *       for awareness peer-id storage and load-timing keys; no WS opens.
 *     - Awareness is still wired up against a transient HocuspocusProvider
 *       NOT — instead a dummy awareness object is created so consumers that
 *       expect `awareness` keep working (peer-cursor / selection overlays
 *       gracefully degrade with an empty roster).
 *     - The caller owns the doc's lifecycle (acquire/release on the cache).
 *       This provider must NOT destroy the doc on unmount.
 *
 *   The deck path (no `doc` prop) is unchanged.
 */

import { HOCUSPOCUS_URL } from '../lib/endpoints.js'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth } from './AuthContext.js'
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { Awareness } from 'y-protocols/awareness'
import { createUndoManager, generatePeerId, hydrateSlideDoc } from '@narrative/slide-model'
import type { SlideMutationContext } from '@narrative/slide-model'
import { parseAgentPrincipalMessage, perfCount, perfCountersOn } from '@narrative/shared'
import type { PeerAwarenessState, PeerUser } from '@narrative/shared'
import { localPeerUser, restoredLocalState } from './localAwarenessState.js'
import { AgentPrincipalStoreContext, createAgentPrincipalStore } from './agentPrincipal.js'
import { SlideDocContext } from './slideDocContext.js'
import { EditorShowBusContext, createEditorShowBus, parseEditorShowMessage } from './editorShow.js'
import type { SlideDocContextValue, WsStatus } from './slideDocContext.js'
import { markWsConnected, markWsSynced } from './loadTimings.js'
import { whenProviderSaved } from './providerSaved.js'
import { whenComponentDocSaved } from './componentDocCache.js'
import { hocuspocusAuthOptions } from './hocuspocusAuth.js'
import { usePointerUndoGestures } from './undoGestures.js'

const PEER_ID_STORAGE_KEY = 'narrative:peerId'

// ---------------------------------------------------------------------------
// Session peer ID — persist across refresh, new per tab
// ---------------------------------------------------------------------------

function getOrCreatePeerId(): string {
  try {
    const existing = sessionStorage.getItem(PEER_ID_STORAGE_KEY)
    if (existing) return existing
    const fresh = generatePeerId()
    sessionStorage.setItem(PEER_ID_STORAGE_KEY, fresh)
    return fresh
  } catch {
    // sessionStorage unavailable (private mode, SSR guard)
    return generatePeerId()
  }
}

interface SlideDocProviderProps {
  deckId: string
  /**
   * M16 P6 — When supplied, the provider uses this Y.Doc instead of opening
   * a Hocuspocus WebSocket. Used by the component master editor to drive the
   * standard editor stack against the master doc held by `componentDocCache`.
   * The caller owns the doc's lifecycle; we do NOT destroy it on unmount.
   */
  doc?: Y.Doc
  /**
   * Publish this client in the deck's awareness (default true). The render
   * page (agentic A3) passes false: the render worker's browser must not
   * appear to the deck's editors as a peer.
   */
  presence?: boolean
  /**
   * With `doc`: the server refused the connection that fills it (the render
   * page of a master's card whose token ended) — reported like a refused
   * WebSocket of the provider's own.
   */
  refused?: boolean
  /**
   * Seed an empty deck with its first slide once synced (default true). The
   * render page passes false: it shows the deck as the server holds it and
   * reports an empty deck as such, never a slide it made up.
   */
  hydrate?: boolean
  children: React.ReactNode
}

export function SlideDocProvider({
  deckId,
  doc: externalDoc,
  presence = true,
  refused = false,
  hydrate = true,
  children,
}: SlideDocProviderProps) {
  if (externalDoc !== undefined) {
    return (
      <ExternalDocSlideProvider deckId={deckId} doc={externalDoc} refused={refused}>
        {children}
      </ExternalDocSlideProvider>
    )
  }
  return (
    <HocuspocusSlideProvider deckId={deckId} presence={presence} hydrate={hydrate}>
      {children}
    </HocuspocusSlideProvider>
  )
}

/**
 * How long a torn-down deck connection lingers before it is really destroyed.
 * Long enough to survive StrictMode's synchronous remount and a fast-refresh
 * cycle, short enough that leaving a deck frees the socket promptly.
 */
const TEARDOWN_DELAY_MS = 250

interface HocuspocusSlideProviderProps {
  deckId: string
  presence: boolean
  hydrate: boolean
  children: React.ReactNode
}

function HocuspocusSlideProvider({
  deckId,
  presence,
  hydrate,
  children,
}: HocuspocusSlideProviderProps) {
  const [value, setValue] = useState<Omit<
    SlideDocContextValue,
    'wsStatus' | 'synced' | 'refused'
  > | null>(null)
  const [wsStatus, setWsStatus] = useState<WsStatus>('connecting')
  const [synced, setSynced] = useState(false)
  const [refused, setRefused] = useState(false)
  const location = useLocation()
  const { user } = useAuth()

  // The live connection, kept across React StrictMode's mount → cleanup →
  // mount cycle (see the deferred teardown in the cleanup below).
  const providerRef = useRef<{
    deckId: string
    presence: boolean
    hydrate: boolean
    provider: HocuspocusProvider
    doc: Y.Doc
    awareness: Awareness
  } | null>(null)
  const teardownRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // `editor.show` messages of this deck connection (agentic A1). One bus per
  // provider instance: the editor subscribes once, whatever socket is live.
  const [showBus] = useState(createEditorShowBus)
  // This user's agent principal key on the deck, sent by the server over the
  // socket (state/agentPrincipal.ts). One store per provider instance.
  const [principalStore] = useState(createAgentPrincipalStore)

  // E2E (DEV only): feed a stateless payload through the same path the
  // socket uses, so specs can drive the editor's `editor.show` handling
  // without a server round trip — same pattern as SelectionContext's
  // `narrative:test-set-selection`.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const handler = (e: Event): void => {
      const payload = (e as CustomEvent<{ payload?: unknown }>).detail?.payload
      const message = parseEditorShowMessage(payload)
      if (message !== null) showBus.emit(message)
      const principal = parseAgentPrincipalMessage(payload)
      if (principal !== null) principalStore.set(principal)
    }
    window.addEventListener('narrative:test-stateless', handler)
    return () => window.removeEventListener('narrative:test-stateless', handler)
  }, [showBus, principalStore])

  useEffect(() => {
    const destroyNow = (held: NonNullable<typeof providerRef.current>): void => {
      // M8: broadcast disappear to other peers.
      held.awareness.setLocalState(null)
      // E2E: detach the window hook from a doc that is going away, so a spec
      // cannot seed objects into a document nothing renders from.
      void import('./testApi.js').then(({ uninstallTestApi }) => {
        uninstallTestApi(held.doc)
      })
      held.provider.destroy()
      held.doc.destroy()
    }

    // A remount reclaims the connection its own cleanup scheduled for
    // teardown. StrictMode runs mount → cleanup → mount on every deck open in
    // dev; destroying eagerly meant a second Y.Doc and a second Hocuspocus
    // socket per deck, with a window in which the two docs both existed and
    // writes could land in the one that was about to be thrown away.
    if (teardownRef.current !== null) {
      clearTimeout(teardownRef.current)
      teardownRef.current = null
    }
    /**
     * Schedule the teardown of `target`, unless a remount reclaims it first.
     * Returned from every path through this effect — including the reclaim
     * path, which must still hand React a cleanup or the connection would
     * outlive the last unmount.
     */
    const scheduleTeardown = (target: HocuspocusProvider) => (): void => {
      teardownRef.current = setTimeout(() => {
        teardownRef.current = null
        const current = providerRef.current
        if (current === null || current.provider !== target) return
        destroyNow(current)
        providerRef.current = null
        setValue(null)
      }, TEARDOWN_DELAY_MS)
    }

    const held = providerRef.current
    if (held !== null) {
      // The same connection only for the same deck opened the same way: a
      // change of presence or hydration (the editor ↔ the render page) needs
      // a connection set up for it.
      if (held.deckId === deckId && held.presence === presence && held.hydrate === hydrate) {
        return scheduleTeardown(held.provider)
      }
      // A different deck (or mode) — let the old one go right away.
      destroyNow(held)
      providerRef.current = null
      setValue(null)
    }

    const doc = new Y.Doc()
    // Perf harness (docs/plans/perf-harness.md): the deck's transactions, ours
    // and the server's. Attached only when counting is on (dev, `?perf=1`).
    if (perfCountersOn()) {
      doc.on('afterTransaction', (tr: Y.Transaction) => {
        perfCount(tr.local ? 'y.tx.local' : 'y.tx.remote')
        // A transaction that changed nothing (a binding's no-op, the server's
        // echo of our own update): counted apart so a write can be told from one.
        if (tr.changed.size === 0 && tr.deleteSet.clients.size === 0) {
          perfCount(tr.local ? 'y.tx.local.empty' : 'y.tx.remote.empty')
        }
      })
    }
    // A new document has not heard from the server yet.
    setSynced(false)
    setRefused(false)
    // A key told for the previous deck must not label this one's agents.
    principalStore.set(null)

    // M8: Local peer identity — stable for the entire session tab. Never the
    // Google sub or the email: awareness reaches share-link viewers too
    // (localPeerUser).
    const peerId = getOrCreatePeerId()
    const localUser: PeerUser = localPeerUser(peerId, user?.name)

    // The session cookie, or on a share-link visit the page's share_token
    // (state/hocuspocusAuth.ts — the auth frame is always sent).
    const authOptions = hocuspocusAuthOptions(HOCUSPOCUS_URL, location.search)

    // Last non-null local awareness state, kept so a reconnect can restore
    // it (see restoredLocalState). Fed by the awareness 'update' listener
    // installed below, once the provider exists.
    let lastLocalState: PeerAwarenessState | null = null

    const provider = new HocuspocusProvider({
      name: deckId,
      document: doc,
      ...authOptions,
      onConnect() {
        markWsConnected()
        setWsStatus('connected')
        // M8: Restore awareness state on (re)connect — Hocuspocus clears it after reconnect.
        const current = (provider.awareness?.getLocalState() ?? null) as PeerAwarenessState | null
        provider.awareness?.setLocalState(
          presence ? restoredLocalState(localUser, current ?? lastLocalState) : null,
        )
      },
      onDisconnect() {
        setWsStatus('disconnected')
      },
      // The server refused this connection (no access, a revoked share link,
      // an expired render token): the document will never sync.
      onAuthenticationFailed() {
        setRefused(true)
      },
      // Agentic A1: the server addresses this user's open editors with
      // stateless messages — `editor.show`, and the user's agent principal
      // key right after connecting. Anything else is ignored.
      onStateless({ payload }: { payload: string }) {
        const message = parseEditorShowMessage(payload)
        if (message !== null) showBus.emit(message)
        const principal = parseAgentPrincipalMessage(payload)
        if (principal !== null && principal.documentName === deckId) principalStore.set(principal)
      },
      onStatus({ status }: { status: string }) {
        if (status === 'connected' || status === 'connecting' || status === 'disconnected') {
          setWsStatus(status as WsStatus)
        }
      },
      // Hocuspocus also reports `state: false` (on close); only a real sync
      // counts — and only it may hydrate.
      onSynced({ state }: { state: boolean }) {
        if (!state) return
        markWsSynced()
        setSynced(true)
        // P12d: hydrate AFTER sync so we don't race the server with an
        // empty default slide. Children have already mounted with the
        // pre-sync deckCtx (the doc reference is stable); Yjs observers
        // pick up the server's slides as they arrive. The mutation
        // context's `slides` Y.Array reference is the same one we
        // installed below, since hydrateSlideDoc is idempotent and only
        // touches the doc when the deck is genuinely empty.
        if (hydrate) hydrateSlideDoc(doc)
        // E2E: expose a dev-only hook on window for Playwright to seed
        // reproducible Y.Doc fixtures (bypassing flaky editor-UI locators).
        // Stripped from prod bundles via import.meta.env.DEV in testApi.ts.
        void import('./testApi.js').then(({ installTestApi }) => {
          // Use the doc's current slides handle, not a stale closure.
          const slides = doc.getArray('slides')
          installTestApi({ doc, slides } as SlideMutationContext)
        })
      },
    })

    // P12d cold-start fix: don't gate `value` on `onSynced`. The
    // children (Canvas, Pixi init, reconciler) need to mount as early
    // as possible so the WS handshake, Postgres hydration, WebGL init
    // and first reconcile run in parallel instead of sequentially.
    //
    // Yjs observers handle live updates — when the server's slides
    // arrive, the Y.Array.observeDeep callbacks fire and the reconciler
    // applies them as ObjectChangeSets. The deckCtx wraps stable Y.Doc
    // references, so we don't need to re-set it on sync.
    //
    // We deliberately skip `hydrateSlideDoc` here: it would seed a
    // default empty slide on a fresh-load doc, then the server's
    // slides would merge on top via CRDT, leaving an extra empty
    // slide on every reload. Hydration runs in onSynced.
    const slides = doc.getArray('slides') as SlideMutationContext['slides']
    const earlyDeckCtx: SlideMutationContext = { doc, slides }
    const undoManager = createUndoManager(earlyDeckCtx)
    setValue({
      deckCtx: earlyDeckCtx,
      undoManager,
      awareness: provider.awareness!,
      localUser,
      documentName: deckId,
      documentKey: deckId,
      whenSaved: () => whenProviderSaved(provider),
    })

    // M8: Set initial awareness state immediately (even before WS connect —
    // awareness.setLocalState works locally, broadcast happens after connect).
    const awareness = provider.awareness
    if (awareness === null) {
      throw new Error('HocuspocusProvider.awareness is null — provider not initialized')
    }
    providerRef.current = { deckId, presence, hydrate, provider, doc, awareness }
    awareness.on('update', () => {
      const local = awareness.getLocalState() as PeerAwarenessState | null
      if (local !== null) lastLocalState = local
    })
    // `activeSlideId: null` until the editor publishes the slide it shows;
    // present mode never does (it is not an editing context).
    awareness.setLocalState(presence ? restoredLocalState(localUser, null) : null)

    // M9: Do NOT hydrate before onSynced fires. hydrateSlideDoc() seeds a
    // default empty slide when the doc has no slides — but if WS sync is still
    // pending, the doc is empty locally even though the server has data. A
    // pre-sync hydrate would add an empty slide that then merges with the
    // server's real slides (Yjs CRDT merge), leaving an extra empty slide on
    // every reload. Wait for onSynced so we know Y.Doc state matches server.

    // Defer the teardown by a tick so an immediate remount (StrictMode, or a
    // fast-refresh re-render) reclaims this provider instead of trading it for
    // a fresh doc and socket. A real unmount just runs it late.
    return scheduleTeardown(provider)
  }, [deckId, presence, hydrate, showBus, principalStore])

  // Memoize the merged context value — without this, every parent re-render
  // creates a fresh `{...value, wsStatus}` object reference, which forces
  // every `useSlideDoc()` consumer (huge fan-out across the editor) to
  // re-render even when nothing actually changed.
  // IMPORTANT: this hook must run unconditionally on every render (Rules of
  // Hooks). When `value === null` we still call useMemo and just return null
  // from the provider; the early-return for the loading state happens AFTER.
  const fullValue = useMemo<SlideDocContextValue | null>(
    () => (value === null ? null : { ...value, wsStatus, synced, refused }),
    [value, wsStatus, synced, refused],
  )
  // Each pointer gesture is one undo step, by its boundaries (undoGestures.ts).
  usePointerUndoGestures(value?.undoManager)

  if (fullValue === null) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-gray-950">
        <p className="text-sm text-gray-400">Connecting…</p>
      </div>
    )
  }

  return (
    <SlideDocContext value={fullValue}>
      <AgentPrincipalStoreContext value={principalStore}>
        <EditorShowBusContext value={showBus}>{children}</EditorShowBusContext>
      </AgentPrincipalStoreContext>
    </SlideDocContext>
  )
}

// ---------------------------------------------------------------------------
// External-doc variant — M16 P6
// ---------------------------------------------------------------------------

interface ExternalDocSlideProviderProps {
  deckId: string
  doc: Y.Doc
  refused: boolean
  children: React.ReactNode
}

/**
 * Drives the SlideDoc context against an externally-owned Y.Doc — used by the
 * component master editor where the doc lives in `componentDocCache` and
 * outlives any single mount.
 *
 * Differences from the deck path:
 *   - No HocuspocusProvider (the cache owns the connection).
 *   - `wsStatus` is reported as 'connected' once we have a doc reference;
 *     consumers that gate on it ("Connecting…" overlay) bypass entirely.
 *   - Awareness is a local-only y-protocols Awareness instance — peer chips
 *     and cursor overlays still work but show only the local user. Master
 *     editing is a single-user concept for P6; P7+ can wire shared
 *     awareness via the cache if/when collaborative master editing lands.
 *   - Doc is NEVER destroyed on unmount — the cache controls lifecycle.
 *   - The server writes the master slide (id 'master') when it creates the
 *     component (`writeComponentMaster`); we do NOT call hydrateSlideDoc here.
 */
/** `component:<id>` → `<id>`: the document key a master editor mounts with. */
function componentIdOf(documentKey: string): string {
  return documentKey.startsWith('component:') ? documentKey.slice('component:'.length) : documentKey
}

function ExternalDocSlideProvider({
  deckId,
  doc,
  refused,
  children,
}: ExternalDocSlideProviderProps) {
  const { user } = useAuth()

  const profileName = user?.name
  const localUser = useMemo<PeerUser>(
    () => localPeerUser(getOrCreatePeerId(), profileName),
    [profileName],
  )

  const base = useMemo<SlideDocContextValue>(() => {
    const slides = doc.getArray('slides') as SlideMutationContext['slides']
    const deckCtx: SlideMutationContext = { doc, slides }
    const undoManager = createUndoManager(deckCtx)
    // Local-only awareness — y-protocols Awareness with this doc is a valid
    // "no peers" implementation that the rest of the editor can read from.
    const awareness = new Awareness(doc)
    awareness.setLocalState(restoredLocalState(localUser, null))
    return {
      deckCtx,
      undoManager,
      awareness,
      localUser,
      // Local-only: no server, so no peers (and no agent peers) to identify.
      documentName: null,
      documentKey: deckId,
      // The cache's provider carries this document's edits to the server.
      whenSaved: () => whenComponentDocSaved(componentIdOf(deckId)),
      wsStatus: 'connected',
      synced: true,
      refused: false,
    }
  }, [deckId, doc, localUser])
  const value = useMemo(() => (refused ? { ...base, refused } : base), [base, refused])

  // We deliberately do NOT call hydrateSlideDoc here. The server writes the
  // master doc's single slide, id 'master', when it creates the component
  // (slide-model `writeComponentMaster`) — calling hydrateSlideDoc would
  // seed a fresh nanoid id instead. The cache guarantees the doc is fully
  // synced before `<ComponentMasterEditor>` mounts this provider, so the
  // master slide is always present.

  // Each pointer gesture is one undo step, by its boundaries (undoGestures.ts).
  usePointerUndoGestures(value.undoManager)

  // Awareness is a fresh Awareness instance per provider instance —
  // dispose on unmount to avoid leaking the local-state listeners.
  useEffect(() => {
    const a = value.awareness
    return () => {
      try {
        a.destroy()
      } catch {
        // ignore — Awareness.destroy is idempotent in newer versions
      }
    }
  }, [value.awareness])

  // Note: deckId is part of the public API but unused in the external-doc
  // path — referenced here so eslint no-unused-vars stays happy without an
  // underscore-prefix rename that would also leak into the type.
  void deckId

  return <SlideDocContext value={value}>{children}</SlideDocContext>
}
