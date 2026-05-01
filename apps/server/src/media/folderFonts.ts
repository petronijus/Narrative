/**
 * media/folderFonts.ts
 *
 * M16 P3: REST routes for folder-scoped custom fonts.
 *
 *   POST   /api/folders/:folderId/fonts
 *     Upload a TTF/OTF/WOFF2 font file scoped to a folder.
 *     Body: multipart/form-data with field `file`, OR raw binary with
 *     Content-Type header set to a font MIME type.
 *     Max size: 10 MB.
 *     Rejects if the postscript name already exists in this folder.
 *     Stores the file under `fonts/<folderId>/<assetId>/original.<ext>`.
 *     Returns: FontAssetRow as JSON.
 *
 *   GET    /api/folders/:folderId/fonts
 *     List all folder-scoped fonts (owner only).
 *     Each row includes a presigned download URL (1 h TTL).
 *
 *   DELETE /api/folders/:folderId/fonts/:assetId
 *     Remove a font asset (owner only).
 *     Deletes the DB row. MinIO blob is orphaned until the GC job (TODO M29).
 *
 * Auth: folder ownership is verified per-request against folders.owner_user_id.
 * Dev bypass (BYPASS_AUTH=true) synthesizes 'dev-user' for all requests —
 * same pattern as all other /api/folders/* routes.
 *
 * Storage key convention:
 *   fonts/<folderId>/<assetId>/original.<ext>
 *
 * Supported MIME types:
 *   font/ttf, font/otf, font/woff2, application/font-woff2,
 *   application/x-font-ttf, application/x-font-opentype
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { nanoid } from 'nanoid'
import { eq } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { folders, mediaAssets } from '../db/schema.js'
import { authPreHandler } from '../auth/fastifyAuth.js'
import { parseFontMetadata } from './fontMetadata.js'
import { listFolderFontAssets, getFolderFontAsset, folderFontPostscriptCollides } from './assets.js'
import { buildS3Client, MEDIA_BUCKET, presignGetUrl } from './s3Client.js'
import { PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_FONT_BYTES = 10 * 1024 * 1024 // 10 MB

const ALLOWED_MIME_TYPES = new Set([
  'font/ttf',
  'font/otf',
  'font/woff2',
  'application/font-woff2',
  'application/x-font-ttf',
  'application/x-font-opentype',
  // Some clients send application/octet-stream; we check the extension too.
  'application/octet-stream',
])

const MIME_TO_EXT: Record<string, string> = {
  'font/ttf': 'ttf',
  'font/otf': 'otf',
  'font/woff2': 'woff2',
  'application/font-woff2': 'woff2',
  'application/x-font-ttf': 'ttf',
  'application/x-font-opentype': 'otf',
}

function extFromMime(mime: string, originalName?: string): string {
  const fromMime = MIME_TO_EXT[mime]
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve folder row and verify the caller owns it.
 * Returns the folder row or throws a Fastify reply.
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

/**
 * Serialize a FontAssetRow to the wire format used by POST and GET responses.
 */
function serializeFontRow(
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

export async function registerFolderFontRoutes(app: FastifyInstance, db: Database): Promise<void> {
  // -------------------------------------------------------------------------
  // POST /api/folders/:folderId/fonts — upload a font file
  // -------------------------------------------------------------------------
  app.post<{
    Params: { folderId: string }
  }>('/api/folders/:folderId/fonts', { preHandler: authPreHandler }, async (request, reply) => {
    const { folderId } = request.params
    const userId = (request as FastifyRequest & { user?: { sub: string } }).user?.sub ?? 'dev-user'

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
      // Simple multipart: client posts { file: <binary>, filename?: string }
      // Fastify doesn't have built-in multipart — use raw body if possible.
      // Fallback: treat the full body as the file buffer (simple upload pattern).
      const body = request.body as Record<string, unknown> | undefined
      if (body && typeof body['file'] === 'object' && Buffer.isBuffer(body['file'])) {
        fileBuffer = body['file'] as Buffer
        mimeType = (body['mimeType'] as string | undefined) ?? 'application/octet-stream'
        originalFilename = body['filename'] as string | undefined
      } else {
        return reply.status(400).send({ error: 'Missing file field in multipart body' })
      }
    } else {
      // Raw binary upload (preferred). Fastify with the application/octet-stream
      // content-type parser delivers the body as a Buffer.
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
      mimeType = ALLOWED_MIME_TYPES.has(contentType) ? contentType : 'application/octet-stream'
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
    let meta: Awaited<ReturnType<typeof parseFontMetadata>>
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

    // Reject postscript name collision within this folder
    const collides = await folderFontPostscriptCollides(db, folderId, meta.postscriptName)
    if (collides) {
      return reply.status(409).send({
        error: 'A font with this postscript name already exists in this folder',
        postscriptName: meta.postscriptName,
      })
    }

    const assetId = nanoid(21)
    const ext = extFromMime(mimeType, originalFilename)
    const storageKey = `fonts/${folderId}/${assetId}/original.${ext}`

    // Upload to MinIO
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

    // Insert media_assets row (deckId = null for folder-scoped fonts)
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

  // -------------------------------------------------------------------------
  // GET /api/folders/:folderId/fonts — list folder fonts
  // -------------------------------------------------------------------------
  app.get<{
    Params: { folderId: string }
  }>('/api/folders/:folderId/fonts', { preHandler: authPreHandler }, async (request, reply) => {
    const { folderId } = request.params
    const userId = (request as FastifyRequest & { user?: { sub: string } }).user?.sub ?? 'dev-user'

    const ok = await requireFolderOwner(db, folderId, userId, reply)
    if (!ok) return

    const rows = await listFolderFontAssets(db, folderId)

    // Sign all URLs in parallel
    const fonts = await Promise.all(
      rows.map(async (row) => {
        const url = await presignGetUrl(row.storageKey)
        return serializeFontRow(row, url)
      }),
    )

    return reply.header('Cache-Control', 'private, no-cache').send({ fonts })
  })

  // -------------------------------------------------------------------------
  // DELETE /api/folders/:folderId/fonts/:assetId — remove a folder font
  // -------------------------------------------------------------------------
  app.delete<{
    Params: { folderId: string; assetId: string }
  }>(
    '/api/folders/:folderId/fonts/:assetId',
    { preHandler: authPreHandler },
    async (request, reply) => {
      const { folderId, assetId } = request.params
      const userId =
        (request as FastifyRequest & { user?: { sub: string } }).user?.sub ?? 'dev-user'

      const ok = await requireFolderOwner(db, folderId, userId, reply)
      if (!ok) return

      const asset = await getFolderFontAsset(db, assetId, folderId)
      if (!asset) {
        return reply.status(404).send({ error: 'Font asset not found' })
      }

      // Delete DB row first
      await db.delete(mediaAssets).where(eq(mediaAssets.id, assetId))

      // Best-effort MinIO cleanup (orphaned blobs will be reaped by GC job, TODO M29)
      try {
        const s3 = buildS3Client()
        await s3.send(new DeleteObjectCommand({ Bucket: MEDIA_BUCKET, Key: asset.storageKey }))
      } catch (err) {
        request.log.warn(
          { err, key: asset.storageKey },
          '[folderFonts] MinIO delete failed (orphaned)',
        )
      }

      return reply.status(204).send()
    },
  )
}
