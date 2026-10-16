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
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
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
const s3Send = vi.hoisted(() => vi.fn())
vi.mock('./s3Client.js', () => ({
  buildS3Client: vi.fn(() => ({ send: s3Send })),
  presignGetUrl: vi.fn().mockResolvedValue('http://minio.test/signed'),
  MEDIA_BUCKET: 'narrative-media',
}))

vi.mock('../auth/permissions.js', () => ({
  resolveDeckAccess: vi.fn(),
  resolveComponentAccess: vi.fn(),
  resolveFolderAccess: vi.fn(),
  resolveFolderContentAccess: vi.fn(),
  roleAtLeast: vi.fn(),
}))

import { getMediaAsset, getVideoAsset, deleteMediaAsset, getFolderFontAsset } from './assets.js'
import { signImgproxyUrl } from './imgproxyUrl.js'
import { presignGetUrl } from './s3Client.js'
import {
  resolveComponentAccess,
  resolveDeckAccess,
  resolveFolderAccess,
  resolveFolderContentAccess,
  roleAtLeast,
} from '../auth/permissions.js'

/** The real role order, for the tests whose outcome depends on a role boundary. */
const { roleAtLeast: realRoleAtLeast } =
  await vi.importActual<typeof import('../auth/permissions.js')>('../auth/permissions.js')

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

import type { VideoAssetRow } from './assets.js'

