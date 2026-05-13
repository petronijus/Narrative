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
import type { Database } from '../db/client.js'
import { PostgresPersistence } from './persistence.js'
import { metrics } from '../metrics/index.js'
import {
  resolveDeckAccess,
  resolveFolderAccess,
  resolveComponentAccess,
} from '../auth/permissions.js'
import { lookupSession, readCookieFromHeader, SESSION_COOKIE_NAME } from '../auth/session.js'
import { setHocuspocusInstance } from './presence.js'

export interface HocuspocusServerOptions {
  port: number
  db: Database
  bypass?: boolean
}

export function createHocuspocusServer(opts: HocuspocusServerOptions) {
  const { db, bypass = false } = opts

  const server = Server.configure({
    port: opts.port,

    extensions: [new PostgresPersistence({ db })],

    // Doc lifecycle — Hocuspocus auto-unloads docs when their last connection
    // drops, so the in-memory `documents` map can't grow unboundedly across
    // many decks visited in one session. We keep the defaults but make them
    // explicit so tuning is centralised:
    //
    // - `unloadImmediately: false` waits for the pending onStoreDocument
    //   debounce window to elapse before unloading. Without this a fast
    //   connect → edit → disconnect can race the persistence write and lose
    //   the in-flight update (the doc unloads while the debounced flush is
    //   still queued).
    // - `debounce`/`maxDebounce` defaults give us up to 2 s coalescing of
    //   onChange events into a single onStoreDocument flush, capped at 10 s
    //   so a user typing continuously can't postpone the flush forever.
    unloadImmediately: false,
    debounce: 2_000,
    maxDebounce: 10_000,

    async onAuthenticate(data) {
      const { documentName, connection, requestParameters, requestHeaders } = data

      // Share token may arrive as a query param in the WS upgrade URL.
      // e.g. ws://host:3002?share_token=<id>
      // HocuspocusProvider appends query params to the WS URL and Hocuspocus
      // exposes them as `requestParameters: URLSearchParams` in the payload.
      const shareToken = requestParameters.get('share_token')

      let userId: string | null = null

      if (shareToken) {
        // Share-token access — skip session validation entirely.
        // resolveDeckAccess will validate the token below.
        // Note: folder docs do NOT support share-token access.
      } else if (bypass) {
        userId = 'dev-user'
      } else {
        // Authenticated path: read the narrative_session cookie from the WS
        // upgrade request. Browsers send same-origin cookies on WebSocket
        // upgrades automatically — no token argument needed from the client.
        const rawId = readCookieFromHeader(requestHeaders['cookie'], SESSION_COOKIE_NAME)
        if (!rawId) throw new Error('Invalid credentials')
        const session = await lookupSession(db, rawId)
        if (!session) throw new Error('Invalid credentials')
        userId = session.userSub
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
      // userId is populated by onAuthenticate (which runs AFTER
      // onConnect), so presence registration happens there instead.
      console.log(`[hocuspocus] connect → doc=${data.documentName}`)
    },

    async onDisconnect(data) {
      const ctx = data.context as { userId?: string }
      const userId = ctx.userId ?? 'unknown'
      metrics.decConnections()
      console.log(`[hocuspocus] disconnect → doc=${data.documentName} user=${userId}`)
    },

    async onChange(data) {
      // Per-update metric — counts each incremental update as the client sends it.
      // Hocuspocus provides the raw update buffer in `data.update`; previously
      // we re-encoded the full doc state in onStoreDocument which was O(doc-size)
      // on every flush and dominated CPU on large decks.
      metrics.recordUpdate(data.update.byteLength)
    },
  })

  // Register the live instance so the /folders/:id/active-editors
  // route can read presence directly off Hocuspocus' connection map.
  setHocuspocusInstance(server)

  return server
}
