/**
 * tests/load/yjsClient.ts
 *
 * A Node.js Yjs client speaking the Hocuspocus protocol, written by hand so
 * the harness counts every message and byte (adapted from
 * spikes/spike-b-yjs-scale/src/yjsClient.ts).
 *
 * Wire format (Hocuspocus 4):
 *   [varString documentName] [varUint messageType] [...payload]
 * which is not y-websocket's.
 *
 * The handshake: on open the client sends an Auth message (token, then its
 * version); the server queues everything else until its `onAuthenticate`
 * hook has run, and answers Authenticated or PermissionDenied. Only then does
 * the client start the sync — as @hocuspocus/provider does. The token is the
 * sentinel the editor sends (`'cookie'`): the dev server runs under
 * BYPASS_AUTH, where any non-credential token is `dev-user`
 * (apps/server/src/hocuspocus/authenticate.ts). A server that refuses the
 * connection rejects `createClient` with its reason instead of hanging.
 */

import * as Y from 'yjs'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { readAuthMessage, writeAuthentication } from '@hocuspocus/common'
import { WebSocket } from 'ws'

/** Sent after the token, where the provider sends its version (the server only records it). */
const CLIENT_VERSION = 'narrative-load-harness'

/** The token the editor sends; see the header. */
const SENTINEL_TOKEN = 'cookie'

/** How long the handshake may take before `createClient` gives up. */
const AUTH_TIMEOUT_MS = 10_000

const MessageType = {
  Sync: 0,
  Awareness: 1,
  Auth: 2,
  QueryAwareness: 3,
  SyncReply: 4,
  Stateless: 5,
  BroadcastStateless: 6,
  CLOSE: 7,
  SyncStatus: 8,
} as const

const messageYjsSyncStep1 = 0
const messageYjsSyncStep2 = 1
const messageYjsUpdate = 2

export interface ClientStats {
  updateLatencies: number[]
  messagesReceived: number
  messagesSent: number
  bytesReceived: number
  bytesSent: number
}

export interface YjsClient {
  doc: Y.Doc
  awareness: awarenessProtocol.Awareness
  stats: ClientStats
  id: number
  readonly connected: boolean
  disconnect(): void
  broadcastAwareness(state: Record<string, unknown>): void
  waitForSync(): Promise<void>
}

let clientIdCounter = 0

export function createClient(url: string, roomName: string): Promise<YjsClient> {
  return new Promise((resolve, reject) => {
    const id = ++clientIdCounter
    const doc = new Y.Doc()
    const awareness = new awarenessProtocol.Awareness(doc)
    const stats: ClientStats = {
      updateLatencies: [],
      messagesReceived: 0,
      messagesSent: 0,
      bytesReceived: 0,
      bytesSent: 0,
    }

    let synced = false
    let syncResolvers: Array<() => void> = []
    let connected = false
    let resolved = false

    function fail(err: Error): void {
      if (resolved) return
      resolved = true
      clearTimeout(authTimer)
      ws.close()
      reject(err)
    }
    const authTimer = setTimeout(
      () =>
        fail(new Error(`${roomName}: no answer to the Auth message within ${AUTH_TIMEOUT_MS} ms`)),
      AUTH_TIMEOUT_MS,
    )

    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'

    function send(data: Uint8Array): void {
      if (ws.readyState === WebSocket.OPEN) {
        stats.messagesSent++
        stats.bytesSent += data.byteLength
        ws.send(data)
      }
    }

    function buildMsg(msgType: number, writeFn: (enc: encoding.Encoder) => void): Uint8Array {
      const enc = encoding.createEncoder()
      encoding.writeVarString(enc, roomName)
      encoding.writeVarUint(enc, msgType)
      writeFn(enc)
      return encoding.toUint8Array(enc)
    }

    function sendAuth(): void {
      send(
        buildMsg(MessageType.Auth, (enc) => {
          writeAuthentication(enc, SENTINEL_TOKEN)
          encoding.writeVarString(enc, CLIENT_VERSION)
        }),
      )
    }

    function sendSyncStep1(): void {
      send(
        buildMsg(MessageType.Sync, (enc) => {
          encoding.writeVarUint(enc, messageYjsSyncStep1)
          encoding.writeVarUint8Array(enc, Y.encodeStateVector(doc))
        }),
      )
    }

    function sendSyncStep2(sv: Uint8Array): void {
      send(
        buildMsg(MessageType.Sync, (enc) => {
          encoding.writeVarUint(enc, messageYjsSyncStep2)
          encoding.writeVarUint8Array(enc, Y.encodeStateAsUpdate(doc, sv))
        }),
      )
    }

    function sendUpdate(update: Uint8Array): void {
      send(
        buildMsg(MessageType.Sync, (enc) => {
          encoding.writeVarUint(enc, messageYjsUpdate)
          encoding.writeVarUint8Array(enc, update)
        }),
      )
    }

    function sendAwareness(state: Record<string, unknown>): void {
      awareness.setLocalState(state)
      const update = awarenessProtocol.encodeAwarenessUpdate(awareness, [doc.clientID])
      send(
        buildMsg(MessageType.Awareness, (enc) => {
          encoding.writeVarUint8Array(enc, update)
        }),
      )
    }

    // Forward local updates to the server (not the ones it sent).
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== 'server') {
        sendUpdate(update)
      }
    })

    ws.on('open', () => {
      connected = true
      sendAuth()
    })

    function onAuthenticated(): void {
      if (resolved) return
      resolved = true
      clearTimeout(authTimer)
      sendSyncStep1()
      resolve(client)
    }

    ws.on('message', (raw: ArrayBuffer) => {
      const data = new Uint8Array(raw as ArrayBuffer)
      stats.messagesReceived++
      stats.bytesReceived += data.byteLength

      const receiveTs = performance.now()

      try {
        const dec = decoding.createDecoder(data)
        decoding.readVarString(dec) // docName — ignored
        const msgType = decoding.readVarUint(dec)

        if (msgType === MessageType.Sync || msgType === MessageType.SyncReply) {
          const syncType = decoding.readVarUint(dec)

          if (syncType === messageYjsSyncStep1) {
            const sv = decoding.readVarUint8Array(dec)
            sendSyncStep2(sv)
          } else if (syncType === messageYjsSyncStep2) {
            const update = decoding.readVarUint8Array(dec)
            Y.applyUpdate(doc, update, 'server')
            const afterApply = performance.now()
            stats.updateLatencies.push(afterApply - receiveTs)
            if (!synced) {
              synced = true
              syncResolvers.forEach((r) => r())
              syncResolvers = []
            }
          } else if (syncType === messageYjsUpdate) {
            const update = decoding.readVarUint8Array(dec)
            Y.applyUpdate(doc, update, 'server')
            const afterApply = performance.now()
            stats.updateLatencies.push(afterApply - receiveTs)
          }
        } else if (msgType === MessageType.Awareness) {
          const update = decoding.readVarUint8Array(dec)
          awarenessProtocol.applyAwarenessUpdate(awareness, update, 'server')
        } else if (msgType === MessageType.Auth) {
          readAuthMessage(
            dec,
            // The server asks for the token again (a token sync request).
            sendAuth,
            (reason) => fail(new Error(`${roomName}: permission denied (${reason})`)),
            onAuthenticated,
          )
        }
        // SyncStatus and the stateless messages mean nothing to the harness.
      } catch (err) {
        // A message the harness cannot parse is counted and skipped.
        process.stderr.write(`[yjsClient] unreadable message: ${String(err)}\n`)
      }
    })

    ws.on('error', (err) => fail(err))

    ws.on('close', (code, reason) => {
      connected = false
      fail(
        new Error(
          `${roomName}: connection closed before authentication (${code} ${reason.toString()})`,
        ),
      )
    })

    const client: YjsClient = {
      doc,
      awareness,
      stats,
      id,
      get connected(): boolean {
        return connected
      },
      disconnect(): void {
        ws.close()
        // The Awareness keeps an interval (its outdated-state check) that
        // would hold the process open after the scenario is done.
        awareness.destroy()
        doc.destroy()
      },
      broadcastAwareness: sendAwareness,
      waitForSync(): Promise<void> {
        if (synced) return Promise.resolve()
        return new Promise((r) => syncResolvers.push(r))
      },
    }
  })
}

