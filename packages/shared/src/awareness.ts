/**
 * shared/src/awareness.ts
 *
 * Awareness types a helper utilities pro M8 per-user real-time state sync.
 *
 * Typy jsou sdíleny mezi packages/slide-model, apps/web a apps/server.
 * Žádné runtime dependencies — pure TypeScript.
 *
 * Principles (viz ADR-state-sync):
 *   - Awareness ≠ Y.Doc state. Kurzory, selekce a user identity jsou ephemeral.
 *   - clientId je Y.Awareness peer identifier (number přiřazený Yjs).
 *   - PeerUser.id je stabilní per session (sessionStorage), ne per WebSocket connection.
 */

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export interface PeerUser {
  /** Stable per session (generován nanoid-em, persist v sessionStorage). M10 nahradí z auth. */
  id: string
  /** M8 placeholder: "User <first-4-chars-of-id>". M10 z auth tokenu. */
  name: string
  /** HSL barva, deterministická z id. Generovaná peerColorFromId(). */
  color: string
}

export interface PeerCursor {
  /** World coords — slide space (ne screen/canvas pixels). */
  x: number
  y: number
}

export interface PeerAwarenessState {
  user: PeerUser
  selectedObjectIds: string[]
  /** null když kurzor mimo canvas nebo peer idle (mouse leave). */
  cursor: PeerCursor | null
}

/**
 * Enriched peer info — Yjs clientId + parsed state + local flag.
 * Výstup toPeerInfo() a useAwareness() hooku.
 */
export interface PeerInfo {
  clientId: number
  state: PeerAwarenessState
  /** true pouze pro lokálního uživatele (vlastní awareness entry). */
  isLocal: boolean
}

// ---------------------------------------------------------------------------
// Color helper
// ---------------------------------------------------------------------------

/**
 * Deterministická HSL barva z string ID.
 *
 * Zaručeno: stejný vstup → stejný výstup (pure function, žádný random).
 * Různá ID produkují různé hue hodnoty (dostatečné rozlišení pro 15 peerů).
 *
 * Algoritmus: djb2-inspired hash → hue 0-359, fixed saturation 70%, lightness 55%.
 * Saturation/lightness voleny pro dobrý kontrast na tmavém canvas background.
 */
export function peerColorFromId(id: string): string {
  let hash = 0
  for (const c of id) {
    hash = (hash * 31 + c.charCodeAt(0)) | 0
  }
  const hue = Math.abs(hash) % 360
  return `hsl(${hue}, 70%, 55%)`
}
