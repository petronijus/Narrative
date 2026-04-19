/**
 * state/useAwareness.ts
 *
 * Read-only hook vracející aktuální awareness state všech peerů.
 *
 * M8: Subscribuje na Y.Awareness change eventy a vrací PeerInfo[].
 * Používá useSyncExternalStore pro efektivní React integraci.
 *
 * Stabilita snapshotu:
 *   useSyncExternalStore volá getSnapshot() opakovaně a porovnává výsledky
 *   referencí (Object.is). Pokud getSnapshot() vrátí nový objekt pokaždé,
 *   React detekuje "infinite loop" a vyhodí varování / error.
 *
 *   Řešení: cachedSnapshotRef drží poslední výsledek. Cache je invalidována
 *   při každém 'change' eventu z awareness. Mezi eventy getSnapshot()
 *   vrací stabilní referenci.
 *
 * Package boundary: Y.Awareness je dostupný pouze přes SlideDocContext.awareness.
 * Hooks nesmí importovat y-protocols přímo.
 * toPeerInfo je z @narrative/slide-model (package boundary respektován).
 */

import { useSyncExternalStore, useCallback, useRef } from 'react'
import { toPeerInfo } from '@narrative/slide-model'
import type { PeerInfo } from '@narrative/shared'
import { useSlideDoc } from './useSlideDoc.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AwarenessSnapshot {
  peers: PeerInfo[]
  remotePeers: PeerInfo[]
  localClientId: number
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAwareness(): AwarenessSnapshot {
  const { awareness } = useSlideDoc()

  // Cached snapshot — invalidovaný při každém awareness 'change' eventu.
  // Platné pouze do dalšího change eventu. Po invalidaci getSnapshot znovu
  // spočítá a uloží novou referenci.
  const cachedRef = useRef<AwarenessSnapshot | null>(null)

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const handler = () => {
        // Invalidujeme cache — getSnapshot vytvoří nový objekt při příštím volání
        cachedRef.current = null
        onStoreChange()
      }
      awareness.on('change', handler)
      return () => {
        awareness.off('change', handler)
      }
    },
    [awareness],
  )

  const getSnapshot = useCallback((): AwarenessSnapshot => {
    // Vrátíme cached snapshot pokud stále platný (nebyl invalidován)
    if (cachedRef.current !== null) {
      return cachedRef.current
    }

    const localClientId = awareness.clientID
    const states = awareness.getStates() as Map<number, unknown>

    const peers: PeerInfo[] = []
    for (const [clientId, rawState] of states) {
      const peerInfo = toPeerInfo(clientId, rawState, localClientId)
      if (peerInfo !== null) {
        peers.push(peerInfo)
      }
    }

    const remotePeers = peers.filter((p) => !p.isLocal)
    const snapshot: AwarenessSnapshot = { peers, remotePeers, localClientId }

    cachedRef.current = snapshot
    return snapshot
  }, [awareness])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
