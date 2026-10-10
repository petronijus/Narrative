/**
 * media/routes.ts
 *
 * REST routes for the media subsystem.
 *
 *   GET  /api/media/:assetId/url?variant=<thumb|display|original>
 *     Returns a signed imgproxy URL for the given asset + variant.
 *     Auth: a session or `?share_token=` (shareReadPreHandler — a share-link
 *     visitor's deck renders with its media). Deck access: viewer or above.
 *     Cache-Control: private, max-age=600 (10 min). Signed URLs are stable, so the
 *     browser may keep one; a shared cache must not (it would hand one viewer's
 *     answer to another — component media is only for its folder's readers).
 *
 *   GET  /api/media/:assetId/video-info
 *     Returns transcode status + signed poster/thumbnail URLs + progressive MP4 playback URL.
 *     Auth: a session or `?share_token=` (shareReadPreHandler). Deck access:
 *     viewer or above.
 *     Poll this endpoint at 2 s intervals until transcodeStatus === 'done'.
 *
 *   GET  /api/media/:assetId/font-url
 *     Returns a short-TTL presigned MinIO URL for a font asset's bytes plus
 *     parsed metadata (MEDIA-1: bucket is private). M16 P3: only resolves
 *     folder-scoped fonts now (kind='font', folder_id IS NOT NULL,
 *     deck_id IS NULL). Auth: the caller may read the folder's content (a
 *     member, or a guest of one of its decks — `?share_token=` included).
 *
 *   POST   /api/folders/:folderId/fonts
 *   GET    /api/folders/:folderId/fonts   (also with `?share_token=` to a deck of the folder)
 *   DELETE /api/folders/:folderId/fonts/:assetId
 *     Folder-scoped custom font management. See "Folder fonts (M16 P3)" section.
 *
 *   DELETE /api/media/:assetId
 *     A deck's asset: its row and stored files go (deck owner). A component
 *     master's picture or video is handed to its folder (folder editor):
 *     the stamps that link it keep showing it. A folder's own picture or
 *     video: folder owner only. A folder font answers 400 naming
 *     DELETE /api/folders/:folderId/fonts/:assetId (services/media.ts remove).
 *
 * Security notes:
 *   - Share token (viewer via share link) does NOT permit uploads — only reads.
 *   - Deck ownership verified via getMediaAsset → deckId → resolveDeckAccess chain.
 *   - A component master's picture or video (A2.12b, `component_id` set):
 *     url and video-info answer whoever may read the component's folder
 *     content — its members and the guests of its decks, share links
 *     included (canReadComponentMedia); DELETE hands it to the folder and
 *     needs an editor of the folder.
 *   - MEDIA-1: the MinIO bucket is PRIVATE (no anonymous download policy).
 *     Every media URL handed to a client is either an imgproxy-signed URL
 *     (images, posters, thumbnails — stable HMAC) or a short-TTL S3 presigned
 *     URL (video playback, font bytes). Access re-authorizes on each fetch,
 *     so a revoked share/permission can't keep fetching media past the TTL.
 *     MinIO still serves byte-range requests against a presigned URL so a
 *     plain <video> can seek without HLS.
 *
 * Shared implementation: the handlers call services/media.ts, services/folders.ts and services/decks.ts — the same code the
 * `media.*, folder.fonts.* and deck.fonts.list` agent commands run (ADR 0010), so the two cannot drift apart.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Database } from '../db/client.js'
import { authPreHandler, shareReadPreHandler } from '../auth/fastifyAuth.js'
import { resolveDeckAccess } from '../auth/permissions.js'
import { createMediaService, isImageVariant, IMAGE_VARIANTS } from '../services/media.js'
import {
  ALLOWED_FONT_MIME_TYPES,
  createFoldersService,
  MAX_FOLDER_FONT_BYTES,
} from '../services/folders.js'
import { createDecksService } from '../services/decks.js'
import { routeDeps } from '../services/http.js'
import { sendServiceError } from '../services/errors.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Presigned-URL TTLs, the folder-font limits and MIME allowlist, and every
// handler's logic live in the services the agent commands call too
// (services/media.ts, services/folders.ts, services/decks.ts).

const MAX_FONT_BYTES = MAX_FOLDER_FONT_BYTES

export interface MediaRoutesOpts {
  db: Database
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
  // Register a buffer-mode content-type parser for every MIME a
  // browser might attach to a font file. Without a registered parser
  // Fastify returns 415 BEFORE the route handler runs, so the route
  // can't apply its own (more permissive) allowlist. Mirror the
  // ALLOWED_FONT_MIME_TYPES set above so any MIME we accept at the
  // route level also has a parser registered here.
  for (const mime of [
    'font/ttf',
    'font/otf',
    'font/woff',
    'font/woff2',
    'font/sfnt',
    'application/font-woff',
    'application/font-woff2',
    'application/font-sfnt',
    'application/vnd.ms-opentype',
    'application/vnd.ms-fontobject',
    'application/x-font-ttf',
    'application/x-font-otf',
    'application/x-font-opentype',
    'application/x-font-truetype',
    'application/x-font-woff',
    'application/x-font-sfnt',
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
  }>('/api/media/:assetId/url', { preHandler: shareReadPreHandler }, async (request, reply) => {
    const variantParam = request.query.variant ?? 'display'
    if (!isImageVariant(variantParam)) {
      return reply.status(400).send({
        error: `Invalid variant. Allowed: ${IMAGE_VARIANTS.join(', ')}`,
      })
    }
    try {
      const result = await createMediaService(routeDeps(app, db, request.log)).url({
        userId: request.user?.sub ?? null,
        shareToken: (request.query as Record<string, string>)['share_token'] ?? null,
        assetId: request.params.assetId,
        variant: variantParam,
      })
      return reply.header('Cache-Control', 'private, max-age=600').send(result)
    } catch (err) {
      return sendServiceError(reply, err)
    }
  })

  // -------------------------------------------------------------------------
  // GET /api/media/:assetId/video-info
  //
  // Returns transcode state + signed image URLs + progressive MP4 playback URL.
  // Poll at 2 s intervals until transcodeStatus === 'done'.
  // -------------------------------------------------------------------------
  app.get<{
    Params: { assetId: string }
    Querystring: { share_token?: string }
  }>(
    '/api/media/:assetId/video-info',
    { preHandler: shareReadPreHandler },
    async (request, reply) => {
      try {
        return reply.send(
          await createMediaService(routeDeps(app, db, request.log)).videoInfo({
            userId: request.user?.sub ?? null,
            shareToken: request.query.share_token ?? null,
            assetId: request.params.assetId,
          }),
        )
      } catch (err) {
        return sendServiceError(reply, err)
      }
    },
  )

  // -------------------------------------------------------------------------
  // GET /api/media/:assetId/font-url
  //
  // M16 P3: resolves folder-scoped font assets only. Auth is folder-ownership
  // (deck access no longer applies — fonts are no longer deck-scoped).
  // -------------------------------------------------------------------------
  app.get<{
    Params: { assetId: string }
    Querystring: { share_token?: string }
  }>(
    '/api/media/:assetId/font-url',
    { preHandler: shareReadPreHandler },
    async (request, reply) => {
      const userId = request.user?.sub ?? null
      const shareToken = request.query.share_token ?? null
      if (!userId && !shareToken) {
        return reply.status(401).send({ error: 'Unauthenticated' })
      }
      try {
        const info = await createMediaService(routeDeps(app, db, request.log)).fontUrl({
          userId,
          shareToken,
          assetId: request.params.assetId,
        })
        // Short-TTL presigned URL (MEDIA-1, private bucket): not immutable-
        // cacheable any more — the URL rotates per TTL, so browser caching is
        // capped well under the TTL and private (the URL embeds auth).
        return reply.header('Cache-Control', 'private, max-age=300').send(info)
      } catch (err) {
        return sendServiceError(reply, err)
      }
    },
  )

  // -------------------------------------------------------------------------
  // Folder fonts (M16 P3)
  // -------------------------------------------------------------------------

  // POST /api/folders/:folderId/fonts — upload a font file
  //
  // Optional `?fontFamily=<override>` query param: when present, the
  // server stamps the media_assets row's `font_family` with the supplied
  // value instead of the family name read from the file's `name` table.
  // Used by the post-import missing-fonts dialog so a user-uploaded TTF
  // binds to the PPTX-authored typeface name even when the file's
  // internal name differs. Weight + style + postscript name still come
  // from opentype.js — they describe the bytes themselves and can't be
  // overridden without lying.
  app.post<{
    Params: { folderId: string }
    Querystring: { fontFamily?: string }
  }>('/api/folders/:folderId/fonts', { preHandler: authPreHandler }, async (request, reply) => {
    const { folderId } = request.params
    const userId = (request as FastifyRequest & { user?: { sub: string } }).user!.sub

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

    // The editor role in the folder, the empty / 10 MB checks, parsing and the postscript
    // collision check all happen in the service, in that order.
    try {
      const font = await createFoldersService(routeDeps(app, db, request.log)).uploadFont({
        userId,
        folderId,
        source: { kind: 'bytes', bytes: fileBuffer, mimeType, filename: originalFilename },
        familyOverride: request.query.fontFamily,
      })
      return reply.status(201).send(font)
    } catch (err) {
      return sendServiceError(reply, err)
    }
  })

  // GET /api/folders/:folderId/fonts — list folder fonts
  app.get<{
    Params: { folderId: string }
    Querystring: { share_token?: string }
  }>(
    '/api/folders/:folderId/fonts',
    { preHandler: shareReadPreHandler },
    async (request, reply) => {
      const userId = request.user?.sub ?? null
      const shareToken = request.query.share_token ?? null
      if (!userId && !shareToken) {
        return reply.status(401).send({ error: 'Unauthenticated' })
      }
      try {
        const fonts = await createFoldersService(routeDeps(app, db, request.log)).listFonts({
          userId,
          shareToken,
          folderId: request.params.folderId,
        })
        return reply.header('Cache-Control', 'private, no-cache').send({ fonts })
      } catch (err) {
        return sendServiceError(reply, err)
      }
    },
  )

  // DELETE /api/folders/:folderId/fonts/:assetId — remove a folder font
  app.delete<{
    Params: { folderId: string; assetId: string }
  }>(
    '/api/folders/:folderId/fonts/:assetId',
    { preHandler: authPreHandler },
    async (request, reply) => {
      try {
        const result = await createFoldersService(routeDeps(app, db, request.log)).deleteFont({
          userId: (request as FastifyRequest & { user?: { sub: string } }).user!.sub,
          folderId: request.params.folderId,
          assetId: request.params.assetId,
        })
        return reply.status(200).send(result)
      } catch (err) {
        return sendServiceError(reply, err)
      }
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
  }>('/api/decks/:deckId/fonts', { preHandler: shareReadPreHandler }, async (request, reply) => {
    const { deckId } = request.params
    const userId = request.user?.sub ?? null
    const shareToken = (request.query as Record<string, string>)['share_token'] ?? null

    const access = await resolveDeckAccess(db, { deckId, userId, shareToken })
    if (!access) return reply.status(403).send({ error: 'Forbidden' })

    try {
      const fonts = await createDecksService(routeDeps(app, db, request.log)).listFonts({ deckId })
      return reply.header('Cache-Control', 'private, no-cache').send({ fonts })
    } catch (err) {
      return sendServiceError(reply, err)
    }
  })

  // -------------------------------------------------------------------------
  // DELETE /api/media/:assetId — a deck's asset: its owner; a master's
  // picture or video is handed to its folder by a folder editor; a folder's
  // own: the folder owner (services/media.ts `remove`). 204 either way.
  // -------------------------------------------------------------------------
  app.delete<{
    Params: { assetId: string }
  }>('/api/media/:assetId', { preHandler: authPreHandler }, async (request, reply) => {
    try {
      await createMediaService(routeDeps(app, db, request.log)).delete({
        userId: request.user?.sub ?? '',
        assetId: request.params.assetId,
      })
      return reply.status(204).send()
    } catch (err) {
      return sendServiceError(reply, err)
    }
  })
}
