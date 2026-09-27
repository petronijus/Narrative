/**
 * shared/src/awareness.ts
 *
 * Awareness types and helpers for per-user real-time state (M8), shared by
 * packages/slide-model, apps/web and apps/server. No runtime dependencies —
 * pure TypeScript.
 *
 * Principles (see ADR-state-sync):
 *   - Awareness is not Y.Doc state. Cursors, selections and peer identity are
 *     ephemeral.
 *   - clientId is the Y.Awareness peer identifier (a number assigned by Yjs).
 *   - PeerUser.id is a random id per browser tab (sessionStorage), never an
 *     account identifier: awareness reaches every connection of a document,
 *     anonymous share-link viewers included (security review of A1,
 *     2026-09-27).
 */

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export interface PeerUser {
  /**
   * The random peer id of the publishing tab (nanoid, kept in sessionStorage
   * so it survives a reload), or `agent:<runId>` for an agent peer. NEVER the
   * Google `sub`: awareness is broadcast to every connection, share-link
   * viewers included. Nothing may read it as an account id — the server
   * decides whose state is whose by connection (awarenessOwnership.ts).
   */
  id: string
  /**
   * Display name: the user's profile name (sanitised), or a neutral
   * "User <first 4 chars of the peer id>" — never the email.
   */
  name: string
  /** HSL colour, deterministic from the peer id (peerColorFromId). */
  color: string
}

export interface PeerCursor {
  /** World coordinates — slide space (not screen / canvas pixels). */
  x: number
  y: number
  /** Slide the cursor belongs to. Receivers filter by their own activeSlideId
   *  so a peer's cursor never leaks onto another slide's artboard. */
  slideId: string
}

export interface PeerAwarenessState {
  user: PeerUser
  selectedObjectIds: string[]
  /** Null when the pointer is outside the canvas or the peer is idle (mouse leave). */
  cursor: PeerCursor | null
  /**
   * The slide this peer's editor shows. Read by `editor.context` on the
   * server so an agent can resolve "this slide". Optional: clients older
   * than agentic-layer A1 do not publish it, and present mode does not.
   */
  activeSlideId?: string | null
  /**
   * Set only on the peer the server publishes for an agent run ("Claude
   * (MCP)"), so editors can tell an agent from a person. Absent on people.
   */
  agent?: PeerAgentInfo
}

/**
 * Who an agent peer works for, and in which run (ADR 0011 decision 8).
 *
 * Awareness reaches EVERY connection of a document, anonymous share-link
 * viewers included, so this carries no account identifier: never the Google
 * `sub`, never an email. It says whom the agent works for in two ways:
 *   - `principalName`, the user's display name, for everyone to read;
 *   - `principalKey`, an opaque key only that user can recognise as theirs
 *     (see {@link agentPrincipalKeyInput}): it is how an editor says
 *     "working for you" without anyone being able to tell which account it
 *     is, or to link the same person's agents across decks.
 */
export interface PeerAgentInfo {
  runId: string
  surface: 'mcp' | 'api'
  /**
   * The display name of the user the agent works for (their profile name,
   * sanitised and at most {@link PEER_USER_NAME_MAX} characters), or null
   * when they have none — deliberately not the email in that case.
   */
  principalName: string | null
  /**
   * `base64url(HMAC-SHA256(serverSecret, agentPrincipalKeyInput(documentName,
   * userSub)))`, truncated to {@link AGENT_PRINCIPAL_KEY_LENGTH} characters.
   * Keyed with a server secret (`AGENT_PRINCIPAL_KEY_SECRET`), so nobody who
   * merely knows or guesses a sub can compute or test it; the server tells
   * each signed-in editor its own key over the WebSocket
   * ({@link AgentPrincipalMessage}). Null when the publisher sent none (a
   * server older than this field).
   */
  principalKey: string | null
}

/**
 * The agent field as the server publishes it during the rollout of
 * `principalName` / `principalKey`: plus `onBehalfOf`, which clients older
 * than that change require (without it they show the agent as a plain
 * peer). It now carries the opaque `principalKey`, never the sub — an old
 * client then cannot match it to anyone and says "another collaborator",
 * which is honest. Remove `onBehalfOf` one release after the change, once no
 * old editor tab can still be open. New parsers ignore it.
 */
export interface PeerAgentWireInfo extends PeerAgentInfo {
  /** @deprecated Rollout alias of `principalKey` for pre-change clients. */
  onBehalfOf: string
}

/** Length (base64url characters, 132 bits) of an agent principal key. */
export const AGENT_PRINCIPAL_KEY_LENGTH = 22

