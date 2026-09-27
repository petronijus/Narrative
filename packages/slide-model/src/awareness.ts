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
import {
  AGENT_PRINCIPAL_KEY_LENGTH,
  PEER_USER_NAME_MAX,
  sanitizePeerLabel,
  type PeerAgentInfo,
  type PeerAwarenessState,
  type PeerInfo,
} from '@narrative/shared'
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

  // Validace cursor (nullable). slideId is required so we can filter
  // remote cursors by the receiver's active slide; drop legacy payloads
  // without it so they don't render on the wrong artboard.
  let cursor: PeerAwarenessState['cursor'] = null
  if (s['cursor'] !== null && s['cursor'] !== undefined) {
    const c = s['cursor'] as Record<string, unknown>
    if (
      typeof c['x'] === 'number' &&
      typeof c['y'] === 'number' &&
      typeof c['slideId'] === 'string'
    ) {
      cursor = { x: c['x'], y: c['y'], slideId: c['slideId'] }
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

  // Agentic A1 — both fields are optional and additive. Clients older than
  // A1 publish neither, so an absent or malformed value is simply left out:
  // it must never make the whole peer invalid (the peer still shows up with
  // its selection and cursor, exactly as before).
  const activeSlideId = s['activeSlideId']
  if (typeof activeSlideId === 'string' || activeSlideId === null) {
    state.activeSlideId = activeSlideId
  }
  const agent = parseAgentInfo(s['agent'])
  if (agent !== null) state.agent = agent

  return {
    clientId,
    state,
    isLocal: clientId === localClientId,
  }
}

/**
 * The `agent` field of an agent peer (ADR 0011), or null when absent or
 * malformed. `runId` and `surface` are required: without them the value
 * cannot be an agent run, so the peer is treated as a plain peer instead.
 *
 * `principalName` and `principalKey` are optional on the wire (a server
 * older than them sends neither) and come out as null when absent or
 * malformed. The name is re-sanitised here: awareness is client-asserted,
 * so a received label is untrusted even though the server sanitises what it
 * publishes. The key must look like one (base64url, the exact length) or it
 * is dropped. A legacy `onBehalfOf` is ignored — older servers put the
 * user's Google sub there, and it must never reach a label.
 */
function parseAgentInfo(raw: unknown): PeerAgentInfo | null {
  if (raw === null || typeof raw !== 'object') return null
  const a = raw as Record<string, unknown>
  const { runId, surface, principalName, principalKey } = a
  if (typeof runId !== 'string' || runId === '') return null
  if (surface !== 'mcp' && surface !== 'api') return null
  return {
    runId,
    surface,
    principalName:
      typeof principalName === 'string'
        ? sanitizePeerLabel(principalName, PEER_USER_NAME_MAX)
        : null,
    principalKey:
      typeof principalKey === 'string' && PRINCIPAL_KEY_RE.test(principalKey) ? principalKey : null,
  }
}

const PRINCIPAL_KEY_RE = new RegExp(`^[A-Za-z0-9_-]{${AGENT_PRINCIPAL_KEY_LENGTH}}$`)
