/**
 * state/SlideDocProvider.tsx
 *
 * React context provider pro SlideDoc.
 *
 * M4: Místo čistě in-memory Y.Doc používá HocuspocusProvider pro realtime sync
 * přes WebSocket. Y.Doc je sdílena s Yjs bindings (mutationCtx).
 *
 * M6 update: mutationCtx je rozšířen o animations Y.Array (SlideMutationContext).
 * UndoManager trackuje obě Y.Array (objects + animations).
 *
 * Lifecycle:
 *   mount   → HocuspocusProvider.connect() (WS handshake, server hydrates Y.Doc)
 *   unmount → HocuspocusProvider.destroy() (cleanup WS + Yjs subscriptions)
 *
 * Connection URL z env: VITE_HOCUSPOCUS_URL (default ws://localhost:3002)
 * Document name = deckId z props (předávané z URL param /deck/:id)
 *
 * Initial state:
 *   Server-side: onLoadDocument aplikuje existující updates z DB → Y.Doc je hydrated
 *   Client-side: po sync provider emituje 'synced' event → Y.Doc je ready
 *   Idempotentní seed: pokud deck nemá žádné objekty, Landing page seeduje prázdný deck
 *   bez dat — první otevření bude prázdné plátno (bez demo objects)
 *
 * Security (M4):
 *   Žádný auth — žádný token v URL nebo header. Všichni klienti mají write access.
 *   TODO(M10): přidat token do HocuspocusProvider options po implementaci JWT auth
 */

import { useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { createUndoManager } from '@narrative/slide-model'
import type { SlideMutationContext } from '@narrative/slide-model'
import { SlideDocContext } from './slideDocContext.js'
import type { SlideDocContextValue, WsStatus } from './slideDocContext.js'

const HOCUSPOCUS_URL = import.meta.env['VITE_HOCUSPOCUS_URL'] ?? 'ws://localhost:3002'

interface SlideDocProviderProps {
  deckId: string
  children: React.ReactNode
}

export function SlideDocProvider({ deckId, children }: SlideDocProviderProps) {
  const [value, setValue] = useState<Omit<SlideDocContextValue, 'wsStatus'> | null>(null)
  const [wsStatus, setWsStatus] = useState<WsStatus>('connecting')

  // Ref pro StrictMode double-mount guard
  const providerRef = useRef<HocuspocusProvider | null>(null)

  useEffect(() => {
    // StrictMode guard — neopakuj mount pokud provider existuje pro stejný deckId
    if (providerRef.current !== null) return

    const doc = new Y.Doc()

    const provider = new HocuspocusProvider({
      url: HOCUSPOCUS_URL,
      name: deckId,
      document: doc,
      onConnect() {
        setWsStatus('connected')
      },
      onDisconnect() {
        setWsStatus('disconnected')
      },
      onStatus({ status }: { status: string }) {
        // Hocuspocus status values: 'connecting' | 'connected' | 'disconnected'
        if (status === 'connected' || status === 'connecting' || status === 'disconnected') {
          setWsStatus(status)
        }
      },
    })

    providerRef.current = provider

    // M6: getArray je idempotentní — existující decky bez 'animations' dostanou
    // prázdný array (backward compat).
    const objects = doc.getArray<Y.Map<unknown>>('objects')
    const animations = doc.getArray<Y.Map<unknown>>('animations')

    const mutationCtx: SlideMutationContext = {
      doc,
      objects,
      animations,
    }

    const undoManager = createUndoManager(mutationCtx)

    setValue({ mutationCtx, undoManager })

    return () => {
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
