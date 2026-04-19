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
import type { Database } from '../db/client.js'
import { PostgresPersistence } from './persistence.js'

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
      console.log(`[hocuspocus] connect → doc=${data.documentName} user=demo-user`)
    },

    async onDisconnect(data) {
      const userId = (data.context as { userId?: string }).userId ?? 'unknown'
      console.log(`[hocuspocus] disconnect → doc=${data.documentName} user=${userId}`)
    },
  })

  return server
}
