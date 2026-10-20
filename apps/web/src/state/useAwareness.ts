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

/**
 * An awareness state (or part of one) by content. States are small JSON
 * values — they travel as JSON — so their serialisation is their identity.
 */
function stateKey(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'undefined'
  } catch {
    return String(Math.random())
  }
}

/**
 * The other people's awareness, and nothing of this client's own.
 *
 * `useAwareness()` hands out a new snapshot on every awareness change — this
 * client's own cursor (30 Hz while the pointer moves) and selection included —
 * and every reader renders for it, synchronously. Most readers draw other
 * people (cursors, selection frames, who is where) and have no use for the
 * local entry. This hook's snapshot is the same array for as long as no
 * remote peer's state has changed in content, so the local cursor moving
 * renders nothing here. (By content, not by object: y-protocols swaps in a
 * new state object for every awareness message it applies, and the sync
 * server re-sends unchanged states — it broadcasts every flush to every
 * connection, the sender included — so a peer that did nothing used to
 * re-render every reader once per local edit.)
 */
export function useRemotePeers(): PeerInfo[] {
  const { awareness } = useSlideDoc()
  const cacheRef = useRef<{ key: unknown[]; peers: PeerInfo[] } | null>(null)

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      awareness.on('change', onStoreChange)
      return () => {
        awareness.off('change', onStoreChange)
      }
    },
    [awareness],
  )

  const getSnapshot = useCallback((): PeerInfo[] => {
    const localClientId = awareness.clientID
    const states = awareness.getStates() as Map<number, unknown>
    const key: unknown[] = []
    for (const [clientId, rawState] of states) {
      if (clientId !== localClientId) key.push(clientId, stateKey(rawState))
    }
    const cached = cacheRef.current
    if (
      cached !== null &&
      cached.key.length === key.length &&
      cached.key.every((v, i) => v === key[i])
    ) {
      return cached.peers
    }
    const peers: PeerInfo[] = []
    for (const [clientId, rawState] of states) {
      const peerInfo = toPeerInfo(clientId, rawState, localClientId)
      if (peerInfo !== null && !peerInfo.isLocal) peers.push(peerInfo)
    }
    cacheRef.current = { key, peers }
    return peers
  }, [awareness])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * Every peer (this client included) as far as presence chips show them: who
 * (`user`) and on whose behalf (`agent`). The snapshot keeps its identity
 * while only cursors, selections or the active slide change — this client's
 * cursor moves at 30 Hz during a drag — so a reader that shows identities
 * renders when one of them changes. The PeerInfo entries are those of the
 * last identity change: read only `clientId`, `isLocal`, `state.user` and
 * `state.agent` from them.
 */
export function usePresencePeers(): AwarenessSnapshot {
  const { awareness } = useSlideDoc()
  const cacheRef = useRef<{ key: unknown[]; snapshot: AwarenessSnapshot } | null>(null)

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      awareness.on('change', onStoreChange)
      return () => {
        awareness.off('change', onStoreChange)
      }
    },
    [awareness],
  )

  const getSnapshot = useCallback((): AwarenessSnapshot => {
    const localClientId = awareness.clientID
    const states = awareness.getStates() as Map<number, unknown>
    // By content (see useRemotePeers): remote states arrive as new objects
    // on every awareness message, changed or not.
    const key: unknown[] = [localClientId]
    for (const [clientId, rawState] of states) {
      const st = rawState as { user?: unknown; agent?: unknown; selectedObjectIds?: unknown } | null
      // (Whether the state is valid at all — toPeerInfo — rests on these too.)
      key.push(
        clientId,
        stateKey(st?.user),
        stateKey(st?.agent),
        Array.isArray(st?.selectedObjectIds),
      )
    }
    const cached = cacheRef.current
    if (
      cached !== null &&
      cached.key.length === key.length &&
      cached.key.every((v, i) => v === key[i])
    ) {
      return cached.snapshot
    }
    const peers: PeerInfo[] = []
    for (const [clientId, rawState] of states) {
      const peerInfo = toPeerInfo(clientId, rawState, localClientId)
      if (peerInfo !== null) peers.push(peerInfo)
    }
    const snapshot: AwarenessSnapshot = {
      peers,
      remotePeers: peers.filter((p) => !p.isLocal),
      localClientId,
    }
    cacheRef.current = { key, snapshot }
    return snapshot
  }, [awareness])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
