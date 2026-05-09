/**
 * media/routes.ts
 *
 * REST routes for the media subsystem.
 *
 *   GET  /api/media/:assetId/url?variant=<thumb|display|original>
 *     Returns a signed imgproxy URL for the given asset + variant.
 *     Auth: JWT required (authPreHandler). Deck access: viewer or above.
 *     Cache-Control: max-age=600 (10 min). Signed URLs are stable so caching is safe.
 *
 *   GET  /api/media/:assetId/video-info
 *     Returns transcode status + signed poster/thumbnail URLs + HLS manifest URL.
 *     Auth: JWT required. Deck access: viewer or above.
 *     Poll this endpoint at 2 s intervals until transcodeStatus === 'done'.
 *
 *   GET  /api/media/:assetId/font-url
 *     Returns the raw MinIO URL for a font asset's bytes plus parsed metadata.
 *     M16 P3: only resolves folder-scoped fonts now (kind='font', folder_id IS NOT NULL,
 *     deck_id IS NULL). Auth: caller must own the folder.
 *
 *   POST   /api/folders/:folderId/fonts
 *   GET    /api/folders/:folderId/fonts
 *   DELETE /api/folders/:folderId/fonts/:assetId
 *     Folder-scoped custom font management. See "Folder fonts (M16 P3)" section.
 *
 *   DELETE /api/media/:assetId
 *     Removes the media_assets row (owner only).
 *     The MinIO object is NOT deleted — documented M29 GC TODO.
 *
 * Security notes:
 *   - Share token (viewer via share link) does NOT permit uploads — only reads.
 *   - Deck ownership verified via getMediaAsset → deckId → resolveDeckAccess chain.
 *   - hlsManifestUrl uses direct MinIO URL (public bucket policy for dev).
 *     TODO(M29): switch to MinIO presigned URLs when bucket becomes private.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { Database } from '../db/client.js'
import { decks, folders, mediaAssets } from '../db/schema.js'
import {
  getMediaAsset,
  getVideoAsset,
  getFontAsset,
  deleteMediaAsset,
  listFolderFontAssets,
  listDeckFontAssets,
  getFolderFontAsset,
  folderFontPostscriptCollides,
} from './assets.js'
import { signImgproxyUrl, type ImgproxyVariant } from './imgproxyUrl.js'
import { authPreHandler } from '../auth/fastifyAuth.js'
import { resolveDeckAccess, roleAtLeast } from '../auth/permissions.js'
import { parseFontMetadata } from './fontMetadata.js'
import { buildS3Client, MEDIA_BUCKET, presignGetUrl } from './s3Client.js'
import { PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the public MinIO base URL for direct object access.
 * Used for HLS manifest URLs (M12 dev: public bucket policy).
 *
 * MINIO_PUBLIC_URL can be:
 *   - absolute (`http://localhost:9100`) — for Vite-independent clients
 *   - path-only  (`/storage`)            — same-origin via Vite proxy (dev)
 *
 * Default is `/storage` so the browser fetches the manifest same-origin
 * through Vite's dev proxy (configured in apps/web/vite.config.ts). The
 * manifest's relative variant playlist and segment paths then resolve
 * against `/storage/...` and also go through the proxy, which keeps
 * hls.js happy without MinIO CORS.
 *
 * TODO(M29): replace with presigned URL generation for private buckets.
 */
function publicMinioBaseUrl(): string {
  const endpoint = process.env['MINIO_PUBLIC_URL'] ?? '/storage'
  const bucket = process.env['MEDIA_BUCKET'] ?? 'narrative-media'
  return `${endpoint}/${bucket}`
}

export interface MediaRoutesOpts {
  db: Database
}

const ALLOWED_VARIANTS: ImgproxyVariant[] = ['thumb', 'display', 'original']

function isImgproxyVariant(v: string): v is ImgproxyVariant {
  return (ALLOWED_VARIANTS as string[]).includes(v)
}

// ---------------------------------------------------------------------------
// Folder font upload — constants + helpers
// ---------------------------------------------------------------------------

const MAX_FONT_BYTES = 10 * 1024 * 1024 // 10 MB

const ALLOWED_FONT_MIME_TYPES = new Set([
  'font/ttf',
  'font/otf',
  'font/woff2',
  'application/font-woff2',
  'application/x-font-ttf',
  'application/x-font-opentype',
  // Some clients send application/octet-stream; we check the extension too.
  'application/octet-stream',
])

