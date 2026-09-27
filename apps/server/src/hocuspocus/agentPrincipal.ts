/**
 * hocuspocus/agentPrincipal.ts
 *
 * Tells each signed-in editor its own agent principal key (ADR 0011 point 8,
 * PeerAgentInfo.principalKey in @narrative/shared), so it can label an agent
 * peer that carries the same key "working for you".
 *
 * The key is an HMAC keyed with a server secret (agent/presence.ts), so the
 * browser cannot compute it from its sub any more. Instead, once a connection
 * is established (the `connected` hook, after onAuthenticate), the server
 * sends that connection — and only it — a stateless message:
 *
 *   { "type": "narrative.agentPrincipal", "documentName": "<doc>", "principalKey": "<key>" }
 *
 * Sent only to connections of a real user: never to a share-link connection
 * (its `userId` is the `share:<prefix>` display id, and no agent works for an
 * anonymous viewer), and never on folder documents (agents do not show up
 * there). The key is scoped to the connection's document name, exactly as the
 * agent presence computes it from `document.name`.
 */

import type { Extension, connectedPayload } from '@hocuspocus/server'
import { AGENT_PRINCIPAL_MESSAGE_TYPE, type AgentPrincipalMessage } from '@narrative/shared'
import type { AgentPrincipalKeys } from '../agent/presence.js'

/**
 * The message for a connection with `context` on `documentName`, or null when
 * the connection is not a signed-in user's editor of a deck or component.
 */
export function agentPrincipalMessageFor(
  keys: AgentPrincipalKeys,
  documentName: string,
  context: unknown,
): AgentPrincipalMessage | null {
  if (documentName.startsWith('folder:')) return null
  const ctx = (context ?? {}) as { userId?: unknown; shareToken?: unknown }
  if (typeof ctx.shareToken === 'string' && ctx.shareToken !== '') return null
  const userId = ctx.userId
  if (typeof userId !== 'string' || userId === '' || userId.startsWith('share:')) return null
  return {
    type: AGENT_PRINCIPAL_MESSAGE_TYPE,
    documentName,
    principalKey: keys.keyFor(documentName, userId),
  }
}

/** The Hocuspocus extension that sends the message on every new connection. */
export function agentPrincipalExtension(opts: { principalKeys: AgentPrincipalKeys }): Extension {
  return {
    async connected({
      documentName,
      context,
      connectionInstance,
    }: connectedPayload): Promise<void> {
      const message = agentPrincipalMessageFor(opts.principalKeys, documentName, context)
      if (message !== null) connectionInstance.sendStateless(JSON.stringify(message))
    },
  }
}
