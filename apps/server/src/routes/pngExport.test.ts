/**
 * routes/pngExport.test.ts — the PDF job routes' own bounds: the status read
 * has a per-person rate limit, and its `waitMs` is capped before the service
 * (which caps it again, services/render.ts) sees it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import rateLimit from '@fastify/rate-limit'

const pdfExportStatus = vi.fn()
vi.mock('../services/render.js', () => ({
  createRenderService: () => ({ pdfExportStatus, startPdfExport: vi.fn() }),
}))
vi.mock('../auth/fastifyAuth.js', () => ({
  authPreHandler: async (req: { user?: unknown }) => {
    req.user = { sub: 'u1' }
  },
}))
vi.mock('../http/sameOrigin.js', () => ({ isFromWebApp: () => true }))

const { registerPdfExportRoutes, PDF_STATUS_MAX_WAIT_MS, PDF_STATUS_RATE_LIMIT } =
  await import('./pngExport.js')

let app: FastifyInstance

beforeEach(async () => {
  pdfExportStatus.mockReset()
  pdfExportStatus.mockResolvedValue({ jobId: 'pdf_x', status: 'running', done: 1, total: 3 })
  app = Fastify()
  await app.register(rateLimit, { global: false, keyGenerator: () => 'u1' })
  await registerPdfExportRoutes(app, {} as never)
  await app.ready()
})

afterEach(async () => {
  await app.close()
})

describe('GET /decks/:id/export.pdf/:jobId', () => {
  it('caps waitMs before the service sees it', async () => {
    const res = await app.inject({ url: '/decks/d1/export.pdf/pdf_x?waitMs=600000' })
    expect(res.statusCode).toBe(200)
    expect(pdfExportStatus).toHaveBeenCalledWith({
      userId: 'u1',
      deckId: 'd1',
      jobId: 'pdf_x',
      waitMs: PDF_STATUS_MAX_WAIT_MS,
    })
    expect((await app.inject({ url: '/decks/d1/export.pdf/pdf_x?waitMs=-1' })).statusCode).toBe(400)
  })

  it('holds one person to PDF_STATUS_RATE_LIMIT reads a minute', async () => {
    for (let i = 0; i < PDF_STATUS_RATE_LIMIT.max; i++) {
      expect((await app.inject({ url: '/decks/d1/export.pdf/pdf_x' })).statusCode).toBe(200)
    }
    expect((await app.inject({ url: '/decks/d1/export.pdf/pdf_x' })).statusCode).toBe(429)
    expect(pdfExportStatus).toHaveBeenCalledTimes(PDF_STATUS_RATE_LIMIT.max)
  })
})