const FONT_MIME_TO_EXT: Record<string, string> = {
  'font/ttf': 'ttf',
  'font/otf': 'otf',
  'font/woff2': 'woff2',
  'application/font-woff2': 'woff2',
  'application/x-font-ttf': 'ttf',
  'application/x-font-opentype': 'otf',
}

function fontExtFromMime(mime: string, originalName?: string): string {
  const fromMime = FONT_MIME_TO_EXT[mime]
  if (fromMime) return fromMime
  if (originalName) {
    const dot = originalName.lastIndexOf('.')
    if (dot !== -1) {
      const ext = originalName.slice(dot + 1).toLowerCase()
      if (['ttf', 'otf', 'woff2'].includes(ext)) return ext
    }
  }
  return 'ttf'
}

/**
 * Resolve folder row and verify the caller owns it.
 * Returns true on success; on failure sends a reply and returns false.
 */
async function requireFolderOwner(
  db: Database,
  folderId: string,
  userId: string,
  reply: FastifyReply,
): Promise<boolean> {
  const [folder] = await db
    .select({ id: folders.id, ownerUserId: folders.ownerUserId })
    .from(folders)
    .where(eq(folders.id, folderId))
    .limit(1)

  if (!folder) {
    void reply.status(404).send({ error: 'Folder not found' })
    return false
  }
  if (folder.ownerUserId !== userId) {
    void reply.status(403).send({ error: 'Forbidden' })
    return false
  }
  return true
}

