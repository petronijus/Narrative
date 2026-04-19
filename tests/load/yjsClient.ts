/**
 * tests/load/yjsClient.ts
 *
 * Hocuspocus-kompatibilní Node.js Yjs klient.
 * Adaptovaný ze spikes/spike-b-yjs-scale/src/yjsClient.ts.
 *
 * Wire format (Hocuspocus):
 *   [varString documentName] [varUint messageType] [...payload]
 *
 * Spike B zjištění: Hocuspocus protokol ≠ y-websocket protokol.
 * Tato implementace je plně kompatibilní s @hocuspocus/server 2.x.
 */

import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { WebSocket } from 'ws'

// Suppress unused import warning — used for type inference
void syncProtocol

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

    // Forward lokální updates na server (ne remote-originated)
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== 'server') {
        sendUpdate(update)
      }
    })

    ws.on('open', () => {
      connected = true
      sendSyncStep1()
    })

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
        }
        // Auth, SyncStatus — ignorujeme pro harness
      } catch {
        // Ignoruj jednotlivé parse errory
      }
    })

    ws.on('error', (err) => {
      if (!resolved) {
        resolved = true
        reject(err)
      }
    })

    ws.on('close', () => {
      connected = false
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
      },
      broadcastAwareness: sendAwareness,
      waitForSync(): Promise<void> {
        if (synced) return Promise.resolve()
        return new Promise((r) => syncResolvers.push(r))
      },
    }

    ws.on('open', () => {
      if (!resolved) {
        resolved = true
        resolve(client)
      }
    })
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

/** Vypočítá percentil p (0–1) z neseřazeného pole čísel. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.max(0, Math.ceil(sorted.length * p) - 1)
  return sorted[index] ?? 0
}

/** Pre-flight check: ověří že server běží na daném HTTP URL. */
export async function checkServerHealth(httpUrl: string): Promise<void> {
  try {
    const res = await fetch(`${httpUrl}/health`)
    if (!res.ok) {
      throw new Error(`/health vrátil ${res.status}`)
    }
    const body = (await res.json()) as { status?: string }
    if (body.status !== 'ok') {
      throw new Error(`/health status není 'ok': ${JSON.stringify(body)}`)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(
      `Server health check selhal na ${httpUrl}/health: ${message}\n` +
        `Spusť server příkazem: pnpm --filter server dev`,
    )
  }
}
