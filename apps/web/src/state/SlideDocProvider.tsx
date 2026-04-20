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
 *   - JWT access token passed as `token` to HocuspocusProvider (server validates).
 *   - share_token from URL query params passed as WS URL parameter for anonymous viewer path.
 *   - When BYPASS_AUTH=true on server (dev), missing token is fine.
 *
 * Lifecycle:
 *   mount   → HocuspocusProvider.connect() (WS handshake, server hydrates Y.Doc)
 *   unmount → HocuspocusProvider.destroy() (cleanup WS + Yjs subscriptions)
 *
 * Connection URL from env: VITE_HOCUSPOCUS_URL (default ws://localhost:3002)
 * Document name = deckId from props (passed from URL param /deck/:id)
 */

import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth } from './AuthContext.js'
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'
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
  children: React.ReactNode
}

export function SlideDocProvider({ deckId, children }: SlideDocProviderProps) {
  const [value, setValue] = useState<Omit<SlideDocContextValue, 'wsStatus'> | null>(null)
  const [wsStatus, setWsStatus] = useState<WsStatus>('connecting')
  const location = useLocation()
  const { token, user } = useAuth()

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

    // M10: share_token from URL query params — passed as WS parameter for anonymous viewer path
    const searchParams = new URLSearchParams(location.search)
    const shareToken = searchParams.get('share_token')

    // M10: Build auth options separately to avoid exactOptionalPropertyTypes conflicts
    const authOptions = {
      ...(token !== null ? { token } : { token: null }),
      ...(shareToken !== null ? { parameters: { share_token: shareToken } } : {}),
    }

    const provider = new HocuspocusProvider({
      url: HOCUSPOCUS_URL,
      name: deckId,
      document: doc,
      ...authOptions,
      onConnect() {
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
        // M9: After Hocuspocus syncs the Y.Doc, run backward-compat migration.
        // hydrateSlideDoc is idempotent — safe to call multiple times.
        const handles = hydrateSlideDoc(doc)
        const deckCtx: SlideMutationContext = {
          doc: handles.doc,
          slides: handles.slides,
        }
        const undoManager = createUndoManager(deckCtx)
        setValue({ deckCtx, undoManager, awareness: provider.awareness!, localUser })
      },
    })

    providerRef.current = provider

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

  if (value === null) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-gray-950">
        <p className="text-sm text-gray-400">Connecting…</p>
      </div>
    )
  }

  const fullValue: SlideDocContextValue = { ...value, wsStatus }
  return <SlideDocContext.Provider value={fullValue}>{children}</SlideDocContext.Provider>
}
