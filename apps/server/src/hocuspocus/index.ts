/**
 * hocuspocus/index.ts
 *
 * Factory for the Hocuspocus WebSocket sync server.
 * Runs on a separate port (default 3002) alongside the Fastify HTTP API (3001).
 *
 * In production Caddy routes both via one domain:
 *   /ws/* → hocuspocus:3002
 *   /*    → api:3001 or web
 *
 * Auth (M10 phase 2):
 *   onAuthenticate — validates JWT Bearer token OR share_token from WS query params.
 *   Stores role + userId on connection.context for downstream hooks.
 *   Viewer role: connection is marked readOnly so Hocuspocus rejects their writes at
 *   the protocol level (no client changes broadcast). Additionally,
 *   PostgresPersistence.onStoreDocument checks role and skips persisting viewer updates
 *   as a defense-in-depth measure.
 *
 * Doc name routing (M16 P2):
 *   `deck:<id>`   → deck access via resolveDeckAccess (existing path)
 *   `folder:<id>` → folder access via resolveFolderAccess (owner-only, no share-link)
 *   Legacy bare name → treated as deck id (backward compat)
 */

import { Server } from '@hocuspocus/server'
import * as Y from 'yjs'
import type { Database } from '../db/client.js'
import { PostgresPersistence } from './persistence.js'
import { metrics } from '../metrics/index.js'
import type { JwtVerifier } from '../auth/jwt.js'
import {
  resolveDeckAccess,
  resolveFolderAccess,
  resolveComponentAccess,
} from '../auth/permissions.js'

export interface HocuspocusServerOptions {
  port: number
  db: Database
  verifier: JwtVerifier | null
  bypass?: boolean
}

export function createHocuspocusServer(opts: HocuspocusServerOptions) {
  const { db, verifier, bypass = false } = opts

  const server = Server.configure({
    port: opts.port,

    extensions: [new PostgresPersistence({ db })],

    async onAuthenticate(data) {
      const { documentName, token, connection, requestParameters } = data

      // Share token may arrive as a query param in the WS upgrade URL.
      // e.g. ws://host:3002?share_token=<id>
      // HocuspocusProvider appends query params to the WS URL and Hocuspocus
      // exposes them as `requestParameters: URLSearchParams` in the payload.
      const shareToken = requestParameters.get('share_token')

      let userId: string | null = null

      if (shareToken) {
        // Share-token access — skip JWT validation entirely.
        // resolveDeckAccess will validate the token below.
        // Note: folder docs do NOT support share-token access.
      } else if (bypass) {
        userId = 'dev-user'
      } else if (token) {
        if (!verifier) {
          // Should never happen: verifier is null only in bypass mode.
          throw new Error('Invalid credentials')
        }
        try {
          const payload = await verifier.verify(token)
          userId = payload.sub
        } catch {
          throw new Error('Invalid credentials')
        }
      } else {
        // No token and no share_token → deny
        throw new Error('Invalid credentials')
      }

      // ---------------------------------------------------------------------------
      // Route auth by doc name prefix
      // ---------------------------------------------------------------------------

      if (documentName.startsWith('folder:')) {
        // Folder doc — owner-only, no share-link support.
        const folderId = documentName.slice('folder:'.length)

        if (!userId) {
          // Share-token path reached for a folder doc — not allowed.
          throw new Error('Forbidden')
        }

        const access = await resolveFolderAccess(db, { folderId, userId })
        if (!access) {
          throw new Error('Forbidden')
        }

        data.context.userId = userId
        data.context.folderId = folderId
        data.context.role = access.role

        // Folders are always read-write for the owner.
        connection.readOnly = false

        console.log(
          `[hocuspocus] authenticate → doc=${documentName} user=${userId} role=${access.role} reason=${access.reason}`,
        )
        return
      }

      if (documentName.startsWith('component:')) {
        // Component doc — owner-only (folder owner), no share-link support.
        const componentId = documentName.slice('component:'.length)

        if (!userId) {
          throw new Error('Forbidden')
        }

        const access = await resolveComponentAccess(db, { componentId, userId })
        if (!access) {
          throw new Error('Forbidden')
        }

        data.context.userId = userId
        data.context.componentId = componentId
        data.context.role = access.role

        connection.readOnly = false

        console.log(
          `[hocuspocus] authenticate → doc=${documentName} user=${userId} role=${access.role} reason=${access.reason}`,
        )
        return
      }

      // Deck doc (deck:<id> prefix or legacy bare id)
      const access = await resolveDeckAccess(db, {
        deckId: documentName,
        userId,
        shareToken,
      })

      if (!access) {
        throw new Error('Forbidden')
      }

      const displayId = userId ?? `share:${shareToken?.slice(0, 8)}`

      // Mutate context — Hocuspocus merges the returned value into context
      // and passes it to all subsequent hooks (onConnect, onStoreDocument, etc).

      data.context.userId = displayId

      data.context.deckId = documentName

      data.context.role = access.role

      // Mark connection as readOnly for viewer role.
      // Hocuspocus won't accept update messages from readOnly connections.
      connection.readOnly = access.role === 'viewer'

      console.log(
        `[hocuspocus] authenticate → doc=${documentName} user=${displayId} role=${access.role} reason=${access.reason}`,
      )
    },

    async onConnect(data) {
      metrics.incConnections()
      // userId will be set in onAuthenticate; log connection attempt here.
      console.log(`[hocuspocus] connect → doc=${data.documentName}`)
    },

    async onDisconnect(data) {
      const ctx = data.context as { userId?: string }
      const userId = ctx.userId ?? 'unknown'
      metrics.decConnections()
      console.log(`[hocuspocus] disconnect → doc=${data.documentName} user=${userId}`)
    },

    async onStoreDocument(data) {
      // Record metrics — onStoreDocument is per-flush, not per-update.
      const encoded = Y.encodeStateAsUpdate(data.document)
      metrics.recordUpdate(encoded.byteLength)
    },
  })

  return server
}
