/**
 * routes/pptxExport.stream.test.ts — the streamed `.pptx` download over a
 * real socket: `Content-Length` is the plan's size; storage failing while the
 * body streams cuts the response short (a failed download, never a short file
 * that looks whole); a client that goes away stops the reads of storage.
 */

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { crc32 } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { planZip, storedEntry, type ZipEntry } from '../pptx/zipWriter.js'

const exportPackage = vi.fn()
vi.mock('../services/pptx.js', () => ({ createPptxService: () => ({ exportPackage }) }))
vi.mock('../auth/fastifyAuth.js', () => ({
  authPreHandler: async () => undefined,
  requireDeckRole: () => async () => undefined,
}))

const { registerPptxExportRoutes } = await import('./pptxExport.js')

const date = new Date(Date.UTC(2026, 9, 19))

/** A streamed STORE entry of `size` bytes; `opts` make it fail or crawl. */
function source(
  name: string,
  size: number,
  opts: { failAfter?: number; delayMs?: number; onChunk?: () => void; onClose?: () => void } = {},
): ZipEntry {
  const bytes = Buffer.alloc(size, 0x61)
  return {
    name,
    method: 0,
    crc: crc32(bytes),
    size,
    compressedSize: size,
    data: async () =>
      (async function* () {
        try {
          for (let i = 0; i < size; i += 16 * 1024) {
            if (opts.failAfter !== undefined && i >= opts.failAfter)
              throw new Error('storage read failed')
            if (opts.delayMs !== undefined)
              await new Promise((resolve) => setTimeout(resolve, opts.delayMs))
            opts.onChunk?.()
            yield bytes.subarray(i, i + 16 * 1024)
          }
        } finally {
          opts.onClose?.()
        }
      })(),
  }
}

let app: FastifyInstance | null = null

afterEach(async () => {
  await app?.close()
  app = null
  exportPackage.mockReset()
})

async function serve(entries: ZipEntry[]): Promise<{ port: number; size: number }> {
  const pkg = planZip(entries, { date })
  exportPackage.mockResolvedValue({ filename: 'Deck.pptx', package: pkg })
  app = Fastify({ logger: false })
  await registerPptxExportRoutes(app, {} as never)
  await app.listen({ port: 0, host: '127.0.0.1' })
  return { port: (app.server.address() as AddressInfo).port, size: pkg.size }
}

describe('GET /decks/:id/export.pptx, streamed', () => {
  it('cuts the response short when storage fails mid-stream', async () => {
    const { port, size } = await serve([
      storedEntry('[Content_Types].xml', Buffer.from('<Types/>')),
      source('ppt/media/video1.mp4', 512 * 1024, { failAfter: 128 * 1024 }),
    ])
    const outcome = await new Promise<{ length: string | undefined; got: number; error: boolean }>(
      (resolve) => {
        http.get(`http://127.0.0.1:${port}/decks/d1/export.pptx`, (res) => {
          let got = 0
          let error = false
          res.on('data', (c: Buffer) => (got += c.byteLength))
          res.on('error', () => (error = true))
          res.on('aborted', () => (error = true))
          res.on('close', () =>
            resolve({ length: res.headers['content-length'], got, error: error || !res.complete }),
          )
        })
      },
    )
    expect(outcome.length).toBe(String(size))
    expect(outcome.got).toBeLessThan(size)
    expect(outcome.error).toBe(true)
  })

  it('stops reading storage when the client goes away', async () => {
    let chunks = 0
    let closed = false
    const { port } = await serve([
      source('ppt/media/video1.mp4', 64 * 1024 * 1024, {
        delayMs: 5,
        onChunk: () => chunks++,
        onClose: () => (closed = true),
      }),
    ])
    await new Promise<void>((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/decks/d1/export.pptx`, (res) => {
        res.once('data', () => {
          req.destroy()
          resolve()
        })
      })
      req.on('error', () => undefined)
    })
    await vi.waitFor(() => expect(closed).toBe(true), { timeout: 5_000 })
    const after = chunks
    await new Promise((resolve) => setTimeout(resolve, 100))
    // Far from the 4096 chunks of the whole entry, and no more after the close.
    expect(chunks).toBe(after)
    expect(chunks).toBeLessThan(4096)
  })
})
