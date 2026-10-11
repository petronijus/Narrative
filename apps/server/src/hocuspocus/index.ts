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
 * Auth (M10 phase 2 — see ./authenticate.ts):
 *   onAuthenticate — validates the session cookie or a share_token from WS
 *   query params. Personal access tokens are refused: agents write through
 *   the server host (ADR 0011), never over a raw Yjs connection.
 *   Stores role + userId on connection.context for downstream hooks.
 *   Viewer role: connection is marked readOnly so Hocuspocus rejects their writes at
 *   the protocol level (no client changes broadcast). Additionally,
 *   PostgresPersistence.onStoreDocument checks role and skips persisting viewer updates
 *   as a defense-in-depth measure.
 *
 * Awareness (security review of A1): awarenessOwnership.ts binds client ids
 * to the connection that announced them; awarenessRedaction.ts strips account
 * ids and emails from what read-only / share-link connections receive;
 * agentPrincipal.ts sends each signed-in editor its agent principal key.
 *
 * Doc name routing (M16 P2):
 *   `deck:<id>`   → deck access via resolveDeckAccess (existing path)
 *   `folder:<id>` → its members, and read-only the guests of its decks
 *                   (authenticate.ts)
 *   Legacy bare name → treated as deck id (backward compat)
 */

import { Server } from '@hocuspocus/server'
import type { Database } from '../db/client.js'
import { PostgresPersistence } from './persistence.js'
import { metrics } from '../metrics/index.js'
import { setHocuspocusInstance } from './presence.js'
import { subsystemLogger } from '../observability/logger.js'
import { createOnAuthenticate } from './authenticate.js'
import { awarenessOwnershipExtension } from './awarenessOwnership.js'
import { awarenessRedactionExtension } from './awarenessRedaction.js'
import { agentPrincipalExtension } from './agentPrincipal.js'
import type { AgentPrincipalKeys } from '../agent/presence.js'

const log = subsystemLogger('hocuspocus')

export interface HocuspocusServerOptions {
  port: number
  db: Database
  bypass?: boolean
  /**
   * Header carrying the real client IP behind the proxy chain (production:
   * `cf-connecting-ip`); keys the failed-authentication throttle.
   */
  clientIpHeader?: string | undefined
  /**
   * The agent principal keys (agent/presence.ts, MACed with
   * AGENT_PRINCIPAL_KEY_SECRET) — the same instance the agent runtime uses.
   * Each signed-in editor is told its own key when it connects.
   */
  principalKeys: AgentPrincipalKeys
  /**
   * After a deck's snapshot was stored, off the store's path
   * (PostgresPersistence `onDeckStored`): the server points references an
   * undo brought back to media of a folder the deck has left at the deck's
   * copies again (services/localiseMedia.ts).
   */
  onDeckStored?: (deckId: string) => void
  /** After a component master's snapshot was stored, off the store's path (its card). */
  onComponentStored?: (componentId: string) => void
}

export function createHocuspocusServer(opts: HocuspocusServerOptions) {
  const { db, bypass = false } = opts

  const server = Server.configure({
    port: opts.port,

    extensions: [
      new PostgresPersistence({
        db,
        ...(opts.onDeckStored === undefined ? {} : { onDeckStored: opts.onDeckStored }),
        ...(opts.onComponentStored === undefined
          ? {}
          : { onComponentStored: opts.onComponentStored }),
      }),
      // Binds awareness client ids to the connection (principal) that first
      // announced them, so editor.context never trusts a forged state (M9).
      awarenessOwnershipExtension({ log }),
      // Read-only and share-link connections receive awareness without
      // account ids or email-looking values (defence in depth; editors
      // publish only a random peer id and a display name).
      awarenessRedactionExtension({ log }),
      // Tells each signed-in editor its agent principal key (ADR 0011 point 8).
      agentPrincipalExtension({ principalKeys: opts.principalKeys }),
    ],

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

    // Credential + document-access resolution lives in ./authenticate.ts
    // (session cookie or share token; personal access tokens are refused —
    // agents write through the server host, ADR 0011).
    onAuthenticate: createOnAuthenticate({ db, bypass, clientIpHeader: opts.clientIpHeader }),

    async onConnect(data) {
      metrics.incConnections()
      // userId is populated by onAuthenticate (which runs AFTER
      // onConnect), so presence registration happens there instead.
      log.info({ doc: data.documentName }, 'connect')
    },

    async onDisconnect(data) {
      const ctx = data.context as { userId?: string }
      const userId = ctx.userId ?? 'unknown'
      metrics.decConnections()
      log.info({ doc: data.documentName, user: userId }, 'disconnect')
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
