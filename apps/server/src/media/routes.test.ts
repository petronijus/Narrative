/**
 * media/routes.test.ts
 *
 * Tests for GET /api/media/:assetId/url and DELETE /api/media/:assetId.
 * Uses in-process Fastify instance with mocked DB and auth.
 *
 * Auth strategy:
 *   - registerAuthPlugin is called with bypass=true → all requests run as 'dev-user'.
 *   - resolveDeckAccess is mocked to control access outcomes.
 *   - getMediaAsset is mocked to return a fixture or null.
 *   - signImgproxyUrl is mocked to return a deterministic URL.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import type { Database } from '../db/client.js'
import type { MediaAsset } from '../db/schema.js'
import { registerAuthPlugin } from '../auth/fastifyAuth.js'
import { registerMediaRoutes } from './routes.js'

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('./assets.js', () => ({
  getMediaAsset: vi.fn(),
  getVideoAsset: vi.fn(),
  deleteMediaAsset: vi.fn(),
}))

vi.mock('./imgproxyUrl.js', () => ({
  signImgproxyUrl: vi.fn(() => 'http://imgproxy.test/SIGNED/path/to/image@webp'),
}))

vi.mock('../auth/permissions.js', () => ({
  resolveDeckAccess: vi.fn(),
  roleAtLeast: vi.fn(),
}))

import { getMediaAsset, getVideoAsset, deleteMediaAsset } from './assets.js'
import { signImgproxyUrl } from './imgproxyUrl.js'
import { resolveDeckAccess, roleAtLeast } from '../auth/permissions.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

import type { VideoAssetRow } from './assets.js'

const FIXTURE_VIDEO_PENDING: VideoAssetRow = {
  id: 'video-pending-01',
  deckId: 'deck-alpha',
  mimeType: 'video/mp4',
  sizeBytes: 50_000_000,
  storageKey: 'decks/deck-alpha/uploads/video-pending-01/original.mp4',
  width: null,
  height: null,
  durationSec: null,
  hlsManifestKey: null,
  posterKey: null,
  thumbnailKey: null,
  transcodeStatus: 'pending',
  transcodeError: null,
  createdAt: new Date('2026-04-20T10:00:00Z'),
}

const FIXTURE_VIDEO_DONE: VideoAssetRow = {
  id: 'video-done-01',
  deckId: 'deck-alpha',
  mimeType: 'video/mp4',
  sizeBytes: 50_000_000,
  storageKey: 'decks/deck-alpha/uploads/video-done-01/original.mp4',
  width: 1920,
  height: 1080,
  durationSec: 120,
  hlsManifestKey: 'decks/deck-alpha/videos/video-done-01/master.m3u8',
  posterKey: 'decks/deck-alpha/videos/video-done-01/poster.jpg',
  thumbnailKey: 'decks/deck-alpha/videos/video-done-01/thumb.jpg',
  transcodeStatus: 'done',
  transcodeError: null,
  createdAt: new Date('2026-04-20T10:00:00Z'),
}

const FIXTURE_ASSET: MediaAsset = {
  id: 'asset-test-01',
  deckId: 'deck-alpha',
  uploaderUserId: 'dev-user',
  mimeType: 'image/jpeg',
  sizeBytes: 102400,
  storageKey: 'decks/deck-alpha/uploads/asset-test-01/original.jpg',
  originalFilename: 'photo.jpg',
  width: 1920,
  height: 1080,
  createdAt: new Date('2026-04-20T10:00:00Z'),
  // M12 additions — image defaults
  kind: 'image',
  durationSec: null,
  hlsManifestKey: null,
  posterKey: null,
  thumbnailKey: null,
  transcodeStatus: null,
  transcodeError: null,
}

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })

  const mockDb = {} as unknown as Database

  // bypass=true → every request becomes dev-user
  registerAuthPlugin(app, { verifier: null, bypass: true, db: mockDb })

  await registerMediaRoutes(app, { db: mockDb })

  await app.ready()
  return app
}

// ---------------------------------------------------------------------------
// Tests: GET /api/media/:assetId/url
// ---------------------------------------------------------------------------

describe('GET /api/media/:assetId/url', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    vi.clearAllMocks()
    app = await buildApp()
  })

  it('returns 200 with signed URL for authorized user', async () => {
    vi.mocked(getMediaAsset).mockResolvedValue(FIXTURE_ASSET)
    vi.mocked(resolveDeckAccess).mockResolvedValue({ role: 'viewer', reason: 'direct' })
    vi.mocked(roleAtLeast).mockReturnValue(true)

    const res = await app.inject({
      method: 'GET',
      url: '/api/media/asset-test-01/url?variant=display',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json<{ url: string }>()
    expect(body.url).toBe('http://imgproxy.test/SIGNED/path/to/image@webp')
    expect(signImgproxyUrl).toHaveBeenCalledWith({
      storageKey: FIXTURE_ASSET.storageKey,
      variant: 'display',
    })
  })

  it('returns 404 for an unknown assetId', async () => {
    vi.mocked(getMediaAsset).mockResolvedValue(null)

    const res = await app.inject({
      method: 'GET',
      url: '/api/media/nonexistent/url',
    })

    expect(res.statusCode).toBe(404)
  })

  it('returns 403 when user has no deck access', async () => {
    vi.mocked(getMediaAsset).mockResolvedValue(FIXTURE_ASSET)
    vi.mocked(resolveDeckAccess).mockResolvedValue(null)
    vi.mocked(roleAtLeast).mockReturnValue(false)

    const res = await app.inject({
      method: 'GET',
      url: '/api/media/asset-test-01/url',
    })

    expect(res.statusCode).toBe(403)
  })

  it('returns 403 when user role is insufficient (below viewer)', async () => {
    vi.mocked(getMediaAsset).mockResolvedValue(FIXTURE_ASSET)
    // resolveDeckAccess returns some access but roleAtLeast says insufficient
    vi.mocked(resolveDeckAccess).mockResolvedValue({ role: 'viewer', reason: 'share-link' })
    vi.mocked(roleAtLeast).mockReturnValue(false)

    const res = await app.inject({
      method: 'GET',
      url: '/api/media/asset-test-01/url',
    })

    expect(res.statusCode).toBe(403)
  })

  it('returns 400 for an invalid variant', async () => {
    vi.mocked(getMediaAsset).mockResolvedValue(FIXTURE_ASSET)

    const res = await app.inject({
      method: 'GET',
      url: '/api/media/asset-test-01/url?variant=4k',
    })

    expect(res.statusCode).toBe(400)
  })

  it('defaults to display variant when variant query param is missing', async () => {
    vi.mocked(getMediaAsset).mockResolvedValue(FIXTURE_ASSET)
    vi.mocked(resolveDeckAccess).mockResolvedValue({ role: 'owner', reason: 'direct' })
    vi.mocked(roleAtLeast).mockReturnValue(true)

    await app.inject({ method: 'GET', url: '/api/media/asset-test-01/url' })

    expect(signImgproxyUrl).toHaveBeenCalledWith(expect.objectContaining({ variant: 'display' }))
  })

  it('includes Cache-Control header', async () => {
    vi.mocked(getMediaAsset).mockResolvedValue(FIXTURE_ASSET)
    vi.mocked(resolveDeckAccess).mockResolvedValue({ role: 'editor', reason: 'direct' })
    vi.mocked(roleAtLeast).mockReturnValue(true)

    const res = await app.inject({
      method: 'GET',
      url: '/api/media/asset-test-01/url',
    })

    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toContain('max-age=600')
  })
})

// ---------------------------------------------------------------------------
// Tests: DELETE /api/media/:assetId
// ---------------------------------------------------------------------------

describe('DELETE /api/media/:assetId', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    vi.clearAllMocks()
    app = await buildApp()
  })

  it('returns 204 for owner role', async () => {
    vi.mocked(getMediaAsset).mockResolvedValue(FIXTURE_ASSET)
    vi.mocked(resolveDeckAccess).mockResolvedValue({ role: 'owner', reason: 'direct' })
    vi.mocked(roleAtLeast).mockReturnValue(true)
    vi.mocked(deleteMediaAsset).mockResolvedValue(undefined)

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/media/asset-test-01',
    })

    expect(res.statusCode).toBe(204)
    expect(deleteMediaAsset).toHaveBeenCalledWith(expect.anything(), 'asset-test-01')
  })

  it('returns 403 for editor role (not owner)', async () => {
    vi.mocked(getMediaAsset).mockResolvedValue(FIXTURE_ASSET)
    vi.mocked(resolveDeckAccess).mockResolvedValue({ role: 'editor', reason: 'direct' })
    vi.mocked(roleAtLeast).mockReturnValue(false)

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/media/asset-test-01',
    })

    expect(res.statusCode).toBe(403)
    expect(deleteMediaAsset).not.toHaveBeenCalled()
  })

  it('returns 403 for viewer role', async () => {
    vi.mocked(getMediaAsset).mockResolvedValue(FIXTURE_ASSET)
    vi.mocked(resolveDeckAccess).mockResolvedValue({ role: 'viewer', reason: 'share-link' })
    vi.mocked(roleAtLeast).mockReturnValue(false)

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/media/asset-test-01',
    })

    expect(res.statusCode).toBe(403)
  })

  it('returns 404 for unknown assetId', async () => {
    vi.mocked(getMediaAsset).mockResolvedValue(null)

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/media/nonexistent',
    })

    expect(res.statusCode).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Tests: GET /api/media/:assetId/video-info
// ---------------------------------------------------------------------------

describe('GET /api/media/:assetId/video-info', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    vi.clearAllMocks()
    app = await buildApp()
  })

  it('returns 404 when asset does not exist or is not a video', async () => {
    vi.mocked(getVideoAsset).mockResolvedValue(null)

    const res = await app.inject({
      method: 'GET',
      url: '/api/media/nonexistent/video-info',
    })

    expect(res.statusCode).toBe(404)
  })

  it('returns 403 when user has no deck access', async () => {
    vi.mocked(getVideoAsset).mockResolvedValue(FIXTURE_VIDEO_PENDING)
    vi.mocked(resolveDeckAccess).mockResolvedValue(null)
    vi.mocked(roleAtLeast).mockReturnValue(false)

    const res = await app.inject({
      method: 'GET',
      url: '/api/media/video-pending-01/video-info',
    })

    expect(res.statusCode).toBe(403)
  })

  it('returns pending status with null URLs when video is still transcoding', async () => {
    vi.mocked(getVideoAsset).mockResolvedValue(FIXTURE_VIDEO_PENDING)
    vi.mocked(resolveDeckAccess).mockResolvedValue({ role: 'viewer', reason: 'direct' })
    vi.mocked(roleAtLeast).mockReturnValue(true)

    const res = await app.inject({
      method: 'GET',
      url: '/api/media/video-pending-01/video-info',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json<Record<string, unknown>>()
    expect(body['transcodeStatus']).toBe('pending')
    expect(body['posterUrl']).toBeNull()
    expect(body['thumbnailUrl']).toBeNull()
    expect(body['hlsManifestUrl']).toBeNull()
    expect(body['assetId']).toBe('video-pending-01')
  })

  it('returns done status with signed URLs and hlsManifestUrl when transcode is complete', async () => {
    vi.mocked(getVideoAsset).mockResolvedValue(FIXTURE_VIDEO_DONE)
    vi.mocked(resolveDeckAccess).mockResolvedValue({ role: 'viewer', reason: 'direct' })
    vi.mocked(roleAtLeast).mockReturnValue(true)

    const res = await app.inject({
      method: 'GET',
      url: '/api/media/video-done-01/video-info',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json<Record<string, unknown>>()
    expect(body['transcodeStatus']).toBe('done')
    expect(body['durationSec']).toBe(120)
    expect(body['width']).toBe(1920)
    expect(body['height']).toBe(1080)

    // signImgproxyUrl is mocked to return the test URL
    expect(body['posterUrl']).toBe('http://imgproxy.test/SIGNED/path/to/image@webp')
    expect(body['thumbnailUrl']).toBe('http://imgproxy.test/SIGNED/path/to/image@webp')

    // HLS URL contains the manifest key
    expect(typeof body['hlsManifestUrl']).toBe('string')
    expect(body['hlsManifestUrl'] as string).toContain('master.m3u8')
  })

  it('includes transcodeError field in response', async () => {
    const failedAsset: VideoAssetRow = {
      ...FIXTURE_VIDEO_PENDING,
      transcodeStatus: 'failed',
      transcodeError: 'ffmpeg exited with code 1',
    }
    vi.mocked(getVideoAsset).mockResolvedValue(failedAsset)
    vi.mocked(resolveDeckAccess).mockResolvedValue({ role: 'owner', reason: 'direct' })
    vi.mocked(roleAtLeast).mockReturnValue(true)

    const res = await app.inject({
      method: 'GET',
      url: '/api/media/video-pending-01/video-info',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json<Record<string, unknown>>()
    expect(body['transcodeStatus']).toBe('failed')
    expect(body['transcodeError']).toBe('ffmpeg exited with code 1')
  })
})
