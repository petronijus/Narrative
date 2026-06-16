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
  // IDOR-1 folder-font DELETE path needs these resolvable.
  getFontAsset: vi.fn(),
  getFolderFontAsset: vi.fn(),
  listFolderFontAssets: vi.fn(),
  listDeckFontAssets: vi.fn(),
  folderFontPostscriptCollides: vi.fn(),
}))

vi.mock('./imgproxyUrl.js', () => ({
  signImgproxyUrl: vi.fn(() => 'http://imgproxy.test/SIGNED/path/to/image@webp'),
}))

// s3Client is only exercised by the folder-font routes; stub it so the
// DELETE clone test doesn't reach a real MinIO.
vi.mock('./s3Client.js', () => ({
  buildS3Client: vi.fn(() => ({ send: vi.fn().mockResolvedValue({}) })),
  presignGetUrl: vi.fn().mockResolvedValue('http://minio.test/signed'),
  MEDIA_BUCKET: 'narrative-media',
}))

vi.mock('../auth/permissions.js', () => ({
  resolveDeckAccess: vi.fn(),
  roleAtLeast: vi.fn(),
}))

import { getMediaAsset, getVideoAsset, deleteMediaAsset, getFolderFontAsset } from './assets.js'
import { signImgproxyUrl } from './imgproxyUrl.js'
import { presignGetUrl } from './s3Client.js'
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
  playbackKey: null,
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
  playbackKey: 'decks/deck-alpha/videos/video-done-01/playback.mp4',
  posterKey: 'decks/deck-alpha/videos/video-done-01/poster.jpg',
  thumbnailKey: 'decks/deck-alpha/videos/video-done-01/thumb.jpg',
  transcodeStatus: 'done',
  transcodeError: null,
  createdAt: new Date('2026-04-20T10:00:00Z'),
}

const FIXTURE_ASSET: MediaAsset = {
  id: 'asset-test-01',
  deckId: 'deck-alpha',
  folderId: null,
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
  playbackKey: null,
  posterKey: null,
  thumbnailKey: null,
  transcodeStatus: null,
  transcodeError: null,
  fontFamily: null,
  fontWeight: null,
  fontStyle: null,
  fontPostscriptName: null,
}

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })

  const mockDb = {} as unknown as Database

  // bypass=true → every request becomes dev-user
  registerAuthPlugin(app, { bypass: true, db: mockDb })

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
// Tests: DELETE /api/folders/:folderId/fonts/:assetId — IDOR-1 clone scoping
// ---------------------------------------------------------------------------