export function seededRandom(seed: number): () => number {
  let s = seed >>> 0
  return function (): number {
    s += 0x6d2b79f5
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * The largest of `values`, 0 for none. Not `Math.max(...values)`: a flood
 * records ~200k samples, more arguments than a call can take.
 */
export function maxOf(values: number[]): number {
  let max = 0
  for (const v of values) if (v > max) max = v
  return max
}

/** The p-th percentile (0–1) of an unsorted array of numbers. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.max(0, Math.ceil(sorted.length * p) - 1)
  return sorted[index] ?? 0
}

/** Pre-flight check: is the server up at this HTTP URL? */
export async function checkServerHealth(httpUrl: string): Promise<void> {
  try {
    const res = await fetch(`${httpUrl}/health`)
    if (!res.ok) {
      throw new Error(`/health returned ${res.status}`)
    }
    const body = (await res.json()) as { status?: string }
    if (body.status !== 'ok') {
      throw new Error(`/health status is not 'ok': ${JSON.stringify(body)}`)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(
      `Server health check failed at ${httpUrl}/health: ${message}\n` +
        `Start the dev stack with: just dev`,
    )
  }
}

/** A deck a scenario created for itself; `remove` deletes it again. */
export interface ProvisionedDeck {
  id: string
  /** The Hocuspocus document name: the bare deck id, as the editor names it. */
  docName: string
  remove(): Promise<void>
}

/**
 * Create a deck through the API the editor uses (as `dev-user` under
 * BYPASS_AUTH), so the scenario syncs a document it is allowed to open and
 * reads nobody's data. The scenario deletes it when it is done, pass or fail.
 */
export async function provisionDeck(httpUrl: string, title: string): Promise<ProvisionedDeck> {
  const res = await fetch(`${httpUrl}/decks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  })
  if (!res.ok) throw new Error(`Creating the load deck failed: ${res.status} ${await res.text()}`)
  const { id } = (await res.json()) as { id: string }
  return {
    id,
    docName: id,
    async remove(): Promise<void> {
      const del = await fetch(`${httpUrl}/decks/${id}`, { method: 'DELETE' })
      if (!del.ok && del.status !== 404) {
        process.stderr.write(`[load] could not delete deck ${id}: ${del.status}\n`)
      }
    },
  }
}

/**
 * A replica's content as a string that is equal exactly when the content
 * is: map keys sorted (each replica keeps them in its own insertion order).
 * Encoded Yjs updates are not canonical, so they cannot tell convergence.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}
