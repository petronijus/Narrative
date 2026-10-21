/**
 * e2e/perf/lib/wsServer.ts — the smallest WebSocket server the Tauri perf
 * driver needs (RFC 6455, text frames; tauriPage.ts): the page of the Tauri
 * window connects to it and answers the driver's scripts. Node has a
 * WebSocket client but no server, and the web app has no `ws` dependency;
 * a WebSocket rather than HTTP because Resource Timing — the harness's
 * network counters — does not see a socket's frames.
 *
 * Listens on 127.0.0.1 only and takes connections from one origin.
 */

import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export interface WsConnection {
  send(text: string): void
  close(): void
  onMessage(listener: (text: string) => void): void
  onClose(listener: () => void): void
}

export interface WsServer {
  port: number
  close(): Promise<void>
}

/** A server frame: FIN, the opcode, an unmasked payload. */
function frame(opcode: number, payload: Buffer): Buffer {
  const n = payload.length
  const head =
    n < 126
      ? Buffer.from([0x80 | opcode, n])
      : n < 0x10000
        ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 0xff])
        : (() => {
            const b = Buffer.alloc(10)
            b[0] = 0x80 | opcode
            b[1] = 127
            b.writeBigUInt64BE(BigInt(n), 2)
            return b
          })()
  return Buffer.concat([head, payload])
}

function connection(socket: Duplex): WsConnection {
  const messageListeners: Array<(text: string) => void> = []
  const closeListeners: Array<() => void> = []
  let buffer = Buffer.alloc(0)
  let fragments: Buffer[] = []
  let closed = false

  const finish = (): void => {
    if (closed) return
    closed = true
    for (const l of closeListeners) l()
  }

  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      if (buffer.length < 2) return
      const fin = (buffer[0]! & 0x80) !== 0
      const opcode = buffer[0]! & 0x0f
      const masked = (buffer[1]! & 0x80) !== 0
      let len = buffer[1]! & 0x7f
      let at = 2
      if (len === 126) {
        if (buffer.length < 4) return
        len = buffer.readUInt16BE(2)
        at = 4
      } else if (len === 127) {
        if (buffer.length < 10) return
        len = Number(buffer.readBigUInt64BE(2))
        at = 10
      }
      const maskAt = at
      if (masked) at += 4
      if (buffer.length < at + len) return
      const payload = Buffer.from(buffer.subarray(at, at + len))
      if (masked) for (let i = 0; i < len; i++) payload[i]! ^= buffer[maskAt + (i % 4)]!
      buffer = buffer.subarray(at + len)

      if (opcode === 0x8) {
        if (!socket.destroyed) socket.end(frame(0x8, Buffer.alloc(0)))
        finish()
        return
      }
      if (opcode === 0x9) {
        socket.write(frame(0xa, payload))
        continue
      }
      if (opcode === 0xa) continue
      // Text (1), binary (2) or a continuation (0) of either.
      fragments.push(payload)
      if (fin) {
        const text = Buffer.concat(fragments).toString('utf8')
        fragments = []
        for (const l of messageListeners) l(text)
      }
    }
  })
  socket.on('close', finish)
  socket.on('error', finish)

  return {
    send(text) {
      if (!closed) socket.write(frame(0x1, Buffer.from(text, 'utf8')))
    },
    close() {
      if (!closed) socket.end(frame(0x8, Buffer.alloc(0)))
      finish()
    },
    onMessage: (l) => messageListeners.push(l),
    onClose: (l) => closeListeners.push(l),
  }
}

/** Listen on a free port of 127.0.0.1; `origin` is the only page origin let in. */
export function startWsServer(
  origin: string,
  onConnection: (c: WsConnection, req: IncomingMessage) => void,
): Promise<WsServer> {
  const sockets = new Set<Duplex>()
  const server = createServer((_req, res) => {
    res.writeHead(426).end()
  })
  server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    const key = req.headers['sec-websocket-key']
    if (typeof key !== 'string' || req.headers.origin !== origin) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    const accept = createHash('sha1')
      .update(key + GUID)
      .digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    onConnection(connection(socket), req)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () =>
          new Promise<void>((r) => {
            for (const s of sockets) s.destroy()
            server.close(() => r())
          }),
      })
    })
  })
}
