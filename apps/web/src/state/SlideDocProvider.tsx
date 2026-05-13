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
 * Connection URL from env: VITE_HOCUSPOCUS_URL (default ws://localhost:3002)
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

import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth } from './AuthContext.js'
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { Awareness } from 'y-protocols/awareness'
import {
  createUndoManager,
  generatePeerId,
  peerColorFromId,
  hydrateSlideDoc,
} from '@narrative/slide-model'
import type { SlideMutationContext } from '@narrative/slide-model'
import type { PeerUser } from '@narrative/shared'
import { SlideDocContext } from './slideDocContext.js'
import type { SlideDocContextValue, WsStatus } from './slideDocContext.js'
import { markWsConnected, markWsSynced } from './loadTimings.js'

const HOCUSPOCUS_URL = import.meta.env['VITE_HOCUSPOCUS_URL'] ?? 'ws://localhost:3002'
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
  children: React.ReactNode
}

export function SlideDocProvider({ deckId, doc: externalDoc, children }: SlideDocProviderProps) {
  if (externalDoc !== undefined) {
    return (
      <ExternalDocSlideProvider deckId={deckId} doc={externalDoc}>
        {children}
      </ExternalDocSlideProvider>
    )
  }
  return <HocuspocusSlideProvider deckId={deckId}>{children}</HocuspocusSlideProvider>
}

interface HocuspocusSlideProviderProps {
  deckId: string
  children: React.ReactNode
}

