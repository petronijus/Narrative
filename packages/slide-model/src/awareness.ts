/**
 * slide-model/src/awareness.ts
 *
 * Awareness helper API pro M8.
 *
 * Tento modul smí importovat y-protocols (přes yjs) — je v package boundary.
 * Apps nesmí importovat y-protocols přímo.
 *
 * Exports:
 *   - generatePeerId()   — nanoid session ID (nanoid je dep tohoto package)
 *   - toPeerInfo()       — parser Y.Awareness state → PeerInfo
 *   - peerColorFromId    — re-export z @narrative/shared
 */

import { nanoid } from 'nanoid'
import type { PeerAwarenessState, PeerInfo } from '@narrative/shared'
export { peerColorFromId } from '@narrative/shared'

// ---------------------------------------------------------------------------
// Peer ID generation
// ---------------------------------------------------------------------------

/**
 * Vygeneruje nové stabilní session ID.
 *
 * nanoid produkuje 21-char URL-safe string s dostatečnou entropií.
 * Caller je zodpovědný za uložení do sessionStorage pod klíčem `narrative:peerId`.
 */
export function generatePeerId(): string {
  return nanoid()
}

// ---------------------------------------------------------------------------
// Awareness state parser
// ---------------------------------------------------------------------------

/**
 * Převede Yjs awareness state entry na typovaný PeerInfo.
 *
 * @param clientId - Yjs awareness clientId (číslo přiřazené Yjs runtime)
 * @param rawState - raw state object z awareness.getStates().get(clientId)
 * @param localClientId - clientId lokálního Y.Doc (z doc.clientID)
 *
 * Bezpečné pro nevalidní/neúplný stav — vrátí null pokud chybí required fields.
 */
export function toPeerInfo(
  clientId: number,
  rawState: unknown,
  localClientId: number,
): PeerInfo | null {
  if (rawState === null || typeof rawState !== 'object') return null

  const s = rawState as Record<string, unknown>

  // Validace user field
  if (!s['user'] || typeof s['user'] !== 'object') return null
  const user = s['user'] as Record<string, unknown>
  if (typeof user['id'] !== 'string') return null
  if (typeof user['name'] !== 'string') return null
  if (typeof user['color'] !== 'string') return null

  // Validace selectedObjectIds
  const rawIds = s['selectedObjectIds']
  if (!Array.isArray(rawIds)) return null
  const selectedObjectIds = rawIds.filter((x): x is string => typeof x === 'string')

  // Validace cursor (nullable)
  let cursor: PeerAwarenessState['cursor'] = null
  if (s['cursor'] !== null && s['cursor'] !== undefined) {
    const c = s['cursor'] as Record<string, unknown>
    if (typeof c['x'] === 'number' && typeof c['y'] === 'number') {
      cursor = { x: c['x'], y: c['y'] }
    }
  }

  const state: PeerAwarenessState = {
    user: {
      id: user['id'] as string,
      name: user['name'] as string,
      color: user['color'] as string,
    },
    selectedObjectIds,
    cursor,
  }

  return {
    clientId,
    state,
    isLocal: clientId === localClientId,
  }
}
