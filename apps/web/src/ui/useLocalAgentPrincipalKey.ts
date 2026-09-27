/**
 * ui/useLocalAgentPrincipalKey.ts
 *
 * The signed-in user's agent principal key on the document this editor is
 * synced to, so the peer chips can say "Claude (MCP) — working for you". The
 * server computes it (an HMAC with a server secret) and sends it over the
 * deck's WebSocket when the editor connects (state/agentPrincipal.ts). Null
 * until it arrives, for a share-link viewer (no agent can work for them), and
 * for a local-only document (no server, no agent peers).
 */

import { useAgentPrincipalKeyFor } from '../state/agentPrincipal.js'
import { useSlideDoc } from '../state/useSlideDoc.js'

export function useLocalAgentPrincipalKey(): string | null {
  const { documentName } = useSlideDoc()
  return useAgentPrincipalKeyFor(documentName)
}
