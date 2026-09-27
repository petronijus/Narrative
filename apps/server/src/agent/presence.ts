/**
 * agent/presence.ts
 *
 * The agent as a peer in the deck's awareness (plan §4.5, ADR 0011 point 8):
 * while a run works on a deck, people see it in the peer chips, with its own
 * colour, and its selection is whatever its last command touched — they
 * watch it work the way they watch a colleague.
 *
 * Its name (`agentPeerName`): an MCP run is "Claude (MCP)"; a command-API
 * run is "<user's display name>'s agent (<client>)". Both parts are
 * sanitised (`sanitizePeerLabel`): the client name is whatever the caller
 * sent, and the display name comes from the Google profile, so control
 * characters, bidi overrides / invisible format characters and markup
 * characters are removed, whitespace collapsed, and each part truncated —
 * a peer label can neither spoof another person nor flood the chips. The
 * Google `sub` is never used as a name.
 *
 * Whom it works for (`agent`, PeerAgentInfo): the user's display name and an
 * opaque key scoped to the document (`AgentPrincipalKeys.keyFor`) that only
 * that user's editor is told is theirs ("working for you"). No sub and no
 * email: awareness is broadcast to every connection, share-link viewers
 * included.
 *
 * The key is an HMAC-SHA256 keyed with a server secret
 * (`AGENT_PRINCIPAL_KEY_SECRET`, agent/principalKeySecret.ts) over
 * `agentPrincipalKeyInput(documentName, sub)` — not a bare hash, which
 * anyone who knows (or can enumerate) a sub could recompute to find out
 * whom an agent works for. Browsers therefore cannot compute it; the server
 * sends each signed-in editor its own key over the WebSocket when it
 * connects (hocuspocus/agentPrincipal.ts).
 *
 * Mechanism: the awareness instance Hocuspocus keeps on every server-side
 * `Document`. Its local state is broadcast to every connection of the
 * document (Hocuspocus forwards awareness updates whose origin is not a
 * connection to all of them) and renewed by y-protocols' own heartbeat, so
 * the peer does not time out on clients while the run is active.
 *
 * Known limit: that awareness instance has ONE client id per document (the
 * document's own). So a document shows at most one agent peer: when two runs
 * work on the same deck at once, the peer follows whichever acted last. The
 * state names the run (`agent.runId`), so this never misattributes a
 * selection, it only hides the quieter agent.
 */

import { createHmac } from 'node:crypto'
import type { Document } from '@hocuspocus/server'
import {
  AGENT_PRINCIPAL_KEY_LENGTH,
  PEER_USER_NAME_MAX,
  agentPrincipalKeyInput,
  peerColorFromId,
  sanitizePeerLabel,
  type PeerAgentWireInfo,
  type PeerAwarenessState,
} from '@narrative/shared'
import type { Touched } from './touched.js'

/** How long an agent peer stays visible after its last command. */
export const AGENT_PRESENCE_IDLE_MS = 2 * 60_000

/** Longest client name shown in a peer label (characters, after sanitising). */
export const PEER_CLIENT_NAME_MAX = 40
/** Used when the user has no display name on record. */
export const PEER_UNKNOWN_USER = 'Someone'

export interface AgentPeerRun {
  runId: string
  userId: string
  /** The user's display name (`users.name`), when known. Never the sub. */
  userName: string | null
  surface: 'mcp' | 'api'
  clientName: string | null
}

// The sanitiser and the name limit live in @narrative/shared, because
// clients re-apply them to what they receive; re-exported for callers here.
export { PEER_USER_NAME_MAX, sanitizePeerLabel }

/**
 * Computes agent principal keys (PeerAgentInfo.principalKey) with the
 * server's secret. One instance per process, shared by the agent presence
 * and the WebSocket server that tells each editor its own key.
 */
export interface AgentPrincipalKeys {
  /** The opaque key of `userSub` on `documentName`. */
  keyFor(documentName: string, userSub: string): string
}

/** Shortest accepted secret (characters). */
export const AGENT_PRINCIPAL_KEY_SECRET_MIN_LENGTH = 32

export function createAgentPrincipalKeys(secret: string): AgentPrincipalKeys {
  if (secret.length < AGENT_PRINCIPAL_KEY_SECRET_MIN_LENGTH) {
    throw new Error(
      `the agent principal key secret must be at least ${AGENT_PRINCIPAL_KEY_SECRET_MIN_LENGTH} characters`,
    )
  }
  return {
    keyFor(documentName, userSub) {
      return createHmac('sha256', secret)
        .update(agentPrincipalKeyInput(documentName, userSub), 'utf8')
        .digest('base64url')
        .slice(0, AGENT_PRINCIPAL_KEY_LENGTH)
    },
  }
}