function serializeFolderFontRow(
  row: Awaited<ReturnType<typeof listFolderFontAssets>>[number],
  url: string,
) {
  return {
    assetId: row.id,
    family: row.fontFamily,
    weight: row.fontWeight,
    style: row.fontStyle,
    postscriptName: row.fontPostscriptName,
    url,
    sizeBytes: row.sizeBytes,
    uploadedAt: row.createdAt.toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function registerMediaRoutes(
  app: FastifyInstance,
  opts: MediaRoutesOpts,
): Promise<void> {
  const { db } = opts

  // Raw-buffer body parser for font uploads. Fastify rejects unknown
  // content-types with 415 by default — register every font MIME we
  // accept (including application/octet-stream) so handlers see the
  // body as a Buffer.
  const fontBufferParser = (
    _req: FastifyRequest,
    payload: NodeJS.ReadableStream,
    done: (err: Error | null, body?: unknown) => void,
  ) => {
    const chunks: Buffer[] = []
    let total = 0
    payload.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
      chunks.push(buf)
      total += buf.length
      if (total > MAX_FONT_BYTES) {
        payload.removeAllListeners()
        done(new Error('Font exceeds 10 MB limit'))
      }
    })
    payload.on('end', () => done(null, Buffer.concat(chunks)))
    payload.on('error', (err) => done(err))
  }
  for (const mime of [
    'font/ttf',
    'font/otf',
    'font/woff2',
    'application/font-woff2',
    'application/x-font-ttf',
    'application/x-font-opentype',
    'application/octet-stream',
  ]) {
    try {
      app.addContentTypeParser(mime, { parseAs: 'buffer' }, (_req, body, done) => done(null, body))
    } catch {
      // Already registered (eg by tus for octet-stream variants) — safe to ignore.
    }
  }
  // Silence unused-warning if the streaming variant ends up unused.
  void fontBufferParser

  // -------------------------------------------------------------------------
  // GET /api/media/:assetId/url?variant=<variant>
  // -------------------------------------------------------------------------
  app.get<{
    Params: { assetId: string }
    Querystring: { variant?: string }
  }>('/api/media/:assetId/url', { preHandler: authPreHandler }, async (request, reply) => {
    const { assetId } = request.params
    const variantParam = request.query.variant ?? 'display'

    if (!isImgproxyVariant(variantParam)) {
      return reply.status(400).send({
        error: `Invalid variant. Allowed: ${ALLOWED_VARIANTS.join(', ')}`,
      })
    }

    // 1. Look up the asset
    const asset = await getMediaAsset(db, assetId)
    if (!asset) {
      return reply.status(404).send({ error: 'Asset not found' })
    }

    // 2. Resolve deck access — viewer is sufficient for reads
    const userId = request.user?.sub ?? null
    const shareToken = (request.query as Record<string, string>)['share_token'] ?? null
    const access = await resolveDeckAccess(db, {
      deckId: asset.deckId ?? '',
      userId,
      shareToken,
    })

    if (!access || !roleAtLeast(access.role, 'viewer')) {
      return reply.status(403).send({ error: 'Forbidden' })
    }

    // 3. Sign the imgproxy URL
    const url = signImgproxyUrl({
      storageKey: asset.storageKey,
      variant: variantParam,
    })

    return reply.header('Cache-Control', 'public, max-age=600').send({ url })
  })

  // -------------------------------------------------------------------------
  // GET /api/media/:assetId/video-info
  //
  // Returns transcode state + signed image URLs + HLS manifest URL for a video.
  // Poll at 2 s intervals until transcodeStatus === 'done'.
  // -------------------------------------------------------------------------
  app.get<{
    Params: { assetId: string }
    Querystring: { share_token?: string }
  }>('/api/media/:assetId/video-info', { preHandler: authPreHandler }, async (request, reply) => {
    const { assetId } = request.params

    const asset = await getVideoAsset(db, assetId)
    if (!asset) {
      return reply.status(404).send({ error: 'Video asset not found' })
    }

    const userId = request.user?.sub ?? null
    const shareToken = request.query.share_token ?? null
    const access = await resolveDeckAccess(db, { deckId: asset.deckId, userId, shareToken })

    if (!access || !roleAtLeast(access.role, 'viewer')) {
      return reply.status(403).send({ error: 'Forbidden' })
    }

    const posterUrl = asset.posterKey
      ? signImgproxyUrl({ storageKey: asset.posterKey, variant: 'display', extension: 'jpg' })
      : null

    const thumbnailUrl = asset.thumbnailKey
      ? signImgproxyUrl({ storageKey: asset.thumbnailKey, variant: 'thumb', extension: 'jpg' })
      : null

    // HLS manifest: direct MinIO URL (public bucket for M12 dev).
    // TODO(M29): generate presigned URL for private bucket policy.
    const hlsManifestUrl = asset.hlsManifestKey
      ? `${publicMinioBaseUrl()}/${asset.hlsManifestKey}`
      : null

    return reply.send({
      assetId: asset.id,
      transcodeStatus: asset.transcodeStatus,
      durationSec: asset.durationSec,
      width: asset.width,
      height: asset.height,
      posterUrl,
      thumbnailUrl,
      hlsManifestUrl,
      transcodeError: asset.transcodeError ?? null,
    })
  })

  // -------------------------------------------------------------------------
  // GET /api/media/:assetId/font-url
  //
  // M16 P3: resolves folder-scoped font assets only. Auth is folder-ownership
  // (deck access no longer applies — fonts are no longer deck-scoped).
  // -------------------------------------------------------------------------
  app.get<{
    Params: { assetId: string }
  }>('/api/media/:assetId/font-url', { preHandler: authPreHandler }, async (request, reply) => {
    const { assetId } = request.params

    const asset = await getFontAsset(db, assetId)
    if (!asset) {
      return reply.status(404).send({ error: 'Font asset not found' })
    }

    if (!asset.folderId) {
      // Legacy deck-scoped row (should have been migrated by 0009). Reject —
      // no caller path expects this branch any more.
      return reply.status(404).send({ error: 'Font asset is not folder-scoped' })
    }

    const userId = (request as FastifyRequest & { user?: { sub: string } }).user?.sub ?? null
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthenticated' })
    }
    const ok = await requireFolderOwner(db, asset.folderId, userId, reply)
    if (!ok) return

    // Raw MinIO URL — bucket is public for M12 dev; M29 will swap to
    // a presigned URL the same way HLS will.
    const url = `${publicMinioBaseUrl()}/${asset.storageKey}`

    return reply.header('Cache-Control', 'public, max-age=31536000, immutable').send({
      assetId: asset.id,
      url,
      family: asset.fontFamily,
      weight: asset.fontWeight,
      style: asset.fontStyle,
      postscriptName: asset.fontPostscriptName,
      mimeType: asset.mimeType,
    })
  })

  // -------------------------------------------------------------------------
  // Folder fonts (M16 P3)
  // -------------------------------------------------------------------------

  // POST /api/folders/:folderId/fonts — upload a font file
  app.post<{
    Params: { folderId: string }
  }>('/api/folders/:folderId/fonts', { preHandler: authPreHandler }, async (request, reply) => {
    const { folderId } = request.params
    const userId = (request as FastifyRequest & { user?: { sub: string } }).user!.sub

    const ok = await requireFolderOwner(db, folderId, userId, reply)
    if (!ok) return

    // Read the raw body. Fastify exposes it as Buffer on request.body when
    // Content-Type is not JSON. For font uploads the browser sends the file
    // as raw application/octet-stream (or a font/* MIME) — we read it here.
    // For multipart we fall back to checking if body has a `file` key.
    let fileBuffer: Buffer
    let mimeType: string
    let originalFilename: string | undefined

    const contentType = (request.headers['content-type'] ?? '').split(';')[0]?.trim() ?? ''

    if (contentType === 'multipart/form-data' || contentType.startsWith('multipart/')) {
      const body = request.body as Record<string, unknown> | undefined
      if (body && typeof body['file'] === 'object' && Buffer.isBuffer(body['file'])) {
        fileBuffer = body['file'] as Buffer
        mimeType = (body['mimeType'] as string | undefined) ?? 'application/octet-stream'
        originalFilename = body['filename'] as string | undefined
      } else {
        return reply.status(400).send({ error: 'Missing file field in multipart body' })
      }
    } else {
      const raw: unknown = request.body
      if (!raw) {
        return reply.status(400).send({ error: 'Font file body is empty or unreadable' })
      }
      if (Buffer.isBuffer(raw)) {
        fileBuffer = raw
      } else if (typeof raw === 'string') {
        fileBuffer = Buffer.from(raw)
      } else if (ArrayBuffer.isView(raw)) {
        fileBuffer = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
      } else {
        return reply.status(400).send({ error: 'Font file body is unreadable' })
      }
      mimeType = ALLOWED_FONT_MIME_TYPES.has(contentType) ? contentType : 'application/octet-stream'
      originalFilename =
        typeof request.headers['x-filename'] === 'string'
          ? (request.headers['x-filename'] as string)
          : undefined
    }

    if (fileBuffer.length === 0) {
      return reply.status(400).send({ error: 'Font file is empty' })
    }
    if (fileBuffer.length > MAX_FONT_BYTES) {
      return reply
        .status(413)
        .send({ error: `Font exceeds 10 MB limit (got ${fileBuffer.length} bytes)` })
    }

    // Parse font metadata — throws on invalid OpenType/TrueType data
    let meta: ReturnType<typeof parseFontMetadata>
    try {
      const arrayBuf = fileBuffer.buffer.slice(
        fileBuffer.byteOffset,
        fileBuffer.byteOffset + fileBuffer.byteLength,
      ) as ArrayBuffer
      meta = parseFontMetadata(arrayBuf)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply.status(422).send({ error: `Invalid font file: ${msg}` })
    }

    const collides = await folderFontPostscriptCollides(db, folderId, meta.postscriptName)
    if (collides) {
      return reply.status(409).send({
        error: 'A font with this postscript name already exists in this folder',
        postscriptName: meta.postscriptName,
      })
    }

    const assetId = nanoid(21)
    const ext = fontExtFromMime(mimeType, originalFilename)
    const storageKey = `fonts/${folderId}/${assetId}/original.${ext}`

    const s3 = buildS3Client()
    await s3.send(
      new PutObjectCommand({
        Bucket: MEDIA_BUCKET,
        Key: storageKey,
        Body: fileBuffer,
        ContentType: mimeType,
        ContentLength: fileBuffer.length,
      }),
    )

    await db.insert(mediaAssets).values({
      id: assetId,
      deckId: null,
      folderId,
      uploaderUserId: userId,
      mimeType,
      sizeBytes: fileBuffer.length,
      storageKey,
      originalFilename: originalFilename ?? null,
      kind: 'font',
      fontFamily: meta.family,
      fontWeight: meta.weight,
      fontStyle: meta.style,
      fontPostscriptName: meta.postscriptName,
    })

    const url = await presignGetUrl(storageKey)

    return reply.status(201).send({
      assetId,
      family: meta.family,
      weight: meta.weight,
      style: meta.style,
      postscriptName: meta.postscriptName,
      url,
      sizeBytes: fileBuffer.length,
      uploadedAt: new Date().toISOString(),
    })
  })

  // GET /api/folders/:folderId/fonts — list folder fonts
  app.get<{
    Params: { folderId: string }
  }>('/api/folders/:folderId/fonts', { preHandler: authPreHandler }, async (request, reply) => {
    const { folderId } = request.params
    const userId = (request as FastifyRequest & { user?: { sub: string } }).user!.sub

    const ok = await requireFolderOwner(db, folderId, userId, reply)
    if (!ok) return

    const rows = await listFolderFontAssets(db, folderId)
    const fonts = await Promise.all(
      rows.map(async (row) => {
        const url = await presignGetUrl(row.storageKey)
        return serializeFolderFontRow(row, url)
      }),
    )

    return reply.header('Cache-Control', 'private, no-cache').send({ fonts })
  })

  // DELETE /api/folders/:folderId/fonts/:assetId — remove a folder font
  app.delete<{
    Params: { folderId: string; assetId: string }
  }>(
    '/api/folders/:folderId/fonts/:assetId',
    { preHandler: authPreHandler },
    async (request, reply) => {
      const { folderId, assetId } = request.params
      const userId = (request as FastifyRequest & { user?: { sub: string } }).user!.sub

      const ok = await requireFolderOwner(db, folderId, userId, reply)
      if (!ok) return

      const asset = await getFolderFontAsset(db, assetId, folderId)
      if (!asset) {
        return reply.status(404).send({ error: 'Font asset not found' })
      }

      // Find decks in the folder. Each one gets a deck-scoped clone so any
      // presentation that references the font keeps rendering — the editor
      // surfaces a "deck-specific font" notice for those decks. We can't
      // cheaply scan Yjs docs to know which decks actually use the font;
      // cloning to all decks in the folder is the safe deterministic
      // option (storage is shared via the same MinIO key, so the only
      // cost is N media_assets rows).
      const folderDecks = await db
        .select({ id: decks.id })
        .from(decks)
        .where(eq(decks.folderId, folderId))

      let promotedToDeckCount = 0
      if (folderDecks.length > 0) {
        await db.insert(mediaAssets).values(
          folderDecks.map((d) => ({
            id: nanoid(),
            deckId: d.id,
            folderId: null,
            uploaderUserId: asset.uploaderUserId,
            mimeType: asset.mimeType,
            sizeBytes: asset.sizeBytes,
            storageKey: asset.storageKey,
            originalFilename: asset.originalFilename,
            kind: 'font' as const,
            fontFamily: asset.fontFamily,
            fontWeight: asset.fontWeight,
            fontStyle: asset.fontStyle,
            fontPostscriptName: asset.fontPostscriptName,
          })),
        )
        promotedToDeckCount = folderDecks.length
      }

      await db.delete(mediaAssets).where(eq(mediaAssets.id, assetId))

      // S3 object intentionally NOT deleted when clones exist — they share
      // the same storageKey. Only collect the orphan when no decks were
      // promoted (folder had no decks).
      if (promotedToDeckCount === 0) {
        try {
          const s3 = buildS3Client()
          await s3.send(new DeleteObjectCommand({ Bucket: MEDIA_BUCKET, Key: asset.storageKey }))
        } catch (err) {
          request.log.warn(
            { err, key: asset.storageKey },
            '[folderFonts] MinIO delete failed (orphaned)',
          )
        }
      }

      return reply.status(200).send({ promotedToDeckCount })
    },
  )

  // -------------------------------------------------------------------------
  // GET /api/decks/:deckId/fonts — list deck-scoped fonts
  //
  // Created when a folder font is deleted while presentations still
  // reference it (see DELETE /api/folders/:folderId/fonts/:assetId). The
  // editor mounts these alongside folder fonts so the deck keeps
  // rendering — and shows a "deck-specific font" notice for awareness.
  // -------------------------------------------------------------------------
  app.get<{
    Params: { deckId: string }
  }>('/api/decks/:deckId/fonts', { preHandler: authPreHandler }, async (request, reply) => {
    const { deckId } = request.params
    const userId = request.user?.sub ?? null
    const shareToken = (request.query as Record<string, string>)['share_token'] ?? null

    const access = await resolveDeckAccess(db, { deckId, userId, shareToken })
    if (!access) return reply.status(403).send({ error: 'Forbidden' })

    const rows = await listDeckFontAssets(db, deckId)
    const fonts = await Promise.all(
      rows.map(async (row) => {
        const url = await presignGetUrl(row.storageKey)
        return serializeFolderFontRow(row, url)
      }),
    )

    return reply.header('Cache-Control', 'private, no-cache').send({ fonts })
  })

  // -------------------------------------------------------------------------
  // DELETE /api/media/:assetId  (owner only)
  // -------------------------------------------------------------------------
  app.delete<{
    Params: { assetId: string }
  }>('/api/media/:assetId', { preHandler: authPreHandler }, async (request, reply) => {
    const { assetId } = request.params

    const asset = await getMediaAsset(db, assetId)
    if (!asset) {
      return reply.status(404).send({ error: 'Asset not found' })
    }

    const userId = request.user?.sub ?? null
    const access = await resolveDeckAccess(db, {
      deckId: asset.deckId ?? '',
      userId,
      shareToken: null,
    })

    if (!access || !roleAtLeast(access.role, 'owner')) {
      return reply.status(403).send({ error: 'Forbidden: owner role required' })
    }

    // NOTE: MinIO object remains — see TODO(M29) for GC job.
    await deleteMediaAsset(db, assetId)

    return reply.status(204).send()
  })
}