/**
 * The message whose HMAC-SHA256 (keyed with the server secret) is the agent
 * principal key of `userSub` on the Hocuspocus document `documentName` (a
 * deck's document name is its id). Scoped to the document, so the same
 * person's agents on two decks carry unrelated keys; domain-separated and
 * versioned, so the MAC is never confused with any other use of the sub.
 * Only the server computes it (agent/presence.ts); v1 was an unkeyed SHA-256
 * that any holder of a sub could recompute.
 */
export function agentPrincipalKeyInput(documentName: string, userSub: string): string {
  return `narrative:agent-principal:v2\n${documentName}\n${userSub}`
}

/** Stateless message type the server sends to tell an editor its own agent principal key. */
export const AGENT_PRINCIPAL_MESSAGE_TYPE = 'narrative.agentPrincipal'

/**
 * Sent by the server over the Hocuspocus connection of a signed-in user,
 * right after it connects (hocuspocus `connected` hook), so the editor can
 * label an agent peer carrying the same `principalKey` "working for you".
 * Never sent to share-link connections: no agent works for them.
 */
export interface AgentPrincipalMessage {
  type: typeof AGENT_PRINCIPAL_MESSAGE_TYPE
  /** The document the key is scoped to (the connection's document name). */
  documentName: string
  principalKey: string
}

const PRINCIPAL_KEY_RE = /^[A-Za-z0-9_-]+$/

/**
 * Parse a stateless payload into an {@link AgentPrincipalMessage}, or null
 * when it is another message, not JSON or malformed. Never throws.
 */
export function parseAgentPrincipalMessage(payload: unknown): AgentPrincipalMessage | null {
  if (typeof payload !== 'string') return null
  let raw: unknown
  try {
    raw = JSON.parse(payload)
  } catch {
    return null
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const m = raw as Record<string, unknown>
  if (m['type'] !== AGENT_PRINCIPAL_MESSAGE_TYPE) return null
  const { documentName, principalKey } = m
  if (typeof documentName !== 'string' || documentName === '' || documentName.length > 256)
    return null
  if (
    typeof principalKey !== 'string' ||
    principalKey.length !== AGENT_PRINCIPAL_KEY_LENGTH ||
    !PRINCIPAL_KEY_RE.test(principalKey)
  )
    return null
  return { type: AGENT_PRINCIPAL_MESSAGE_TYPE, documentName, principalKey }
}

/** Longest user display name shown in a peer label (code points, after sanitising). */
export const PEER_USER_NAME_MAX = 60

// Cc: control characters; Cf: format characters (bidi overrides and
// isolates, zero-width joiners and spaces, the BOM…); plus characters that
// read as markup or quoting in a label.
const PEER_LABEL_STRIP_RE = /[\p{Cc}\p{Cf}<>`"\\{}[\]|]/gu

/**
 * A string made safe to show as (part of) a peer name: control, format and
 * markup characters removed, whitespace collapsed, truncated to `max`
 * characters (code points) with an ellipsis. Empty result → null. Applied by
 * the server to what it publishes and by clients to what they receive
 * (awareness is client-asserted, so a received label is untrusted).
 */
export function sanitizePeerLabel(value: string | null | undefined, max: number): string | null {
  if (typeof value !== 'string') return null
  const cleaned = value
    .normalize('NFC')
    // Whitespace (tabs, newlines, line separators) becomes a space before
    // control characters are stripped, so "a\tb" reads "a b", not "ab".
    .replace(/\s+/gu, ' ')
    .replace(PEER_LABEL_STRIP_RE, '')
    .replace(/\s+/gu, ' ')
    .trim()
  if (cleaned === '') return null
  const chars = Array.from(cleaned)
  return chars.length <= max
    ? cleaned
    : `${chars
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`
}

/**
 * Enriched peer info — Yjs clientId + parsed state + local flag.
 * Output of toPeerInfo() and the useAwareness() hook.
 */
export interface PeerInfo {
  clientId: number
  state: PeerAwarenessState
  /** True only for the local user's own awareness entry. */
  isLocal: boolean
}

// ---------------------------------------------------------------------------
// Color helper
// ---------------------------------------------------------------------------

/**
 * Deterministic HSL colour from a string id.
 *
 * Same input → same output (pure, no randomness). Different ids get
 * different hues (enough spread for ~15 peers).
 *
 * Algorithm: djb2-style hash → hue 0–359, fixed saturation 70%, lightness
 * 55% (good contrast on the dark canvas background).
 */
export function peerColorFromId(id: string): string {
  let hash = 0
  for (const c of id) {
    hash = (hash * 31 + c.charCodeAt(0)) | 0
  }
  const hue = Math.abs(hash) % 360
  return `hsl(${hue}, 70%, 55%)`
}