/**
 * The `agent` field of the peer (see PeerAgentInfo): the display name and
 * the document-scoped key of the user — never their sub or email, because
 * awareness reaches anonymous share-link viewers too. `onBehalfOf` repeats
 * the key for editors older than these fields (PeerAgentWireInfo).
 */
export function agentPeerInfo(
  keys: AgentPrincipalKeys,
  documentName: string,
  run: Pick<AgentPeerRun, 'runId' | 'userId' | 'userName' | 'surface'>,
): PeerAgentWireInfo {
  const principalKey = keys.keyFor(documentName, run.userId)
  return {
    runId: run.runId,
    surface: run.surface,
    principalName: sanitizePeerLabel(run.userName, PEER_USER_NAME_MAX),
    principalKey,
    onBehalfOf: principalKey,
  }
}

export function agentPeerName(
  run: Pick<AgentPeerRun, 'surface' | 'clientName' | 'userName'>,
): string {
  if (run.surface === 'mcp') return 'Claude (MCP)'
  const user = sanitizePeerLabel(run.userName, PEER_USER_NAME_MAX) ?? PEER_UNKNOWN_USER
  const client = sanitizePeerLabel(run.clientName, PEER_CLIENT_NAME_MAX) ?? 'API'
  return `${user}'s agent (${client})`
}

interface Shown {
  runId: string
  timer: ReturnType<typeof setTimeout>
}

export interface AgentPresence {
  /** Show (or move) the agent peer of `run` on `document`. */
  show(document: Document, run: AgentPeerRun, touched: Touched): void
  /** Remove the agent peer of `runId` wherever it is shown. */
  clearRun(runId: string): void
  /** Remove every agent peer (shutdown). */
  clearAll(): void
}

export function createAgentPresence(opts: {
  principalKeys: AgentPrincipalKeys
  idleMs?: number
}): AgentPresence {
  const idleMs = opts.idleMs ?? AGENT_PRESENCE_IDLE_MS
  const keys = opts.principalKeys
  const shown = new Map<Document, Shown>()
  /** Documents whose destroy we already listen for (one listener each). */
  const watched = new WeakSet<Document>()

  const clear = (document: Document): void => {
    const entry = shown.get(document)
    if (entry === undefined) return
    clearTimeout(entry.timer)
    shown.delete(document)
    if (!document.isDestroyed) document.awareness.setLocalState(null)
  }

  return {
    show(document, run, touched) {
      if (document.isDestroyed) return
      const previous = shown.get(document)
      if (previous !== undefined) clearTimeout(previous.timer)
      const current = document.awareness.getLocalState() as PeerAwarenessState | null
      const state: PeerAwarenessState = {
        user: {
          id: `agent:${run.runId}`,
          name: agentPeerName(run),
          // Colour by the user the agent works for, so two people's agents
          // differ — from the document-scoped key, not the sub, so even the
          // colour is not a stable cross-deck fingerprint.
          color: peerColorFromId(`agent:${keys.keyFor(document.name, run.userId)}`),
        },
        // Keep the previous slide/selection when a command touched nothing
        // visible (a query, a guide), instead of blanking the peer.
        selectedObjectIds:
          touched.slideId !== null
            ? touched.objectIds
            : previous?.runId === run.runId
              ? (current?.selectedObjectIds ?? [])
              : [],
        cursor: null,
        activeSlideId:
          touched.slideId ??
          (previous?.runId === run.runId ? (current?.activeSlideId ?? null) : null),
        agent: agentPeerInfo(keys, document.name, run),
      }
      document.awareness.setLocalState(state)
      const timer = setTimeout(() => clear(document), idleMs)
      timer.unref?.()
      shown.set(document, { runId: run.runId, timer })
      if (!watched.has(document)) {
        watched.add(document)
        // A destroyed (unloaded) document takes its awareness with it.
        document.once('destroy', () => {
          const entry = shown.get(document)
          if (entry !== undefined) clearTimeout(entry.timer)
          shown.delete(document)
        })
      }
    },

    clearRun(runId) {
      for (const [document, entry] of [...shown.entries()]) {
        if (entry.runId === runId) clear(document)
      }
    },

    clearAll() {
      for (const document of [...shown.keys()]) clear(document)
    },
  }
}