describe('DELETE /api/folders/:folderId/fonts/:assetId — clone scoping (IDOR-1)', () => {
  /**
   * Recursively scans a drizzle SQL condition for a column whose SQL name
   * matches `name`. Drizzle conditions are SQL objects whose `queryChunks`
   * carry Column instances (with a `.name` property). This lets us assert
   * the folderDecks WHERE clause is scoped by `owner_user_id` without
   * depending on the SQL dialect.
   */
  function conditionMentionsColumn(
    node: unknown,
    name: string,
    seen: Set<object> = new Set(),
  ): boolean {
    if (!node || typeof node !== 'object') return false
    if (seen.has(node)) return false
    seen.add(node)
    const n = node as Record<string, unknown>
    if (typeof n['name'] === 'string' && n['name'] === name) return true
    for (const key of Object.keys(n)) {
      const v = n[key]
      if (Array.isArray(v)) {
        if (v.some((child) => conditionMentionsColumn(child, name, seen))) return true
      } else if (v && typeof v === 'object') {
        if (conditionMentionsColumn(v, name, seen)) return true
      }
    }
    return false
  }

  const FOLDER_ID = 'folder-shared'
  const FONT_ASSET = {
    id: 'font-asset-01',
    uploaderUserId: 'dev-user',
    mimeType: 'font/ttf',
    sizeBytes: 1234,
    storageKey: `fonts/${FOLDER_ID}/font-asset-01/original.ttf`,
    originalFilename: 'MyFont.ttf',
    fontFamily: 'MyFont',
    fontWeight: 400,
    fontStyle: 'normal',
    fontPostscriptName: 'MyFont-Regular',
  }

  /**
   * Builds an app whose db:
   *   - returns a folder owned by 'dev-user' (passes requireFolderOwner),
   *   - returns `ownedDecks` from the decks select (simulating the DB having
   *     already filtered to caller-owned decks — we ALSO capture the WHERE
   *     condition to prove the owner scope is present),
   *   - records the rows passed to insert(mediaAssets).
   */
  function buildScopedApp(ownedDecks: { id: string }[]) {
    const captured: { whereCondition?: unknown; insertedRows?: unknown[] } = {}
    let selectCall = 0

    const mockDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn((cond: unknown) => {
            selectCall += 1
            // 1st select = requireFolderOwner (folders); 2nd = folderDecks.
            if (selectCall === 1) {
              return {
                limit: vi.fn().mockResolvedValue([{ id: FOLDER_ID, ownerUserId: 'dev-user' }]),
              }
            }
            captured.whereCondition = cond
            // The decks select is awaited directly (no .limit()).
            return Promise.resolve(ownedDecks)
          }),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn((rows: unknown[]) => {
          captured.insertedRows = rows
          return Promise.resolve(undefined)
        }),
      })),
      delete: vi.fn(() => ({
        where: vi.fn().mockResolvedValue(undefined),
      })),
    } as unknown as Database

    return { mockDb, captured }
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('scopes the deck-font clone to caller-owned decks via owner_user_id', async () => {
    // Only ONE of the folder's decks is owned by the caller; the DB filter
    // (decks.ownerUserId = caller) returns just that one.
    const ownedDecks = [{ id: 'deck-mine' }]
    const { mockDb, captured } = buildScopedApp(ownedDecks)

    vi.mocked(getFolderFontAsset).mockResolvedValue(FONT_ASSET as never)

    const app = Fastify({ logger: false })
    registerAuthPlugin(app, { bypass: true, db: mockDb })
    await registerMediaRoutes(app, { db: mockDb })
    await app.ready()

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/folders/${FOLDER_ID}/fonts/font-asset-01`,
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ promotedToDeckCount: 1 })

    // The folderDecks WHERE clause must constrain by owner_user_id (IDOR-1).
    expect(conditionMentionsColumn(captured.whereCondition, 'owner_user_id')).toBe(true)
    // And it must still constrain by folder_id.
    expect(conditionMentionsColumn(captured.whereCondition, 'folder_id')).toBe(true)

    // Clones are created only for the caller-owned deck — never the foreign one.
    const rows = (captured.insertedRows ?? []) as { deckId: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]?.deckId).toBe('deck-mine')

    await app.close()
  })

  it('promotes to zero decks when the caller owns none in the folder', async () => {
    const { mockDb, captured } = buildScopedApp([])
    vi.mocked(getFolderFontAsset).mockResolvedValue(FONT_ASSET as never)

    const app = Fastify({ logger: false })
    registerAuthPlugin(app, { bypass: true, db: mockDb })
    await registerMediaRoutes(app, { db: mockDb })
    await app.ready()

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/folders/${FOLDER_ID}/fonts/font-asset-01`,
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ promotedToDeckCount: 0 })
    // No insert issued when there are no caller-owned decks.
    expect(captured.insertedRows).toBeUndefined()

    await app.close()
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
    expect(body['playbackUrl']).toBeNull()
    expect(body['assetId']).toBe('video-pending-01')
  })

  it('returns done status with signed URLs and playbackUrl when transcode is complete', async () => {
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

    // MEDIA-1: playbackUrl is a short-TTL presigned URL (NOT a raw MinIO URL).
    // The mocked presignGetUrl returns a deterministic signed URL.
    expect(body['playbackUrl']).toBe('http://minio.test/signed')
    // Signed against the playback key with the long video TTL (6 h default).
    expect(vi.mocked(presignGetUrl)).toHaveBeenCalledWith(
      FIXTURE_VIDEO_DONE.playbackKey,
      6 * 60 * 60,
    )
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
