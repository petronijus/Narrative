/**
 * media/routes.test.ts
 *
 * Tests for GET /api/media/:assetId/url, GET /api/media/urls and DELETE /api/media/:assetId.
 * Uses in-process Fastify instance with mocked DB and auth.
 *
 * Auth strategy:
 *   - registerAuthPlugin is called with bypass=true → all requests run as 'dev-user'.
 *   - resolveDeckAccess is mocked to control access outcomes.
 *   - getMediaAsset is mocked to return a fixture or null.
 *   - signImgproxyUrl is mocked to return a deterministic URL.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { FastifyInstance } from 'fastify'
import type { Database } from '../db/client.js'
import type { MediaAsset } from '../db/schema.js'
import { MEDIA_URLS_MAX_IDS, type MediaUrlsResponse } from '@narrative/shared'
import { registerAuthPlugin } from '../auth/fastifyAuth.js'
import { registerMediaRoutes } from './routes.js'
import { metrics } from '../metrics/collectors.js'

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

// The batched URL read's one query; the rest of the module is real.
vi.mock('./visibleMedia.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./visibleMedia.js')>()),
  readPlacedMedia: vi.fn(),
}))

vi.mock('../auth/permissions.js', () => ({
  resolveDeckAccess: vi.fn(),
  resolveDecksAccess: vi.fn(),
  resolveComponentAccess: vi.fn(),
  resolveFolderAccess: vi.fn(),
  resolveFolderContentAccess: vi.fn(),
  roleAtLeast: vi.fn(),
}))

import { getMediaAsset, getVideoAsset, deleteMediaAsset, getFolderFontAsset } from './assets.js'
import { signImgproxyUrl } from './imgproxyUrl.js'
import { readPlacedMedia } from './visibleMedia.js'
import { presignGetUrl } from './s3Client.js'
import {
  resolveComponentAccess,
  resolveDeckAccess,
  resolveDecksAccess,
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
  presentPlaybackKey: null,
  presentWidth: null,
  presentHeight: null,
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
  presentPlaybackKey: null,
  presentWidth: null,
  presentHeight: null,
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
  presentPlaybackKey: null,
  presentWidth: null,
  presentHeight: null,
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

  // A forbidden asset answers exactly as an unknown one: status, body and
  // headers say nothing of whether it exists (performance.md → F6).
  async function unknownAnswer() {
    vi.mocked(getMediaAsset).mockResolvedValueOnce(null)
    return app.inject({ method: 'GET', url: '/api/media/nonexistent/url' })
  }

  it('answers 404, as for an unknown id, when the user has no deck access', async () => {
    const unknown = await unknownAnswer()
    vi.mocked(getMediaAsset).mockResolvedValue(FIXTURE_ASSET)
    vi.mocked(resolveDeckAccess).mockResolvedValue(null)
    vi.mocked(roleAtLeast).mockReturnValue(false)

    const res = await app.inject({
      method: 'GET',
      url: '/api/media/asset-test-01/url',
    })

    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual(unknown.json())
    expect(res.json()).toEqual({ error: 'Asset not found' })
    expect(res.headers['cache-control']).toBe(unknown.headers['cache-control'])
    expect(signImgproxyUrl).not.toHaveBeenCalled()
  })

  it('answers 404 when the role is insufficient (below viewer)', async () => {
    vi.mocked(getMediaAsset).mockResolvedValue(FIXTURE_ASSET)
    // resolveDeckAccess returns some access but roleAtLeast says insufficient
    vi.mocked(resolveDeckAccess).mockResolvedValue({ role: 'viewer', reason: 'share-link' })
    vi.mocked(roleAtLeast).mockReturnValue(false)

    const res = await app.inject({
      method: 'GET',
      url: '/api/media/asset-test-01/url',
    })

    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'Asset not found' })
  })

  it('answers a malformed share_token on a forbidden asset exactly as on an unknown id, before any lookup', async () => {
    // A NUL byte or a repeated parameter used to reach Postgres (500) for an
    // existing asset while an unknown one answered 404: an existence oracle.
    for (const query of ['?share_token=%00', '?share_token=a&share_token=b']) {
      vi.mocked(getMediaAsset).mockClear()
      vi.mocked(getMediaAsset).mockResolvedValue(null)
      const unknown = await app.inject({ method: 'GET', url: `/api/media/nonexistent/url${query}` })
      vi.mocked(getMediaAsset).mockResolvedValue(FIXTURE_ASSET)
      vi.mocked(resolveDeckAccess).mockResolvedValue(null)
      vi.mocked(roleAtLeast).mockReturnValue(false)
      const forbidden = await app.inject({
        method: 'GET',
        url: `/api/media/asset-test-01/url${query}`,
      })

      expect(forbidden.statusCode, query).toBe(401)
      expect(forbidden.statusCode, query).toBe(unknown.statusCode)
      expect(forbidden.body, query).toBe(unknown.body)
      expect(forbidden.json()).toEqual({ error: 'Unauthorized' })
      expect(getMediaAsset).not.toHaveBeenCalled()
      expect(resolveDeckAccess).not.toHaveBeenCalled()
    }
  })

  it('keeps the reason of a refusal server-side only: in the metrics, never in the answer', async () => {
    metrics._reset()
    await unknownAnswer()
    vi.mocked(getMediaAsset).mockResolvedValue(FIXTURE_ASSET)
    vi.mocked(resolveDeckAccess).mockResolvedValue(null)
    vi.mocked(roleAtLeast).mockReturnValue(false)
    const res = await app.inject({ method: 'GET', url: '/api/media/asset-test-01/url' })

    expect(res.body).not.toMatch(/forbidden/i)
    expect(metrics.mediaRefusals('url')).toMatchObject({ unknown: 1, forbidden: 1 })
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
    expect(res.headers['vary']).toBe('Cookie')
  })

  it('answers images only: a video asset is 404', async () => {
    vi.mocked(getMediaAsset).mockResolvedValue({ ...FIXTURE_ASSET, kind: 'video' })
    vi.mocked(resolveDeckAccess).mockResolvedValue({ role: 'owner', reason: 'direct' })
    vi.mocked(roleAtLeast).mockReturnValue(true)

    const res = await app.inject({ method: 'GET', url: '/api/media/asset-test-01/url' })

    expect(res.statusCode).toBe(404)
    expect(signImgproxyUrl).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Tests: GET /api/media/urls
// ---------------------------------------------------------------------------

describe('GET /api/media/urls — many assets in one request, the access rules of the single route', () => {
  let app: FastifyInstance

  /** A row as readPlacedMedia returns it: the asset with its component's folder. */
  const placed = (
    over: Partial<MediaAsset> & { id: string },
    componentFolderId: string | null = null,
  ) => ({
    ...FIXTURE_ASSET,
    storageKey: `decks/deck-alpha/uploads/${over.id}/original.jpg`,
    ...over,
    componentFolderId,
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(signImgproxyUrl).mockImplementation(
      ({ storageKey, variant }) => `http://imgproxy.test/${variant}/${storageKey}`,
    )
    vi.mocked(roleAtLeast).mockImplementation(realRoleAtLeast)
    app = await buildApp()
  })

  afterEach(() => {
    // The other suites read the module mocks' defaults.
    vi.mocked(signImgproxyUrl).mockImplementation(
      () => 'http://imgproxy.test/SIGNED/path/to/image@webp',
    )
    vi.mocked(roleAtLeast).mockReset()
    vi.mocked(resolveDeckAccess).mockReset()
    vi.mocked(resolveDecksAccess).mockReset()
    vi.mocked(resolveFolderContentAccess).mockReset()
  })

  /** The decks' access, one call for all of them. */
  const decksAccess = (of: (deckId: string) => { role: 'viewer' | 'owner' } | null) =>
    vi
      .mocked(resolveDecksAccess)
      .mockImplementation(
        async (_db, { deckIds }) =>
          new Map(
            deckIds.map((id) => [
              id,
              of(id) === null ? null : { ...of(id)!, reason: 'direct' as const },
            ]),
          ),
      )

  it('answers every asked variant of each asset, with its size, checking the deck once', async () => {
    vi.mocked(readPlacedMedia).mockResolvedValue([
      placed({ id: 'a1', width: 3000, height: 2000 }),
      placed({ id: 'a2', width: null, height: null }),
      placed({ id: 'a3' }),
    ])
    decksAccess(() => ({ role: 'viewer' }))

    const res = await app.inject({
      method: 'GET',
      url: '/api/media/urls?ids=a1,a2,a3,a1&variants=preview,medium,display',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json<MediaUrlsResponse>()
    expect(Object.keys(body.assets).sort()).toEqual(['a1', 'a2', 'a3'])
    expect(body.assets['a1']).toEqual({
      urls: {
        preview: 'http://imgproxy.test/preview/decks/deck-alpha/uploads/a1/original.jpg',
        medium: 'http://imgproxy.test/medium/decks/deck-alpha/uploads/a1/original.jpg',
        display: 'http://imgproxy.test/display/decks/deck-alpha/uploads/a1/original.jpg',
      },
      width: 3000,
      height: 2000,
    })
    expect(body.assets['a2']).toMatchObject({ width: null, height: null })
    expect(body.unavailable).toEqual([])
    // One query for the rows (each id once), one check for their deck.
    expect(readPlacedMedia).toHaveBeenCalledOnce()
    expect(vi.mocked(readPlacedMedia).mock.calls[0]?.[1]).toEqual(['a1', 'a2', 'a3'])
    expect(resolveDecksAccess).toHaveBeenCalledOnce()
    expect(resolveDecksAccess).toHaveBeenCalledWith(expect.anything(), {
      deckIds: ['deck-alpha', 'deck-alpha', 'deck-alpha'],
      userId: 'dev-user',
      shareToken: null,
    })
    expect(res.headers['cache-control']).toBe('private, max-age=600')
    expect(res.headers['vary']).toBe('Cookie')
  })

  it('lists unknown assets and those of a deck the caller cannot read as unavailable, alike', async () => {
    vi.mocked(readPlacedMedia).mockResolvedValue([
      placed({ id: 'mine' }),
      placed({ id: 'theirs', deckId: 'deck-other' }),
    ])
    decksAccess((deckId) => (deckId === 'deck-alpha' ? { role: 'viewer' } : null))

    const res = await app.inject({
      method: 'GET',
      url: '/api/media/urls?ids=mine,theirs,gone&variants=display',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json<MediaUrlsResponse>()
    expect(Object.keys(body.assets)).toEqual(['mine'])
    expect(body.unavailable.sort()).toEqual(['gone', 'theirs'])
    expect(signImgproxyUrl).toHaveBeenCalledTimes(1)
    // A partial answer is not cached: what is missing may arrive.
    expect(res.headers['cache-control']).toBe('private, no-store')
  })

  it('answers images only: a video or a font of the deck is unavailable', async () => {
    vi.mocked(readPlacedMedia).mockResolvedValue([
      placed({ id: 'pic' }),
      placed({ id: 'clip', kind: 'video' }),
      placed({ id: 'face', kind: 'font' }),
    ])
    decksAccess(() => ({ role: 'owner' }))

    const res = await app.inject({ method: 'GET', url: '/api/media/urls?ids=pic,clip,face' })

    const body = res.json<MediaUrlsResponse>()
    expect(Object.keys(body.assets)).toEqual(['pic'])
    expect(body.unavailable.sort()).toEqual(['clip', 'face'])
  })

  it('checks every folder behind the assets, a few at a time, never more than the folders', async () => {
    const folders = Array.from({ length: 10 }, (_, i) => `folder-${i}`)
    vi.mocked(readPlacedMedia).mockResolvedValue(
      folders.flatMap((f, i) => [
        placed({ id: `x${i}`, deckId: null, folderId: f }),
        placed({ id: `y${i}`, deckId: null, componentId: `c${i}` }, f),
      ]),
    )
    let running = 0
    let most = 0
    vi.mocked(resolveFolderContentAccess).mockImplementation(async () => {
      running++
      most = Math.max(most, running)
      await new Promise((r) => setTimeout(r, 1))
      running--
      return { role: 'viewer', via: 'folder' }
    })

    const ids = folders.flatMap((_, i) => [`x${i}`, `y${i}`]).join(',')
    const res = await app.inject({ method: 'GET', url: `/api/media/urls?ids=${ids}` })

    expect(Object.keys(res.json<MediaUrlsResponse>().assets)).toHaveLength(20)
    expect(resolveFolderContentAccess).toHaveBeenCalledTimes(10)
    expect(most).toBeLessThanOrEqual(4)
    expect(resolveDecksAccess).not.toHaveBeenCalled()
  })

  it("reads a master's and a folder's media with the folder's content, once per folder, a share link included", async () => {
    vi.mocked(readPlacedMedia).mockResolvedValue([
      placed({ id: 'c1', deckId: null, componentId: 'comp-1' }, 'folder-c'),
      placed({ id: 'c2', deckId: null, componentId: 'comp-2' }, 'folder-c'),
      placed({ id: 'f1', deckId: null, folderId: 'folder-c' }),
      // A component that is gone: nobody reads its media.
      placed({ id: 'orphan', deckId: null, componentId: 'comp-gone' }, null),
    ])
    vi.mocked(resolveFolderContentAccess).mockResolvedValue({ role: 'viewer', via: 'deck' })

    const res = await app.inject({
      method: 'GET',
      url: '/api/media/urls?ids=c1,c2,f1,orphan&variants=thumb&share_token=tok-1',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json<MediaUrlsResponse>()
    expect(Object.keys(body.assets).sort()).toEqual(['c1', 'c2', 'f1'])
    expect(body.unavailable).toEqual(['orphan'])
    expect(resolveFolderContentAccess).toHaveBeenCalledOnce()
    expect(resolveFolderContentAccess).toHaveBeenCalledWith(expect.anything(), {
      folderId: 'folder-c',
      userId: 'dev-user',
      shareToken: 'tok-1',
    })
    // A deck role would let everyone in: it is never consulted for them.
    expect(resolveDecksAccess).not.toHaveBeenCalled()
  })

  it('refuses no ids, too many ids and an unknown variant before reading anything', async () => {
    const tooMany = Array.from({ length: MEDIA_URLS_MAX_IDS + 1 }, (_, i) => `id${i}`).join(',')
    for (const url of [
      '/api/media/urls',
      '/api/media/urls?ids=',
      `/api/media/urls?ids=${tooMany}`,
      `/api/media/urls?ids=${'x'.repeat(65)}`,
      '/api/media/urls?ids=a1&variants=display,4k',
    ]) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode, url).toBe(400)
    }
    expect(readPlacedMedia).not.toHaveBeenCalled()
  })

  it('takes display when no variant is named, as the single route does', async () => {
    vi.mocked(readPlacedMedia).mockResolvedValue([placed({ id: 'a1' })])
    decksAccess(() => ({ role: 'owner' }))

    const res = await app.inject({ method: 'GET', url: '/api/media/urls?ids=a1' })

    expect(Object.keys(res.json<MediaUrlsResponse>().assets['a1']!.urls)).toEqual(['display'])
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
    vi.mocked(deleteMediaAsset).mockResolvedValue([])

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

  it('answers 404, as for an unknown id, when the user has no deck access', async () => {
    vi.mocked(getVideoAsset).mockResolvedValueOnce(null)
    const unknown = await app.inject({ method: 'GET', url: '/api/media/nonexistent/video-info' })
    vi.mocked(getVideoAsset).mockResolvedValue(FIXTURE_VIDEO_PENDING)
    vi.mocked(resolveDeckAccess).mockResolvedValue(null)
    vi.mocked(roleAtLeast).mockReturnValue(false)

    const res = await app.inject({
      method: 'GET',
      url: '/api/media/video-pending-01/video-info',
    })

    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'Video asset not found' })
    expect(res.json()).toEqual(unknown.json())
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

    // 404, as for an unknown id: whether the asset exists is not told.
    expect(plain.statusCode).toBe(404)
    expect(shared.statusCode).toBe(404)
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
    // As for an unknown id: the link's holder is not told the video exists.
    expect(shared.statusCode).toBe(404)
    expect(resolveDeckAccess).not.toHaveBeenCalled()
  })

  it('removing it needs the editor role in its folder: a viewer and a deck guest are refused, a stranger told nothing', async () => {
    vi.mocked(getMediaAsset).mockResolvedValue(COMPONENT_IMAGE)
    // A viewer of the folder: it sees the picture, so it is told why not.
    vi.mocked(resolveFolderAccess).mockResolvedValueOnce({ role: 'viewer', reason: 'direct' })
    const viewer = await app.inject({ method: 'DELETE', url: '/api/media/comp-img-01' })
    expect(viewer.statusCode).toBe(403)
    // A guest of one of the folder's decks sees it too: 403.
    vi.mocked(resolveFolderAccess).mockResolvedValueOnce(null)
    vi.mocked(resolveFolderContentAccess).mockResolvedValueOnce({ role: 'viewer', via: 'deck' })
    const guest = await app.inject({ method: 'DELETE', url: '/api/media/comp-img-01' })
    expect(guest.statusCode).toBe(403)
    // A stranger, who cannot read it: the answer to an unknown id.
    vi.mocked(resolveFolderAccess).mockResolvedValueOnce(null)
    vi.mocked(resolveFolderContentAccess).mockResolvedValueOnce(null)
    const stranger = await app.inject({ method: 'DELETE', url: '/api/media/comp-img-01' })
    vi.mocked(getMediaAsset).mockResolvedValueOnce(null)
    const unknown = await app.inject({ method: 'DELETE', url: '/api/media/nonexistent' })
    expect(stranger.statusCode).toBe(404)
    expect(stranger.json()).toEqual(unknown.json())
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
