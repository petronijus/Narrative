/**
 * routes/folderSharing.ts
 *
 * Folder sharing (docs/plans/folder-sharing.md, step 3): the members of a
 * folder and its pending email invites. A member sees everything in the
 * folder with their role. Every endpoint needs the owner role in the folder;
 * the service checks it (403 / 404 "Folder not found").
 *
 * Endpoints:
 *   GET    /folders/:id/members           → list members (with email + name)
 *   POST   /folders/:id/members           → invite { email, role }
 *                                             - a known user becomes a member at
 *                                               once (200 {kind:'granted', user})
 *                                             - an unknown address gets a pending
 *                                               invite and an email
 *                                               (201 {kind:'pending', invite})
 *                                             - 409 for the Drafts folder
 *   PATCH  /folders/:id/members/:userId   → change a member's role { role }
 *   DELETE /folders/:id/members/:userId   → remove a member (409 for yourself
 *                                             or the last owner)
 *   GET    /folders/:id/invites           → list pending email invites
 *   DELETE /folders/:id/invites/:inviteId → cancel a pending invite
 *
 * The handlers call services/folderSharing.ts — the same code the
 * `folder.members.*` / `folder.invites.*` agent commands run (ADR 0010).
 */

import type { FastifyBaseLogger, FastifyInstance } from 'fastify'
import type { Database } from '../db/client.js'
import { authPreHandler } from '../auth/fastifyAuth.js'
import type { DeckRole } from '../auth/permissions.js'
import { createFolderSharingService } from '../services/folderSharing.js'
import { routeDeps } from '../services/http.js'
import { sendServiceError } from '../services/errors.js'
import { inviteRouteRateLimit } from '../http/rateLimit.js'

const ROLE_VALUES = ['owner', 'editor', 'viewer'] as const

// RFC-5322-lite, as routes/sharing.ts; the service validates again.
const EMAIL_PATTERN = '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$'

const inviteSchema = {
  body: {
    type: 'object',
    required: ['email', 'role'],
    additionalProperties: false,
    properties: {
      email: { type: 'string', minLength: 3, maxLength: 320, pattern: EMAIL_PATTERN },
      role: { type: 'string', enum: ROLE_VALUES },
    },
  },
}

const setRoleSchema = {
  body: {
    type: 'object',
    required: ['role'],
    additionalProperties: false,
    properties: { role: { type: 'string', enum: ROLE_VALUES } },
  },
}

export async function registerFolderSharingRoutes(
  app: FastifyInstance,
  db: Database,
): Promise<void> {
  const service = (log: FastifyBaseLogger) => createFolderSharingService(routeDeps(app, db, log))

  app.get<{ Params: { id: string } }>(
    '/folders/:id/members',
    { preHandler: authPreHandler },
    async (request, reply) => {
      try {
        return reply.send(
          await service(request.log).listMembers({
            userId: request.user!.sub,
            folderId: request.params.id,
          }),
        )
      } catch (err) {
        return sendServiceError(reply, err)
      }
    },
  )

  app.post<{ Params: { id: string }; Body: { email: string; role: DeckRole } }>(
    '/folders/:id/members',
    { schema: inviteSchema, preHandler: authPreHandler, config: inviteRouteRateLimit },
    async (request, reply) => {
      try {
        const result = await service(request.log).invite({
          userId: request.user!.sub,
          folderId: request.params.id,
          email: request.body.email,
          role: request.body.role,
        })
        return reply.status(result.kind === 'granted' ? 200 : 201).send(result)
      } catch (err) {
        return sendServiceError(reply, err)
      }
    },
  )

  app.patch<{ Params: { id: string; userId: string }; Body: { role: DeckRole } }>(
    '/folders/:id/members/:userId',
    { schema: setRoleSchema, preHandler: authPreHandler },
    async (request, reply) => {
      try {
        return reply.send(
          await service(request.log).setRole({
            userId: request.user!.sub,
            folderId: request.params.id,
            memberId: request.params.userId,
            role: request.body.role,
          }),
        )
      } catch (err) {
        return sendServiceError(reply, err)
      }
    },
  )

  app.delete<{ Params: { id: string; userId: string } }>(
    '/folders/:id/members/:userId',
    { preHandler: authPreHandler },
    async (request, reply) => {
      try {
        await service(request.log).removeMember({
          userId: request.user!.sub,
          folderId: request.params.id,
          memberId: request.params.userId,
        })
        return reply.status(204).send()
      } catch (err) {
        return sendServiceError(reply, err)
      }
    },
  )

  app.get<{ Params: { id: string } }>(
    '/folders/:id/invites',
    { preHandler: authPreHandler },
    async (request, reply) => {
      try {
        return reply.send(
          await service(request.log).listInvites({
            userId: request.user!.sub,
            folderId: request.params.id,
          }),
        )
      } catch (err) {
        return sendServiceError(reply, err)
      }
    },
  )

  app.delete<{ Params: { id: string; inviteId: string } }>(
    '/folders/:id/invites/:inviteId',
    { preHandler: authPreHandler },
    async (request, reply) => {
      try {
        await service(request.log).cancelInvite({
          userId: request.user!.sub,
          folderId: request.params.id,
          inviteId: request.params.inviteId,
        })
        return reply.status(204).send()
      } catch (err) {
        return sendServiceError(reply, err)
      }
    },
  )
}
