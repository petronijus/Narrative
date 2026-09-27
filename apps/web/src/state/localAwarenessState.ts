/**
 * state/localAwarenessState.ts
 *
 * The shape of this tab's own awareness entry, in one place, for the deck
 * provider (Hocuspocus) and the local-only master-editor provider.
 */

import {
  PEER_USER_NAME_MAX,
  peerColorFromId,
  sanitizePeerLabel,
  type PeerAwarenessState,
  type PeerUser,
} from '@narrative/shared'

/**
 * This tab's peer identity as published in awareness (security review of
 * A1, 2026-09-27). Awareness is broadcast to every connection of a deck,
 * anonymous share-link viewers included, so it carries no account data:
 *   - `id` is the random per-tab peer id (sessionStorage), never the Google
 *     `sub` — nothing reads it as an account id; the server knows whose state
 *     is whose from the connection (hocuspocus/awarenessOwnership.ts);
 *   - `name` is the profile name, sanitised like every peer label, or a
 *     neutral "User <first 4 characters of the peer id>" — never the email;
 *   - `color` is derived from the peer id.
 */
export function localPeerUser(peerId: string, profileName: string | null | undefined): PeerUser {
  return {
    id: peerId,
    name: sanitizePeerLabel(profileName, PEER_USER_NAME_MAX) ?? `User ${peerId.slice(0, 4)}`,
    color: peerColorFromId(peerId),
  }
}

/**
 * The local awareness state to (re)publish on connect.
 *
 * Hocuspocus drops the local state when the socket closes, so a reconnect
 * used to publish a blank `{ user, selectedObjectIds: [], cursor: null }` —
 * peers lost this tab's selection, and (since agentic A1) the server's
 * `editor.context` lost its active slide, until the user happened to change
 * either. Carry both over from the last state this tab published. The cursor
 * is not carried: it goes stale the moment the pointer moves.
 */
export function restoredLocalState(
  user: PeerUser,
  previous: Partial<PeerAwarenessState> | null,
): PeerAwarenessState {
  return {
    user,
    selectedObjectIds: Array.isArray(previous?.selectedObjectIds) ? previous.selectedObjectIds : [],
    cursor: null,
    activeSlideId: typeof previous?.activeSlideId === 'string' ? previous.activeSlideId : null,
  }
}