const FIXTURE_VIDEO_PENDING: VideoAssetRow = {
  id: 'video-pending-01',
  deckId: 'deck-alpha',
  componentId: null,
  folderId: null,
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
  componentId: null,
  folderId: null,
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
  componentId: null,
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
  fontAxes: null,
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
    expect(res.headers['cache-control']).toBe('private, max-age=600')
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
// Tests: DELETE /api/folders/:folderId/fonts/:assetId — folder editors, clones onto every deck
// ---------------------------------------------------------------------------

describe('DELETE /api/folders/:folderId/fonts/:assetId — a folder editor, clones on every deck', () => {
  /** A captured drizzle WHERE condition as the SQL Postgres would run. */
  function whereSql(condition: unknown): string {
    return new PgDialect().sqlToQuery(condition as SQL).sql
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
   *   - returns the folder (requireFolderRole's lookup; the caller's role in
   *     it comes from the mocked resolveFolderAccess),
   *   - returns `folderDecks` from the decks select, capturing its WHERE
   *     condition,
   *   - records the rows passed to insert(mediaAssets).
   */
  function buildFontApp(folderDecks: { id: string }[]) {
    const captured: { whereCondition?: unknown; insertedRows?: unknown[] } = {}
    let selectCall = 0

    const mockDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn((cond: unknown) => {
            selectCall += 1
            // 1st select = requireFolderRole (folders); 2nd = folderDecks.
            if (selectCall === 1) {
              return {
                limit: vi
                  .fn()
                  .mockResolvedValue([
                    { id: FOLDER_ID, ownerUserId: 'someone-else', name: 'Team' },
                  ]),
              }
            }
            if (selectCall === 2) {
              captured.whereCondition = cond
              // The decks select is awaited directly (no .limit()).
              return Promise.resolve(folderDecks)
            }
            // 3rd = which of the deleted row's keys other rows still name:
            // the clones share the file.
            return Promise.resolve(
              folderDecks.map(() => ({
                storageKey: FONT_ASSET.storageKey,
                playbackKey: null,
                posterKey: null,
                thumbnailKey: null,
              })),
            )
          }),
        })),
      })),
      transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockDb)),
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

  async function deleteFont(mockDb: Database) {
    const app = Fastify({ logger: false })
    registerAuthPlugin(app, { bypass: true, db: mockDb })
    await registerMediaRoutes(app, { db: mockDb })
    await app.ready()
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/folders/${FOLDER_ID}/fonts/font-asset-01`,
    })
    await app.close()
    return res
  }

  beforeEach(() => {
    vi.clearAllMocks()
    s3Send.mockReset().mockResolvedValue({})
    vi.mocked(roleAtLeast).mockImplementation(realRoleAtLeast)
    vi.mocked(getFolderFontAsset).mockResolvedValue(FONT_ASSET as never)
  })

  it('clones the font onto every deck of the folder, whoever created the deck', async () => {
    // A folder editor is an editor of every deck in it (folder sharing).
    vi.mocked(resolveFolderAccess).mockResolvedValue({ role: 'editor', reason: 'direct' })
    const { mockDb, captured } = buildFontApp([{ id: 'deck-mine' }, { id: 'deck-colleague' }])

    const res = await deleteFont(mockDb)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ promotedToDeckCount: 2 })
    expect(resolveFolderAccess).toHaveBeenCalledWith(expect.anything(), {
      folderId: FOLDER_ID,
      userId: 'dev-user',
      alsoAs: ['demo-user'],
    })
    // The folderDecks WHERE clause is the folder alone — no creator filter.
    expect(whereSql(captured.whereCondition)).toBe('"decks"."folder_id" = $1')
    const rows = (captured.insertedRows ?? []) as { deckId: string; folderId: unknown }[]
    expect(rows.map((r) => r.deckId)).toEqual(['deck-mine', 'deck-colleague'])
    expect(rows.every((r) => r.folderId === null)).toBe(true)
    // The clones name the file: it stays.
    expect(s3Send).not.toHaveBeenCalled()
  })

  it('promotes to zero decks when the folder holds none', async () => {
    vi.mocked(resolveFolderAccess).mockResolvedValue({ role: 'owner', reason: 'direct' })
    const { mockDb, captured } = buildFontApp([])

    const res = await deleteFont(mockDb)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ promotedToDeckCount: 0 })
    // No insert issued when there are no decks to clone onto.
    expect(captured.insertedRows).toBeUndefined()
    // No row names the file any more: it goes, through the purge that keeps named keys.
    const deleted = s3Send.mock.calls.map(
      (c) => (c[0] as { input: { Delete?: { Objects?: unknown[] } } }).input.Delete?.Objects,
    )
    expect(deleted).toEqual([
      [{ Key: FONT_ASSET.storageKey }, { Key: `${FONT_ASSET.storageKey}.info` }],
    ])
  })

  it('refuses a folder viewer, and anyone outside the folder, before touching the font', async () => {
    for (const access of [{ role: 'viewer', reason: 'direct' } as const, null]) {
      vi.mocked(resolveFolderAccess).mockResolvedValueOnce(access)
      const { mockDb, captured } = buildFontApp([{ id: 'deck-1' }])

      const res = await deleteFont(mockDb)

      expect(res.statusCode).toBe(403)
      expect(getFolderFontAsset).not.toHaveBeenCalled()
      expect(captured.insertedRows).toBeUndefined()
    }
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

// ---------------------------------------------------------------------------
// Tests: a component master's own media (A2.12b) under folder sharing
// ---------------------------------------------------------------------------

describe("a component master's media: read with the folder's content, handed to the folder by its editors", () => {
  let app: FastifyInstance
  const COMPONENT_FOLDER = 'folder-c'
  /** What the service's own UPDATE set (a removed master picture handed to its folder). */
  let handedOver: unknown[]

  const COMPONENT_IMAGE: MediaAsset = {
    ...FIXTURE_ASSET,
    id: 'comp-img-01',
    deckId: null,
    componentId: 'comp-1',
    storageKey: `comp-img-01:unknown:${Buffer.from('components/comp-1/uploads/comp-img-01/original.png').toString('base64url')}`,
  }
  const COMPONENT_VIDEO: VideoAssetRow = {
    ...FIXTURE_VIDEO_DONE,
    id: 'comp-vid-01',
    deckId: null,
    componentId: 'comp-1',
    posterKey: 'components/comp-1/videos/comp-vid-01/poster.jpg',
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    handedOver = []
    // The queries the service makes itself: the component's folder, and the
    // UPDATE that hands a removed master picture to that folder.
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => [{ folderId: COMPONENT_FOLDER }] }),
        }),
      }),
      update: () => ({
        set: (values: unknown) => ({
          where: () => ({
            returning: async () => {
              handedOver.push(values)
              return [{ id: 'comp-img-01' }]
            },
          }),
        }),
      }),
    } as unknown as Database
    app = Fastify({ logger: false })
    registerAuthPlugin(app, { bypass: true, db })
    await registerMediaRoutes(app, { db })
    await app.ready()
    // A deck role would let everyone in: it must never be consulted.
    vi.mocked(resolveDeckAccess).mockResolvedValue({ role: 'owner', reason: 'direct' })
    vi.mocked(roleAtLeast).mockImplementation(realRoleAtLeast)
  })

  it('a folder member gets the signed URL of the stored image', async () => {
    vi.mocked(getMediaAsset).mockResolvedValue(COMPONENT_IMAGE)
    vi.mocked(resolveFolderContentAccess).mockResolvedValue({ role: 'viewer', via: 'folder' })

    const res = await app.inject({ method: 'GET', url: '/api/media/comp-img-01/url?variant=thumb' })

    expect(res.statusCode).toBe(200)
    expect(resolveFolderContentAccess).toHaveBeenCalledWith(expect.anything(), {
      folderId: COMPONENT_FOLDER,
      userId: 'dev-user',
      shareToken: null,
    })
    expect(signImgproxyUrl).toHaveBeenCalledWith({
      storageKey: COMPONENT_IMAGE.storageKey,
      variant: 'thumb',
    })
    expect(resolveDeckAccess).not.toHaveBeenCalled()
  })

  it('a share link to a deck of the folder sees it too, so a stamp shows on the shared deck', async () => {
    vi.mocked(getMediaAsset).mockResolvedValue(COMPONENT_IMAGE)
    vi.mocked(resolveFolderContentAccess).mockResolvedValue({ role: 'viewer', via: 'deck' })

    const res = await app.inject({
      method: 'GET',
      url: '/api/media/comp-img-01/url?share_token=tok-1',
    })

    expect(res.statusCode).toBe(200)
    expect(resolveFolderContentAccess).toHaveBeenCalledWith(expect.anything(), {
      folderId: COMPONENT_FOLDER,
      userId: 'dev-user',
      shareToken: 'tok-1',
    })
    expect(resolveDeckAccess).not.toHaveBeenCalled()
  })

  it('anyone without access to the folder or one of its decks is refused, a share link included', async () => {
    vi.mocked(getMediaAsset).mockResolvedValue(COMPONENT_IMAGE)
    vi.mocked(resolveFolderContentAccess).mockResolvedValue(null)

    const plain = await app.inject({ method: 'GET', url: '/api/media/comp-img-01/url' })
    const shared = await app.inject({
      method: 'GET',
      url: '/api/media/comp-img-01/url?share_token=tok-elsewhere',
    })

    expect(plain.statusCode).toBe(403)
    expect(shared.statusCode).toBe(403)
    expect(signImgproxyUrl).not.toHaveBeenCalled()
    expect(resolveDeckAccess).not.toHaveBeenCalled()
  })

  it('video-info answers a guest of a deck in the folder and refuses a share link to another folder', async () => {
    vi.mocked(getVideoAsset).mockResolvedValue(COMPONENT_VIDEO)
    vi.mocked(resolveFolderContentAccess).mockResolvedValueOnce({ role: 'viewer', via: 'deck' })

    const guest = await app.inject({ method: 'GET', url: '/api/media/comp-vid-01/video-info' })
    expect(guest.statusCode).toBe(200)
    expect(guest.json()).toMatchObject({ assetId: 'comp-vid-01', transcodeStatus: 'done' })

    vi.mocked(resolveFolderContentAccess).mockResolvedValueOnce(null)
    const shared = await app.inject({
      method: 'GET',
      url: '/api/media/comp-vid-01/video-info?share_token=tok-elsewhere',
    })
    expect(shared.statusCode).toBe(403)
    expect(resolveDeckAccess).not.toHaveBeenCalled()
  })

  it('removing it needs the editor role in its folder: a viewer and an outsider are refused', async () => {
    vi.mocked(getMediaAsset).mockResolvedValue(COMPONENT_IMAGE)
    for (const access of [{ role: 'viewer', reason: 'direct' } as const, null]) {
      vi.mocked(resolveFolderAccess).mockResolvedValueOnce(access)
      const res = await app.inject({ method: 'DELETE', url: '/api/media/comp-img-01' })
      expect(res.statusCode).toBe(403)
    }
    expect(handedOver).toEqual([])
    expect(deleteMediaAsset).not.toHaveBeenCalled()
  })

  it('a folder editor hands it to the folder: nothing is deleted, stamps keep showing it', async () => {
    vi.mocked(getMediaAsset).mockResolvedValue(COMPONENT_IMAGE)
    vi.mocked(resolveFolderAccess).mockResolvedValueOnce({ role: 'editor', reason: 'direct' })

    const res = await app.inject({ method: 'DELETE', url: '/api/media/comp-img-01' })

    expect(res.statusCode).toBe(204)
    expect(resolveFolderAccess).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ folderId: COMPONENT_FOLDER, userId: 'dev-user' }),
    )
    expect(handedOver).toEqual([{ componentId: null, folderId: COMPONENT_FOLDER }])
    expect(deleteMediaAsset).not.toHaveBeenCalled()
  })
})
