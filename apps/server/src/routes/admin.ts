/**
 * routes/admin.ts
 *
 * Instance admins (docs/adr/0014): who uses Narrative and who may sign in.
 * Every endpoint needs the admin role; the service checks it (403).
 *
 * Endpoints:
 *   GET    /admin/users                → everyone who has signed in
 *   PATCH  /admin/users/:userId        → { isAdmin } make or unmake an admin
 *                                          (409 for yourself or the last admin)
 *   GET    /admin/allowed-emails       → the addresses an admin allowed
 *   POST   /admin/allowed-emails       → { email } allow an address (idempotent)
 *   GET    /admin/emails               → every kind of email, and whether it is on
 *   PATCH  /admin/emails/:kind         → { enabled } turn a kind on or off
 *   GET    /admin/emails/:kind/preview → { subject, html } with sample data
 *   DELETE /admin/allowed-emails/:email → take an address off the list,
 *                                          { signedOut } when nothing else admits them
 *
 * The handlers call services/admin.ts. There are deliberately no agent
 * commands for any of this (parity/allowlist.ts, ADR 0015), and the auth
 * pre-handler refuses access tokens here. Writes also need the app's own
 * origin (`requireSameOrigin`), like the command API.
 */

import type { FastifyBaseLogger, FastifyInstance } from 'fastify'
import type { Database } from '../db/client.js'
import { authPreHandler } from '../auth/fastifyAuth.js'
import { createAdminService } from '../services/admin.js'
import { routeDeps } from '../services/http.js'
import { sendServiceError } from '../services/errors.js'
import { requireSameOrigin } from '../http/sameOrigin.js'
import type { AllowlistConfig } from '../auth/jwt.js'

// RFC-5322-lite, as routes/sharing.ts; the service validates again.
const EMAIL_PATTERN = '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$'

const allowSchema = {
  body: {
    type: 'object',
    required: ['email'],
    additionalProperties: false,
    properties: {
      email: { type: 'string', minLength: 3, maxLength: 320, pattern: EMAIL_PATTERN },
    },
  },
}

const emailEnabledSchema = {
  body: {
    type: 'object',
    required: ['enabled'],
    additionalProperties: false,
    properties: { enabled: { type: 'boolean' } },
  },
}

const setAdminSchema = {
  body: {
    type: 'object',
    required: ['isAdmin'],
    additionalProperties: false,
    properties: { isAdmin: { type: 'boolean' } },
  },
}

export async function registerAdminRoutes(
  app: FastifyInstance,
  db: Database,
  allowlist: AllowlistConfig,
): Promise<void> {
  const service = (log: FastifyBaseLogger) =>
    createAdminService(routeDeps(app, db, log), { allowlist })

  app.get('/admin/users', { preHandler: authPreHandler }, async (request, reply) => {
    try {
      return reply.send(await service(request.log).listUsers({ userId: request.user!.sub }))
    } catch (err) {
      return sendServiceError(reply, err)
    }
  })

  app.patch<{ Params: { userId: string }; Body: { isAdmin: boolean } }>(
    '/admin/users/:userId',
    { schema: setAdminSchema, preHandler: [requireSameOrigin, authPreHandler] },
    async (request, reply) => {
      try {
        return reply.send(
          await service(request.log).setAdmin({
            userId: request.user!.sub,
            targetUserId: request.params.userId,
            isAdmin: request.body.isAdmin,
          }),
        )
      } catch (err) {
        return sendServiceError(reply, err)
      }
    },
  )

  app.get('/admin/allowed-emails', { preHandler: authPreHandler }, async (request, reply) => {
    try {
      return reply.send(await service(request.log).listAllowedEmails({ userId: request.user!.sub }))
    } catch (err) {
      return sendServiceError(reply, err)
    }
  })

  app.post<{ Body: { email: string } }>(
    '/admin/allowed-emails',
    { schema: allowSchema, preHandler: [requireSameOrigin, authPreHandler] },
    async (request, reply) => {
      try {
        return reply.send(
          await service(request.log).allowEmail({
            userId: request.user!.sub,
            email: request.body.email,
          }),
        )
      } catch (err) {
        return sendServiceError(reply, err)
      }
    },
  )

  app.delete<{ Params: { email: string } }>(
    '/admin/allowed-emails/:email',
    { preHandler: [requireSameOrigin, authPreHandler] },
    async (request, reply) => {
      try {
        return reply.send(
          await service(request.log).removeAllowedEmail({
            userId: request.user!.sub,
            email: request.params.email,
          }),
        )
      } catch (err) {
        return sendServiceError(reply, err)
      }
    },
  )

  app.get('/admin/emails', { preHandler: authPreHandler }, async (request, reply) => {
    try {
      return reply.send(await service(request.log).listEmails({ userId: request.user!.sub }))
    } catch (err) {
      return sendServiceError(reply, err)
    }
  })

  app.patch<{ Params: { kind: string }; Body: { enabled: boolean } }>(
    '/admin/emails/:kind',
    { schema: emailEnabledSchema, preHandler: [requireSameOrigin, authPreHandler] },
    async (request, reply) => {
      try {
        return reply.send(
          await service(request.log).setEmailEnabled({
            userId: request.user!.sub,
            kind: request.params.kind,
            enabled: request.body.enabled,
          }),
        )
      } catch (err) {
        return sendServiceError(reply, err)
      }
    },
  )

  app.get<{ Params: { kind: string } }>(
    '/admin/emails/:kind/preview',
    { preHandler: authPreHandler },
    async (request, reply) => {
      try {
        return reply.send(
          await service(request.log).previewEmail({
            userId: request.user!.sub,
            kind: request.params.kind,
          }),
        )
      } catch (err) {
        return sendServiceError(reply, err)
      }
    },
  )
}
