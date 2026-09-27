/**
 * routes/agentConfirmations.ts — the API behind Narrative's confirmation
 * page (`/confirm/:id`, apps/web pages/ConfirmAgentAction.tsx), where a
 * signed-in user approves or declines an agent call that needs their
 * confirmation (agent/confirmations.ts, docs/mcp.md "Confirmation").
 *
 *   GET  /agent-confirmations/:id            (public: /api/agent-confirmations/:id)
 *     What the call would do — the summary the server built from the exact
 *     call (command title, deck / folder title, recipient and role, download
 *     host), which client asked, when, and its status.
 *   POST /agent-confirmations/:id/decision   body `{ "decision": "approve" | "decline" }`
 *
 * Who may use them — this is the one place a person, not the model, says
 * yes, so both routes are for the signed-in BROWSER only:
 *   - session cookie only (`authPreHandler`): a personal access token gets
 *     403, an MCP OAuth token is not an identity here at all — an agent can
 *     never approve its own request;
 *   - only the user the confirmation was created for sees or decides it;
 *     anyone else gets 404, the same as an unknown id;
 *   - the decision is CSRF-protected: `requireSameOrigin` (the request must
 *     come from Narrative's own origin; SameSite=Lax alone is not enough)
 *     and a JSON body (a cross-site form cannot send one without a CORS
 *     preflight, which the API does not grant). The page itself cannot be
 *     framed (the SPA's CSP has `frame-ancestors 'none'`).
 * Under BYPASS_AUTH (dev only) every cookie-less request is the dev-user,
 * so these checks cannot tell the agent from the person there.
 */

import type { FastifyInstance } from 'fastify'
import { authPreHandler } from '../auth/fastifyAuth.js'
import { requireSameOrigin } from '../http/sameOrigin.js'
import type { AgentConfirmations } from '../agent/confirmations.js'

export async function registerAgentConfirmationRoutes(
  app: FastifyInstance,
  deps: { confirmations: () => AgentConfirmations },
): Promise<void> {
  app.get<{ Params: { id: string } }>(
    '/agent-confirmations/:id',
    { preHandler: [authPreHandler] },
    async (req, reply) => {
      const view = deps.confirmations().viewForUser(req.params.id, req.user!.sub)
      if (view === null)
        return reply.status(404).header('cache-control', 'no-store').send({ error: 'not_found' })
      return reply.header('cache-control', 'no-store').send(view)
    },
  )

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/agent-confirmations/:id/decision',
    { preHandler: [requireSameOrigin, authPreHandler] },
    async (req, reply) => {
      const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
      const body = req.body as { decision?: unknown } | null | undefined
      const decision = typeof body === 'object' && body !== null ? body.decision : undefined
      if (type !== 'application/json' || (decision !== 'approve' && decision !== 'decline')) {
        return reply.status(400).send({
          error: 'invalid_request',
          message: 'Send a JSON body {"decision": "approve"} or {"decision": "decline"}.',
        })
      }
      const userSub = req.user!.sub
      const result = deps.confirmations().decide(req.params.id, userSub, decision === 'approve')
      if (!result.ok) {
        if (result.reason === 'not_found') return reply.status(404).send({ error: 'not_found' })
        return reply.status(409).send({
          error: result.reason,
          message:
            result.reason === 'expired'
              ? 'This request has expired. Ask the agent to try again.'
              : 'This request was already answered.',
          ...(result.view === undefined ? {} : { confirmation: result.view }),
        })
      }
      req.log.info(
        {
          confirmation: req.params.id,
          user: userSub,
          decision,
          command: result.view.summary.commandId,
        },
        'agent confirmation decided',
      )
      return reply.header('cache-control', 'no-store').send(result.view)
    },
  )
}