function HocuspocusSlideProvider({ deckId, children }: HocuspocusSlideProviderProps) {
  const [value, setValue] = useState<Omit<SlideDocContextValue, 'wsStatus'> | null>(null)
  const [wsStatus, setWsStatus] = useState<WsStatus>('connecting')
  const location = useLocation()
  const { user } = useAuth()

  // Ref for StrictMode double-mount guard
  const providerRef = useRef<HocuspocusProvider | null>(null)

  useEffect(() => {
    // StrictMode guard — don't remount if provider already exists for this deckId
    if (providerRef.current !== null) return

    const doc = new Y.Doc()

    // M8: Local peer identity — stable for the entire session tab
    // M10: Prefer authenticated user name/id when available
    const peerId = getOrCreatePeerId()
    const localUser: PeerUser = {
      id: user?.sub ?? peerId,
      name: user?.name ?? user?.email ?? `User ${peerId.slice(0, 4)}`,
      color: peerColorFromId(peerId),
    }

    // M10: share_token from URL query params — passed as WS parameter for the
    // anonymous viewer path.
    // 2026-05: cookie-based auth. The `narrative_session` HttpOnly cookie on
    // the WS upgrade carries the real identity; `token: 'cookie'` is a
    // sentinel that triggers HocuspocusProvider's auth-frame so the server's
    // onAuthenticate hook runs (server ignores the value and reads the
    // cookie). See `docs/adr/0005-server-side-session-cookies.md`.
    const searchParams = new URLSearchParams(location.search)
    const shareToken = searchParams.get('share_token')

    const authOptions =
      shareToken !== null ? { parameters: { share_token: shareToken } } : { token: 'cookie' }

    const provider = new HocuspocusProvider({
      url: HOCUSPOCUS_URL,
      name: deckId,
      document: doc,
      ...authOptions,
      onConnect() {
        markWsConnected()
        setWsStatus('connected')
        // M8: Restore awareness state on (re)connect — Hocuspocus clears it after reconnect.
        provider.awareness?.setLocalState({
          user: localUser,
          selectedObjectIds: [],
          cursor: null,
        })
      },
      onDisconnect() {
        setWsStatus('disconnected')
      },
      onStatus({ status }: { status: string }) {
        if (status === 'connected' || status === 'connecting' || status === 'disconnected') {
          setWsStatus(status as WsStatus)
        }
      },
      onSynced() {
        markWsSynced()
        // P12d: hydrate AFTER sync so we don't race the server with an
        // empty default slide. Children have already mounted with the
        // pre-sync deckCtx (the doc reference is stable); Yjs observers
        // pick up the server's slides as they arrive. The mutation
        // context's `slides` Y.Array reference is the same one we
        // installed below, since hydrateSlideDoc is idempotent and only
        // touches the doc when the deck is genuinely empty.
        hydrateSlideDoc(doc)
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

    providerRef.current = provider

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
    setValue({ deckCtx: earlyDeckCtx, undoManager, awareness: provider.awareness!, localUser })

    // M8: Set initial awareness state immediately (even before WS connect —
    // awareness.setLocalState works locally, broadcast happens after connect).
    const awareness = provider.awareness
    if (awareness === null) {
      throw new Error('HocuspocusProvider.awareness is null — provider not initialized')
    }
    awareness.setLocalState({
      user: localUser,
      selectedObjectIds: [],
      cursor: null,
    })

    // M9: Do NOT hydrate before onSynced fires. hydrateSlideDoc() seeds a
    // default empty slide when the doc has no slides — but if WS sync is still
    // pending, the doc is empty locally even though the server has data. A
    // pre-sync hydrate would add an empty slide that then merges with the
    // server's real slides (Yjs CRDT merge), leaving an extra empty slide on
    // every reload. Wait for onSynced so we know Y.Doc state matches server.

    return () => {
      // M8: Cleanup — broadcast disappear to other peers
      awareness.setLocalState(null)
      provider.destroy()
      doc.destroy()
      providerRef.current = null
      setValue(null)
    }
  }, [deckId])

  // Memoize the merged context value — without this, every parent re-render
  // creates a fresh `{...value, wsStatus}` object reference, which forces
  // every `useSlideDoc()` consumer (huge fan-out across the editor) to
  // re-render even when nothing actually changed.
  // IMPORTANT: this hook must run unconditionally on every render (Rules of
  // Hooks). When `value === null` we still call useMemo and just return null
  // from the provider; the early-return for the loading state happens AFTER.
  const fullValue = useMemo<SlideDocContextValue | null>(
    () => (value === null ? null : { ...value, wsStatus }),
    [value, wsStatus],
  )

  if (fullValue === null) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-gray-950">
        <p className="text-sm text-gray-400">Connecting…</p>
      </div>
    )
  }

  return <SlideDocContext.Provider value={fullValue}>{children}</SlideDocContext.Provider>
}

// ---------------------------------------------------------------------------
// External-doc variant — M16 P6
// ---------------------------------------------------------------------------

interface ExternalDocSlideProviderProps {
  deckId: string
  doc: Y.Doc
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
 *   - The doc is seeded by `writeComponentMasterTree` (one slide, id='master')
 *     before the cache exposes it; we do NOT call hydrateSlideDoc here.
 */
function ExternalDocSlideProvider({ deckId, doc, children }: ExternalDocSlideProviderProps) {
  const { user } = useAuth()

  const localUser = useMemo<PeerUser>(() => {
    const peerId = getOrCreatePeerId()
    return {
      id: user?.sub ?? peerId,
      name: user?.name ?? user?.email ?? `User ${peerId.slice(0, 4)}`,
      color: peerColorFromId(peerId),
    }
  }, [user])

  const value = useMemo<SlideDocContextValue>(() => {
    const slides = doc.getArray('slides') as SlideMutationContext['slides']
    const deckCtx: SlideMutationContext = { doc, slides }
    const undoManager = createUndoManager(deckCtx)
    // Local-only awareness — y-protocols Awareness with this doc is a valid
    // "no peers" implementation that the rest of the editor can read from.
    const awareness = new Awareness(doc)
    awareness.setLocalState({
      user: localUser,
      selectedObjectIds: [],
      cursor: null,
    })
    return {
      deckCtx,
      undoManager,
      awareness,
      localUser,
      wsStatus: 'connected',
    }
  }, [doc, localUser])

  // We deliberately do NOT call hydrateSlideDoc here. The component master
  // doc is seeded by `writeComponentMasterTree` immediately after promotion
  // with a single slide whose id is 'master' — calling hydrateSlideDoc would
  // seed a fresh nanoid id instead. The cache guarantees the doc is fully
  // synced before `<ComponentMasterEditor>` mounts this provider, so the
  // master slide is always present.

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

  return <SlideDocContext.Provider value={value}>{children}</SlideDocContext.Provider>
}
