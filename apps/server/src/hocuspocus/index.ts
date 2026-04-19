/**
 * hocuspocus/index.ts
 *
 * Factory pro Hocuspocus WebSocket sync server.
 * Běží na separátním portu (default 3002) vedle Fastify HTTP API (3001).
 *
 * V produkci Caddy routuje oba přes jednu doménu:
 *   /ws/* → hocuspocus:3002
 *   /*    → api:3001 nebo web
 *
 * Security (M4):
 *   Žádný auth — všichni klienti mají write access k libovolnému decku.
 *   TODO(M10): JWT validation v onAuthenticate hook
 */

import { Server } from '@hocuspocus/server'
import * as Y from 'yjs'
import type { Database } from '../db/client.js'
import { PostgresPersistence } from './persistence.js'
import { metrics } from '../metrics/index.js'

export interface HocuspocusServerOptions {
  port: number
  db: Database
}

export function createHocuspocusServer(opts: HocuspocusServerOptions) {
  const server = Server.configure({
    port: opts.port,

    extensions: [new PostgresPersistence({ db: opts.db })],

    async onConnect(data) {
      // M4: hardcoded user — žádný auth
      // TODO(M10): JWT validation — ověřit Bearer token, nastavit userId z claims
      data.context.userId = 'demo-user'
      metrics.incConnections()
      console.log(`[hocuspocus] connect → doc=${data.documentName} user=demo-user`)
    },

    async onDisconnect(data) {
      const userId = (data.context as { userId?: string }).userId ?? 'unknown'
      metrics.decConnections()
      console.log(`[hocuspocus] disconnect → doc=${data.documentName} user=${userId}`)
    },

    async onStoreDocument(data) {
      // Zaznamenej Yjs update do metrik — onStoreDocument je per-flush, ne per-update
      // Spike B poznámka: pro per-update counting by bylo nutné subscribovat na doc.on('update')
      // Pro M6 baseline stačí per-flush tracking (koreluje se zápisy do Postgres)
      const encoded = Y.encodeStateAsUpdate(data.document)
      metrics.recordUpdate(encoded.byteLength)
    },
  })

  return server
}
