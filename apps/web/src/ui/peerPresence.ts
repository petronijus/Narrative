/**
 * ui/peerPresence.ts
 *
 * Pure helpers over parsed awareness peers, shared by the avatar chips, the
 * peer selection overlays and the Agent activity button (agentic A1).
 */

import type { PeerInfo } from '@narrative/shared'

/**
 * The part of a peer's selection to draw on the slide this editor shows.
 *
 * A peer that says which slide it is on (`activeSlideId`, since A1 — the
 * agent peer always does) only has its selection drawn on that slide. A
 * peer that does not say (a client older than A1) keeps the previous
 * behaviour: its ids are drawn wherever they resolve in the scene graph,
 * which only ever holds the active slide's objects.
 */
export function peerSelectionOnSlide(peer: PeerInfo, activeSlideId: string | null): string[] {
  const peerSlide = peer.state.activeSlideId
  if (peerSlide === undefined) return peer.state.selectedObjectIds
  if (peerSlide === null || peerSlide !== activeSlideId) return []
  return peer.state.selectedObjectIds
}

/** True for the peer the server publishes for an agent run ("Claude (MCP)"). */
export function isAgentPeer(peer: PeerInfo): boolean {
  return peer.state.agent !== undefined
}

/**
 * Who an agent peer works for, in words: "you" when its principal key is the
 * local user's own (`localPrincipalKey`, which the server tells this editor —
 * state/agentPrincipal.ts), otherwise
 * the display name it carries, or a neutral fallback when it carries none
 * (the user has no profile name, or a server older than the field).
 */
export function agentPrincipalName(agentPeer: PeerInfo, localPrincipalKey: string | null): string {
  const agent = agentPeer.state.agent
  if (agent === undefined) return 'someone'
  if (localPrincipalKey !== null && agent.principalKey === localPrincipalKey) return 'you'
  return agent.principalName ?? 'a collaborator'
}

/** Tooltip / accessible label of an agent peer: "Claude (MCP) — working for you". */
export function agentPeerLabel(agentPeer: PeerInfo, localPrincipalKey: string | null): string {
  return `${agentPeer.state.user.name} — working for ${agentPrincipalName(agentPeer, localPrincipalKey)}`
}
