/**
 * media/tus.ts
 *
 * Fastify plugin: mounts the tus resumable upload server at /api/uploads.
 *
 * Architecture:
 *   - Uses @tus/server v2 with @tus/s3-store (MinIO-compatible via forcePathStyle S3).
 *   - Fastify forwards raw Node.js req/res to tusServer.handle() for all /api/uploads/* requests.
 *   - Auth is enforced in onUploadCreate (JWT required, must have deck editor/owner role).
 *   - MIME validation: image/* only in M11; rejects with 415 on non-image content types.
 *   - On upload finish: reads S3 object head for size, probes image dimensions, inserts media_assets row.
 *   - Size limit: MAX_UPLOAD_SIZE env var, default 25 MB.
 *
 * Hook signatures (from @tus/server v2 types):
 *   onUploadCreate(req, res, upload) → Promise<{ res, metadata? }>
 *   onUploadFinish(req, res, upload) → Promise<{ res, status_code?, headers?, body? }>
 *   onIncomingRequest(req, res, uploadId) → Promise<void>
 *   namingFunction(req, metadata) → string | Promise<string>
 *
 * All hooks receive `req: http.IncomingMessage` — use req.headers['key'] syntax.
 *
 * Security:
 *   - storageKey is server-constructed — never user-supplied (no path traversal).
 *   - Share token (viewer) path does NOT grant upload rights — only JWT users with editor/owner role may upload.
 *   - MIME checked via Upload-Metadata content-type; probe-image-size confirms on finalize.
 *
 * Known limitations / TODOs:
 *   - Orphaned MinIO objects on termination/error are not cleaned up (documented M29 GC).
 *   - No per-user rate limiting (M29).
 *   - HLS presigned URLs for private buckets (M29).
 *   - Video width/height not available at upload time — filled by worker after ffprobe.
 */

import { createRequire } from 'node:module'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Readable } from 'node:stream'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { nanoid } from 'nanoid'
import { Server as TusServer } from '@tus/server'
import type { Upload } from '@tus/server'
import { S3Store } from '@tus/s3-store'
import type { S3ClientConfig } from '@aws-sdk/client-s3'
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import type { Database } from '../db/client.js'
import { createMediaAsset } from './assets.js'
import { sanitizeSvg, sniffIsSvg, magicBytesMatch, MAGIC_CHECKED_MIMES } from './svgSanitize.js'
import { enqueueVideoTranscode } from './enqueue.js'
import { parseFontMetadata } from './fontMetadata.js'
import {
  canDownscaleStoredImage,
  downscaleForStorage,
  exceedsStoredImageLimits,
} from './storedImageLimits.js'
import { resolveDeckAccess, roleAtLeast } from '../auth/permissions.js'
import { eq } from 'drizzle-orm'
import { folders, decks } from '../db/schema.js'
import { DeleteObjectCommand } from '@aws-sdk/client-s3'
import { importDeckFromPptxBytes } from '../pptx/importDeck.js'
import { appendPptxToDeck } from '../pptx/appendDeck.js'
import { lookupSession, readCookieFromHeader, SESSION_COOKIE_NAME } from '../auth/session.js'
import { subsystemLogger } from '../observability/logger.js'

const log = subsystemLogger('tus')

// probe-image-size is CommonJS — import via createRequire so ESM build works
const require = createRequire(import.meta.url)

const probe: (stream: Readable) => Promise<ProbeResult | null> = require('probe-image-size')

interface ProbeResult {
  width: number
  height: number
  type: string
  mime: string
}

// ---------------------------------------------------------------------------
// Config constants
// ---------------------------------------------------------------------------

/** Max size for image uploads. */
const MAX_FONT_UPLOAD_SIZE = Number(process.env['MAX_FONT_UPLOAD_SIZE'] ?? 8_000_000)
const MAX_IMAGE_UPLOAD_SIZE = Number(process.env['MAX_UPLOAD_SIZE'] ?? 25_000_000)
/** Max size for video uploads. */
const MAX_VIDEO_UPLOAD_SIZE = Number(process.env['MAX_VIDEO_UPLOAD_SIZE'] ?? 500_000_000)
/**
 * Max size for `.pptx` imports. Default 2 GB (kept high by product
 * requirement — large decks must import). The pptx path doesn't create a
 * `media_assets` row; instead the `onUploadFinish` hook runs the full
 * deck-import pipeline against the freshly-uploaded blob. DoS protection
 * comes from the parser's decompression-bomb guard (`assertNotZipBomb`),
 * which rejects pathological archives without limiting legitimate large
 * files — not from this on-the-wire cap.
 */
const MAX_PPTX_UPLOAD_SIZE = Number(process.env['MAX_PPTX_UPLOAD_SIZE'] ?? 2 * 1024 * 1024 * 1024)
/** tus server-level maxSize — set to the largest of the four; per-MIME enforcement is in onUploadCreate. */
const MAX_UPLOAD_SIZE = Math.max(
  MAX_IMAGE_UPLOAD_SIZE,
  MAX_VIDEO_UPLOAD_SIZE,
  MAX_FONT_UPLOAD_SIZE,
  MAX_PPTX_UPLOAD_SIZE,
)
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

/**
 * P15: classifies an upload as a font from its MIME or filename
 * extension. Browsers send wildly inconsistent MIME for fonts —
 * `font/ttf`, `font/otf`, `font/sfnt` (modern, RFC 8081), the legacy
 * `application/x-font-*` family, and `application/octet-stream` when
 * they don't know better. We accept all of them, but require a
 * .ttf / .otf filename extension as a sanity gate when the MIME is
 * generic.
 */
const FONT_MIME_TYPES = new Set([
  'font/ttf',
  'font/otf',
  'font/sfnt',
  'font/collection',
  'application/font-ttf',
  'application/font-otf',
  'application/font-sfnt',
  'application/x-font-ttf',
  'application/x-font-otf',
  'application/x-font-opentype',
  'application/x-font-truetype',
  'application/vnd.ms-opentype',
])

function isFontUpload(mime: string, filename?: string): boolean {
  const m = mime.toLowerCase()
  if (FONT_MIME_TYPES.has(m)) return true
  // Browsers on Windows commonly report file.type as '' for .ttf/.otf
  // because the OS lacks a MIME registry entry. Accept empty / generic
  // MIME when the filename has a font extension.
  const isGenericMime = m === '' || m === 'application/octet-stream'
  if (isGenericMime && filename) {
    const lower = filename.toLowerCase()
    return lower.endsWith('.ttf') || lower.endsWith('.otf')
  }
  return false
}
const BUCKET = process.env['MEDIA_BUCKET'] ?? 'narrative-media'

// ---------------------------------------------------------------------------
// S3 client config
// ---------------------------------------------------------------------------

function buildS3Config(): S3ClientConfig {
  const endpoint = process.env['MINIO_ENDPOINT']
  const base: S3ClientConfig = {
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env['MINIO_ROOT_USER'] ?? '',
      secretAccessKey: process.env['MINIO_ROOT_PASSWORD'] ?? '',
    },
  }
  // Only include endpoint when defined — exactOptionalPropertyTypes requires this
  if (endpoint !== undefined) {
    return { ...base, endpoint }
  }
  return base
}

function buildS3Client(): S3Client {
  return new S3Client(buildS3Config())
}

// ---------------------------------------------------------------------------
// Metadata helpers
// ---------------------------------------------------------------------------

/**
 * Parses the tus Upload-Metadata header value into a plain object.
 * Each entry is "{key} {base64value}" separated by commas.
 */
function parseMetadata(raw: string | string[] | undefined): Record<string, string> {
  if (!raw) return {}
  const rawStr = Array.isArray(raw) ? raw.join(',') : raw
  const result: Record<string, string> = {}
  for (const pair of rawStr.split(',')) {
    const trimmed = pair.trim()
    const spaceIdx = trimmed.indexOf(' ')
    if (spaceIdx === -1) {
      result[trimmed] = ''
    } else {
      const k = trimmed.slice(0, spaceIdx)
      const v = trimmed.slice(spaceIdx + 1)
      try {
        result[k] = Buffer.from(v, 'base64').toString('utf8')
      } catch {
        result[k] = v
      }
    }
  }
  return result
}

/** Derives a file extension from a MIME type or filename. */
function extensionFromMimeOrFilename(mime: string, filename?: string): string {
  const mimeMap: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/avif': 'avif',
    'image/svg+xml': 'svg',
    'image/tiff': 'tiff',
    'image/bmp': 'bmp',
    'image/heic': 'heic',
    'image/heif': 'heif',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
    'video/x-msvideo': 'avi',
    'video/x-matroska': 'mkv',
    'video/mpeg': 'mpg',
    'video/3gpp': '3gp',
    'video/ogg': 'ogv',
    // P15 fonts — preserve the filename extension when possible so
    // browsers don't choke on a generic .bin extension via @font-face.
    'font/ttf': 'ttf',
    'font/otf': 'otf',
    'font/sfnt': 'ttf',
    'application/font-ttf': 'ttf',
    'application/font-otf': 'otf',
    'application/x-font-ttf': 'ttf',
    'application/x-font-otf': 'otf',
    'application/x-font-opentype': 'otf',
    'application/x-font-truetype': 'ttf',
    'application/vnd.ms-opentype': 'otf',
    [PPTX_MIME]: 'pptx',
  }

  const fromMime = mimeMap[mime.toLowerCase()]
  if (fromMime) return fromMime

  if (filename) {
    const lastDot = filename.lastIndexOf('.')
    if (lastDot !== -1) return filename.slice(lastDot + 1).toLowerCase()
  }

  return 'bin'
}

// ---------------------------------------------------------------------------
// Image dimension probe
// ---------------------------------------------------------------------------

/**
 * Reads the first 64 KB of the S3 object at storageKey and probes image dimensions.
 * Returns undefined if probe fails (non-fatal — asset row is inserted without dims).
 */
async function probeImageDimensions(
  s3: S3Client,
  storageKey: string,
): Promise<{ width: number; height: number } | undefined> {
  try {
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: storageKey,
        Range: 'bytes=0-65535',
      }),
    )

    if (!response.Body) return undefined

    // probe-image-size accepts a Readable stream
    const result = await probe(response.Body as Readable)
    if (!result) return undefined

    return { width: result.width, height: result.height }
  } catch (err) {
    log.warn({ storageKey, err }, 'image probe failed')
    return undefined
  }
}

/**
 * Best-effort MinIO delete. Used for transient pptx blobs (which are
 * parsed in onUploadFinish and then thrown away). A failed delete just
 * leaves an orphan object behind — annoying but not fatal; the M29 GC
 * sweep is the safety net.
 */
async function deleteMinIOObject(s3: S3Client, storageKey: string): Promise<void> {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: storageKey }))
  } catch (err) {
    log.warn({ storageKey, err }, 'DeleteObject failed')
  }
}

/** Reads the full S3 object at storageKey into a Buffer. Throws on failure. */
async function getObjectBytes(s3: S3Client, storageKey: string): Promise<Buffer> {
  const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: storageKey }))
  if (!obj.Body) throw new Error(`S3 returned empty body for ${storageKey}`)
  const chunks: Buffer[] = []
  for await (const chunk of obj.Body as Readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer))
  }
  return Buffer.concat(chunks)
}

// `decks` is imported up top to satisfy the unused-import lint; the
// `db.delete(decks)` rollback paths we briefly considered for failed
// imports turned out unnecessary (importDeckFromPptxBytes runs the
// deck-creating transaction atomically, so partial-failure rollback is
// already handled). Reference the symbol so the import isn't tree-shaken
// in a way that confuses tooling.
void decks

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

type AppWithAuthOpts = FastifyInstance & {
  _authOpts?: {
    bypass?: boolean
  }
}

async function resolveUserIdFromReq(
  req: IncomingMessage,
  db: Database,
  app: AppWithAuthOpts,
): Promise<string | null> {
  const bypassAuth = app._authOpts?.bypass === true
  if (bypassAuth) return 'dev-user'

  // tus hooks receive the raw IncomingMessage, so Fastify's cookie parser
  // isn't on it. Pull the narrative_session cookie out of the Cookie header
  // manually and resolve it the same way authPreHandler does.
  const rawId = readCookieFromHeader(req.headers['cookie'], SESSION_COOKIE_NAME)
  if (!rawId) return null
  const session = await lookupSession(db, rawId)
  return session?.userSub ?? null
}

/**
 * TUS-1: metadata key under which we persist the id of the user who created
 * the upload. tus stores the metadata returned from `onUploadCreate` in the
 * `.info` sidecar alongside the S3 object, so it survives to every later
 * PATCH/DELETE and to `onUploadFinish`. We re-check it on each of those so a
 * second authenticated user who guesses an in-flight upload id can't append,
 * terminate, or finalize someone else's upload.
 */
const CREATOR_META_KEY = 'creatorUserId'

/**
 * TUS-1: re-authorize a request that targets an already-created upload
 * (PATCH / DELETE / finish). Throws a tus-shaped `{ status_code, body }` on
 * any failure; resolves silently when the caller is allowed to proceed.
 *
 * Requires BOTH:
 *   (a) the live session user equals the upload's stored creator, AND
 *   (b) the creator still has the access the upload was created under —
 *       editor on the encoded deck for media uploads, or folder ownership
 *       for transient pptx imports.
 *
 * Fails closed (403) when the creator id can't be recovered from the upload
 * metadata — e.g. a legacy in-flight upload created before this binding
 * existed. Such uploads must be re-created by the client.
 */
async function requireUploadCreatorAndAccess(
  req: IncomingMessage,
  upload: Upload,
  db: Database,
  app: AppWithAuthOpts,
): Promise<void> {
  const userId = await resolveUserIdFromReq(req, db, app)
  if (!userId) {
    throw { status_code: 401, body: 'Unauthorized' }
  }

  // (a) creator binding — must match the user who created this upload.
  const creatorUserId = upload.metadata?.[CREATOR_META_KEY] ?? null
  if (!creatorUserId) {
    // Fail closed: a legacy in-flight upload with no recorded creator can't
    // be safely re-authorized. The client must re-create it.
    throw {
      status_code: 403,
      body: 'Forbidden: upload is not bound to a creator; please restart the upload',
    }
  }
  if (creatorUserId !== userId) {
    throw { status_code: 403, body: 'Forbidden: not the creator of this upload' }
  }

  // (b) still-valid access. Recover deckId/folderId from the upload metadata
  // and the compound id, mirroring what onUploadCreate validated.
  const mime =
    upload.metadata?.['content-type'] ??
    upload.metadata?.['mimeType'] ??
    upload.metadata?.['mimetype'] ??
    ''
  const idParts = upload.id.split(':')
  const deckIdFromId = idParts[1] && idParts[1] !== 'unknown' ? idParts[1] : null
  const deckId = upload.metadata?.['deckId'] ?? deckIdFromId
  const folderId = upload.metadata?.['folderId'] ?? null

  if (mime === PPTX_MIME) {
    // A pptx upload is bound to EITHER a deck (insert into it — the slides
    // panel's drop) or a folder (create a new deck in it). The binding
    // decides which access is re-asserted: inserting slides into a deck is
    // an ordinary edit of that deck and must not require owning the folder
    // it sits in, or a shared editor could not drop a .pptx onto a deck
    // they are otherwise free to rewrite.
    if (deckId) {
      const deckAccess = await resolveDeckAccess(db, { deckId, userId, shareToken: null })
      if (!deckAccess || !roleAtLeast(deckAccess.role, 'editor')) {
        throw { status_code: 403, body: 'Forbidden: editor access to the deck revoked' }
      }
      return
    }
    // Folder-scoped import: re-assert folder ownership.
    if (!folderId) {
      throw { status_code: 403, body: 'Forbidden: pptx upload missing deck or folder binding' }
    }
    const [folder] = await db
      .select({ id: folders.id, ownerUserId: folders.ownerUserId })
      .from(folders)
      .where(eq(folders.id, folderId))
      .limit(1)
    if (!folder || folder.ownerUserId !== userId) {
      throw { status_code: 403, body: 'Forbidden: folder access revoked' }
    }
    return
  }

  if (!deckId) {
    throw { status_code: 403, body: 'Forbidden: upload missing deck binding' }
  }
  const access = await resolveDeckAccess(db, { deckId, userId, shareToken: null })
  if (!access || !roleAtLeast(access.role, 'editor')) {
    throw { status_code: 403, body: 'Forbidden: editor access to the deck revoked' }
  }
}

// ---------------------------------------------------------------------------
// Plugin opts
// ---------------------------------------------------------------------------

export interface TusPluginOpts {
  db: Database
}

// ---------------------------------------------------------------------------
// Public upload URL
// ---------------------------------------------------------------------------

/**
 * Build the URL a tus client must send the upload's PATCH requests to.
 *
 * Deliberately **relative** (`/api/api/uploads/<id>`): the browser resolves it
 * against the origin it is already talking to, so scheme and host are correct
 * by construction. An absolute URL cannot be built reliably here — Caddy
 * rewrites `Host` to the upstream hostport, and it overwrites
 * `X-Forwarded-Proto` with `http` because the Cloudflare tunnel terminates TLS
 * and speaks plain HTTP to it, which produced a mixed-content URL the browser
 * refused to call.
 *
 * The one thing the upstream genuinely cannot know is the path prefix the
 * proxy stripped (Caddy's `handle_path /api/*`); it arrives as
 * `X-Forwarded-Prefix`. Missing header (dev, direct hit) → no prefix.
 */
export function buildPublicUploadUrl(opts: {
  path: string
  id: string
  forwardedPrefix?: string | string[] | undefined
}): string {
  const { path, id, forwardedPrefix } = opts
  const rawPrefix = Array.isArray(forwardedPrefix) ? forwardedPrefix[0] : forwardedPrefix
  // Normalise: leading slash, no trailing slash, empty when absent or '/'.
  let prefix = (rawPrefix ?? '').trim()
  if (prefix.endsWith('/')) prefix = prefix.slice(0, -1)
  if (prefix !== '' && !prefix.startsWith('/')) prefix = `/${prefix}`
  return `${prefix}${path}/${id}`
}

// ---------------------------------------------------------------------------
// registerTusPlugin
// ---------------------------------------------------------------------------

/**
 * Mounts the tus upload server at /api/uploads/* on the given Fastify instance.
 * All tus lifecycle hooks enforce auth and role-based deck access.
 */
export function registerTusPlugin(app: FastifyInstance, opts: TusPluginOpts): void {
  const { db } = opts
  const s3 = buildS3Client()
  const appWithAuth = app as AppWithAuthOpts

  // Build S3Store config — bucket is passed inside s3ClientConfig per @tus/s3-store API
  const s3Config = buildS3Config()

  // -------------------------------------------------------------------------
  // Build tus server
  // -------------------------------------------------------------------------
  const tusServer = new TusServer({
    path: '/api/uploads',
    maxSize: MAX_UPLOAD_SIZE,

    // -----------------------------------------------------------------------
    // Public upload URLs (Location header)
    //
    // tus answers the creation POST with the URL the client PATCHes the bytes
    // to. Its default — absolute, built from the upstream's own view of the
    // request — is wrong behind our reverse proxy on every component:
    //
    //   1. Caddy rewrites `Host` to the upstream hostport, so the URL came
    //      back as `http://server:3001/...`, a Docker-internal name the
    //      browser cannot resolve.
    //   2. Caddy overwrites `X-Forwarded-Proto` with `http` (the Cloudflare
    //      tunnel terminates TLS and speaks plain HTTP to Caddy), so even with
    //      the right host the URL was mixed content and the browser blocked it.
    //   3. Caddy mounts the API with `handle_path /api/*`, which STRIPS the
    //      prefix — the path we see is one segment short of the public one.
    //
    // Answering with a RELATIVE URL settles (1) and (2) by construction: the
    // browser resolves it against the origin it already uses. Only the
    // stripped prefix has to be restored, from `X-Forwarded-Prefix`.
    // -----------------------------------------------------------------------
    generateUrl: (req, { path, id }) =>
      buildPublicUploadUrl({
        path,
        id,
        forwardedPrefix: req.headers['x-forwarded-prefix'],
      }),

    datastore: new S3Store({
      s3ClientConfig: {
        ...s3Config,
        bucket: BUCKET,
      },
    }),

    // -----------------------------------------------------------------------
    // namingFunction: generate stable storageKey from assetId + metadata
    //
    // Encodes assetId + deckId + storageKey into the upload ID so the finalize
    // hook can reconstruct them without an extra DB lookup.
    // Format: "{assetId}:{deckId}:{storageKey base64url}"
    // -----------------------------------------------------------------------
    namingFunction: (_req: IncomingMessage, metadata?: Record<string, string | null>) => {
      const assetId = nanoid(16)
      const deckId = metadata?.['deckId'] ?? 'unknown'
      const folderId = metadata?.['folderId'] ?? null
      const filename = metadata?.['filename'] ?? undefined
      const mime =
        metadata?.['content-type'] ?? metadata?.['mimeType'] ?? 'application/octet-stream'
      const ext = extensionFromMimeOrFilename(mime, filename)
      // PPTX imports are transient: the bytes get parsed in onUploadFinish
      // and then deleted from MinIO. Storing them under their own folder
      // namespaced by folderId (NOT deckId — the deck doesn't exist yet)
      // makes the cleanup path unambiguous and lets a future GC sweep
      // pick up orphaned imports without scanning the whole bucket.
      // P15: fonts get their own folder so the deck listing logic can
      // tell them apart at a glance.
      let storageKey: string
      if (mime === PPTX_MIME) {
        // Deck-scoped (insert into an open deck) vs folder-scoped (create a
        // new deck): namespace the transient blob by whichever binding it
        // has, so an orphan sweep can tell what it was for.
        const scope = deckId !== 'unknown' ? `deck/${deckId}` : (folderId ?? 'unknown')
        storageKey = `imports/pptx-temp/${scope}/${assetId}/source.${ext}`
      } else {
        const folder = isFontUpload(mime, filename) ? 'fonts' : 'uploads'
        storageKey = `decks/${deckId}/${folder}/${assetId}/original.${ext}`
      }

      const encoded = `${assetId}:${deckId}:${Buffer.from(storageKey).toString('base64url')}`
      return encoded
    },

    // -----------------------------------------------------------------------
    // onUploadCreate: validate auth + deck access + MIME
    // -----------------------------------------------------------------------
    onUploadCreate: async (
      req: IncomingMessage,
      res: ServerResponse,
      upload: Upload,
    ): Promise<{ res: ServerResponse; metadata?: Upload['metadata'] }> => {
      // 1. Auth
      const userId = await resolveUserIdFromReq(req, db, appWithAuth)
      if (!userId) {
        throw { status_code: 401, body: 'Unauthorized' }
      }

      // 2. Parse metadata from Upload-Metadata header
      const meta = parseMetadata(req.headers['upload-metadata'])
      const deckId = meta['deckId'] ?? upload.metadata?.['deckId'] ?? null
      const folderId = meta['folderId'] ?? upload.metadata?.['folderId'] ?? null
      const insertAtRaw = meta['insertAt'] ?? upload.metadata?.['insertAt'] ?? null

      // 3. MIME resolution (used by both the pptx branch and the media branch).
      const mime =
        meta['content-type'] ??
        meta['mimeType'] ??
        meta['mimetype'] ??
        meta['filetype'] ??
        meta['type'] ??
        upload.metadata?.['content-type'] ??
        upload.metadata?.['mimeType'] ??
        upload.metadata?.['mimetype'] ??
        upload.metadata?.['filetype'] ??
        upload.metadata?.['type'] ??
        ''

      if (!mime) {
        log.warn(
          { headers: meta, uploadMetadata: upload.metadata },
          'onUploadCreate: no MIME in metadata',
        )
      }

      // TUS-1: persist the creating user (and the resolved deck/folder/mime
      // bindings the access check relies on) into the upload metadata. tus
      // stores what we return here in the `.info` sidecar via @tus/s3-store,
      // so it survives to every later PATCH/DELETE and to onUploadFinish.
      // We re-check it there so a second authenticated user who guesses an
      // in-flight upload id can't append/terminate/finalize someone else's
      // upload. Persisting the resolved bindings (not just the header values)
      // makes the re-check robust even if the client omits them on PATCH.
      const persistedMetadata: Upload['metadata'] = {
        ...(upload.metadata ?? {}),
        [CREATOR_META_KEY]: userId,
        ...(deckId ? { deckId } : {}),
        ...(folderId ? { folderId } : {}),
        ...(insertAtRaw !== null ? { insertAt: insertAtRaw } : {}),
        ...(mime ? { 'content-type': mime } : {}),
      }

      // ─── PPTX import branch ────────────────────────────────────────────
      // Different metadata model: pptx imports create a NEW deck inside a
      // folder, so they require `folderId` (not `deckId`) and we check
      // folder ownership instead of deck role. The MinIO blob is transient
      // — the onUploadFinish hook parses it and deletes it.
      if (mime === PPTX_MIME) {
        if (!deckId && !folderId) {
          throw {
            status_code: 400,
            body: 'Missing deckId or folderId in Upload-Metadata for pptx import',
          }
        }
        const uploadSize = upload.size ?? 0
        if (uploadSize > MAX_PPTX_UPLOAD_SIZE) {
          throw {
            status_code: 413,
            body: `PPTX import exceeds maximum size of ${MAX_PPTX_UPLOAD_SIZE} bytes.`,
          }
        }

        // ─── Deck-scoped: insert the slides into an existing deck ────────
        // What the slides panel's drop does. `insertAt` is optional — no
        // value means append at the end.
        if (deckId) {
          if (insertAtRaw !== null && !/^\d+$/.test(insertAtRaw)) {
            throw {
              status_code: 400,
              body: 'insertAt must be a non-negative integer',
            }
          }
          const access = await resolveDeckAccess(db, { deckId, userId, shareToken: null })
          if (!access || !roleAtLeast(access.role, 'editor')) {
            throw {
              status_code: 403,
              body: 'Forbidden: editor or owner role required to import into this deck',
            }
          }
          return { res, metadata: persistedMetadata }
        }

        // ─── Folder-scoped: create a new deck ────────────────────────────
        // Folder ownership — same check the synchronous pptxImport route does.
        const [folder] = await db
          .select({ id: folders.id, ownerUserId: folders.ownerUserId })
          .from(folders)
          .where(eq(folders.id, folderId!))
          .limit(1)
        if (!folder) {
          throw { status_code: 404, body: 'Folder not found' }
        }
        if (folder.ownerUserId !== userId) {
          throw { status_code: 403, body: 'Forbidden: only the folder owner may import' }
        }
        return { res, metadata: persistedMetadata }
      }

      // ─── Existing media upload branch ─────────────────────────────────
      if (!deckId) {
        throw { status_code: 400, body: 'Missing deckId in Upload-Metadata' }
      }

      const filenameForMime = meta['filename'] ?? upload.metadata?.['filename'] ?? undefined
      const isImage = mime.startsWith('image/')
      const isVideo = mime.startsWith('video/')
      const isFont = isFontUpload(mime, filenameForMime)

      if (!isImage && !isVideo && !isFont) {
        throw {
          status_code: 415,
          body: `Unsupported media type: ${mime}. Only image/*, video/*, font/*, and pptx are accepted.`,
        }
      }

      // Per-MIME upload size enforcement.
      // The tus maxSize is set to the largest limit; we enforce the
      // tighter limit here so an image upload cannot claim video allowance.
      const uploadSize = upload.size ?? 0
      if (isImage && uploadSize > MAX_IMAGE_UPLOAD_SIZE) {
        throw {
          status_code: 413,
          body: `Image upload exceeds maximum size of ${MAX_IMAGE_UPLOAD_SIZE} bytes.`,
        }
      }
      if (isVideo && uploadSize > MAX_VIDEO_UPLOAD_SIZE) {
        throw {
          status_code: 413,
          body: `Video upload exceeds maximum size of ${MAX_VIDEO_UPLOAD_SIZE} bytes.`,
        }
      }
      if (isFont && uploadSize > MAX_FONT_UPLOAD_SIZE) {
        throw {
          status_code: 413,
          body: `Font upload exceeds maximum size of ${MAX_FONT_UPLOAD_SIZE} bytes.`,
        }
      }

      // 4. Deck access — require editor or owner
      const access = await resolveDeckAccess(db, { deckId, userId, shareToken: null })
      if (!access || !roleAtLeast(access.role, 'editor')) {
        throw { status_code: 403, body: 'Forbidden: editor or owner role required to upload' }
      }

      return { res, metadata: persistedMetadata }
    },

    // -----------------------------------------------------------------------
    // onIncomingRequest: auth re-check on every PATCH and DELETE
    // -----------------------------------------------------------------------
    onIncomingRequest: async (
      req: IncomingMessage,
      _res: ServerResponse,
      uploadId: string,
    ): Promise<void> => {
      const method = req.method?.toUpperCase() ?? ''
      // Only enforce on PATCH (data chunks) and DELETE (termination)
      if (method !== 'PATCH' && method !== 'DELETE') return

      // TUS-1: load the upload's stored metadata (the `.info` sidecar) so we
      // can verify the requester is the original creator AND still has access
      // to the deck/folder the upload was created under. onIncomingRequest
      // only receives the id string, so we resolve the Upload via the
      // datastore the tus server is using.
      let upload: Upload
      try {
        upload = await tusServer.datastore.getUpload(uploadId)
      } catch {
        // Unknown / unreadable upload id — let tus produce its own 404.
        return
      }
      await requireUploadCreatorAndAccess(req, upload, db, appWithAuth)
    },

    // -----------------------------------------------------------------------
    // onUploadFinish: probe dimensions, insert media_assets row
    // -----------------------------------------------------------------------
    onUploadFinish: async (
      req: IncomingMessage,
      res: ServerResponse,
      upload: Upload,
    ): Promise<{
      res: ServerResponse
      status_code?: number
      headers?: Record<string, string | number>
      body?: string
    }> => {
      // Decode assetId + deckId from the compound id.
      // The actual S3 object key is `upload.id` itself — @tus/s3-store writes the
      // object at that key. We keep the compound encoding so we can recover
      // assetId/deckId without a DB lookup, but storageKey must match what S3 has.
      const parts = upload.id.split(':')
      const assetId = parts[0]
      const deckId = parts[1]

      if (!assetId || !deckId) {
        log.error({ uploadId: upload.id }, 'onUploadFinish: malformed upload id')
        throw { status_code: 500, body: 'Internal error: upload id malformed' }
      }
      const storageKey = upload.id

      // TUS-1: re-authorize before doing any S3 read or DB write. The compound
      // id encodes deckId, but the finish hook previously trusted it blindly —
      // any authenticated user who reached finish on someone else's upload id
      // would have a media_assets row written against the encoded deck. Require
      // the live session user to be the upload's creator AND still hold
      // editor/folder access. (Bypass mode: creator was stored as 'dev-user'
      // and resolveUserIdFromReq returns 'dev-user', so the check passes.)
      await requireUploadCreatorAndAccess(req, upload, db, appWithAuth)

      // Auth (may be null if bypass — map to 'unknown' as safety fallback)
      const userId = (await resolveUserIdFromReq(req, db, appWithAuth)) ?? 'unknown'

      // Parse metadata for filename + mime
      const meta = parseMetadata(req.headers['upload-metadata'])
      const filename = meta['filename'] ?? upload.metadata?.['filename'] ?? undefined
      const mimeRaw =
        meta['content-type'] ??
        meta['mimeType'] ??
        upload.metadata?.['content-type'] ??
        'application/octet-stream'
      const folderId = meta['folderId'] ?? upload.metadata?.['folderId'] ?? null
      // A pptx bound to a deck carries its target index; the compound upload
      // id stores 'unknown' for the folder-scoped case, so the metadata is
      // what distinguishes them.
      const pptxDeckId = upload.metadata?.['deckId'] ?? meta['deckId'] ?? null
      const insertAtRaw = meta['insertAt'] ?? upload.metadata?.['insertAt'] ?? null

      // Get authoritative size from S3 head
      let sizeBytes = upload.size ?? 0
      try {
        const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: storageKey }))
        sizeBytes = head.ContentLength ?? sizeBytes
      } catch (err) {
        log.warn({ err }, 'HeadObject failed, using tus-reported size')
      }

      // ─── PPTX import branch ────────────────────────────────────────────
      // The blob is transient: read it back, run the deck-import pipeline,
      // delete the MinIO object whether import succeeded or not. Failed
      // imports leave nothing behind to clean up.
      if (mimeRaw === PPTX_MIME) {
        if (!folderId && !pptxDeckId) {
          // Should have been caught in onUploadCreate; defensive guard.
          await deleteMinIOObject(s3, storageKey)
          throw { status_code: 400, body: 'Missing deckId or folderId in pptx import metadata' }
        }
        let pptxBytes: Buffer
        try {
          const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: storageKey }))
          if (!obj.Body) throw new Error('S3 returned empty body for pptx blob')
          const chunks: Buffer[] = []
          for await (const chunk of obj.Body as Readable) {
            chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer))
          }
          pptxBytes = Buffer.concat(chunks)
        } catch (err) {
          log.error({ err }, 'pptx GetObject failed')
          await deleteMinIOObject(s3, storageKey)
          throw { status_code: 500, body: 'Failed to read uploaded pptx from storage' }
        }

        // ─── Deck-scoped: insert into an existing deck ──────────────────
        if (pptxDeckId) {
          const insertAt =
            insertAtRaw !== null && /^\d+$/.test(insertAtRaw) ? Number(insertAtRaw) : undefined
          const appendResult = await appendPptxToDeck({
            bytes: pptxBytes,
            deckId: pptxDeckId,
            ownerUserId: userId,
            ...(insertAt !== undefined ? { insertAt } : {}),
            db,
            log: {
              info: (o, m) => log.info(o, m ?? 'pptx append'),
              warn: (o, m) => log.warn(o, m ?? 'pptx append'),
            },
          })

          // ALWAYS clean up the temp blob — a successful insert doesn't need
          // the bytes (image extraction already ran from the in-memory
          // Buffer); a failed one has nothing worth keeping.
          await deleteMinIOObject(s3, storageKey)

          if (!appendResult.ok) {
            const { error } = appendResult
            const status =
              error.kind === 'parseFailed' ||
              error.kind === 'noSlides' ||
              error.kind === 'emptyBody'
                ? 400
                : 500
            const message =
              error.kind === 'parseFailed'
                ? `Could not parse .pptx — ${error.message}`
                : error.kind === 'noSlides'
                  ? '.pptx contains no slides'
                  : error.kind === 'writeFailed'
                    ? error.documentTouched
                      ? 'Append failed part-way — some slides may already be in the deck; check it before retrying'
                      : 'Append failed — no slides were written'
                    : error.kind
            throw { status_code: status, body: message }
          }

          return {
            res,
            status_code: 200,
            headers: {
              'Content-Type': 'application/json',
              'X-Narrative-Deck-Id': appendResult.result.deckId,
            },
            body: JSON.stringify(appendResult.result),
          }
        }

        // ─── Folder-scoped: create a new deck ───────────────────────────
        const importResult = await importDeckFromPptxBytes({
          bytes: pptxBytes,
          folderId: folderId!,
          ownerUserId: userId,
          ...(typeof filename === 'string' ? { filenameForTitle: filename } : {}),
          db,
          log: {
            info: (o, m) => log.info(o, m ?? 'pptx import'),
            warn: (o, m) => log.warn(o, m ?? 'pptx import'),
          },
        })

        // ALWAYS clean up the temp blob — successful import doesn't need
        // the bytes (image extraction was already done from the in-memory
        // Buffer); failed import has nothing worth keeping.
        await deleteMinIOObject(s3, storageKey)

        if (!importResult.ok) {
          const { error } = importResult
          const status =
            error.kind === 'folderNotFound'
              ? 404
              : error.kind === 'forbidden'
                ? 403
                : error.kind === 'parseFailed' ||
                    error.kind === 'noSlides' ||
                    error.kind === 'emptyBody'
                  ? 400
                  : 500
          const message =
            error.kind === 'parseFailed' ? `Could not parse .pptx — ${error.message}` : error.kind
          throw { status_code: status, body: message }
        }

        return {
          res,
          status_code: 201,
          headers: {
            'Content-Type': 'application/json',
            'X-Narrative-Deck-Id': importResult.result.deckId,
          },
          body: JSON.stringify(importResult.result),
        }
      }

      const isVideo = mimeRaw.startsWith('video/')
      const isFont = isFontUpload(mimeRaw, filename)

      if (isFont) {
        // -----------------------------------------------------------------------
        // Font branch: fetch the bytes, parse OpenType metadata, insert row.
        // We READ the full file (TTF/OTF are typically <2 MB; the size cap
        // is 8 MB) so opentype.js can walk the tables. If parsing fails the
        // upload is rejected and the partial S3 object stays orphaned for
        // the M29 GC sweep.
        // -----------------------------------------------------------------------
        let metadata
        try {
          const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: storageKey }))
          if (!obj.Body) throw new Error('S3 returned empty body for font asset')
          // The Body is a Readable stream — collect into a Buffer for opentype.
          const chunks: Buffer[] = []
          for await (const chunk of obj.Body as Readable) {
            chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer))
          }
          const buf = Buffer.concat(chunks)
          // Pass an ArrayBuffer slice so opentype gets exactly the byte range
          // it expects (Buffer's underlying ArrayBuffer may be larger).
          const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
          metadata = parseFontMetadata(ab as ArrayBuffer)
        } catch (err) {
          log.error({ err }, 'parseFontMetadata failed')
          throw {
            status_code: 400,
            body: `Failed to parse font file. Make sure it's a valid TTF or OTF.`,
          }
        }

        try {
          await createMediaAsset(db, {
            id: assetId,
            deckId,
            uploaderUserId: userId,
            mimeType: mimeRaw,
            sizeBytes,
            storageKey,
            ...(filename !== undefined ? { originalFilename: filename } : {}),
            kind: 'font',
            fontFamily: metadata.family,
            fontWeight: metadata.weight,
            fontStyle: metadata.style,
            fontPostscriptName: metadata.postscriptName,
          })
        } catch (err) {
          log.error({ err }, 'createMediaAsset (font) failed')
          throw { status_code: 500, body: 'Failed to persist font asset metadata' }
        }

        return {
          res,
          status_code: 200,
          headers: {
            'Content-Type': 'application/json',
            'X-Narrative-Asset-Id': assetId,
          },
          body: JSON.stringify({
            assetId,
            storageKey,
            mimeType: mimeRaw,
            sizeBytes,
            kind: 'font',
            fontFamily: metadata.family,
            fontWeight: metadata.weight,
            fontStyle: metadata.style,
            fontPostscriptName: metadata.postscriptName,
          }),
        }
      }

      if (isVideo) {
        // -----------------------------------------------------------------------
        // Video branch: create asset row with pending transcode status, enqueue job
        // -----------------------------------------------------------------------
        try {
          await createMediaAsset(db, {
            id: assetId,
            deckId,
            uploaderUserId: userId,
            mimeType: mimeRaw,
            sizeBytes,
            storageKey,
            ...(filename !== undefined ? { originalFilename: filename } : {}),
            // width/height left null — worker fills them after ffprobe
            kind: 'video',
            transcodeStatus: 'pending',
          })
        } catch (err) {
          log.error({ err }, 'createMediaAsset (video) failed')
          throw { status_code: 500, body: 'Failed to persist video asset metadata' }
        }

        try {
          await enqueueVideoTranscode({
            assetId,
            deckId,
            storageKey,
            uploaderUserId: userId,
            mimeType: mimeRaw,
          })
        } catch (err) {
          log.error({ err }, 'enqueueVideoTranscode failed')
          // Asset row already exists — log the failure but don't rollback.
          // Operator can re-enqueue manually. Do not fail the upload response.
        }

        return {
          res,
          status_code: 200,
          headers: {
            'Content-Type': 'application/json',
            'X-Narrative-Asset-Id': assetId,
          },
          body: JSON.stringify({
            assetId,
            storageKey,
            mimeType: mimeRaw,
            sizeBytes,
            transcodeStatus: 'pending',
          }),
        }
      }

      // -----------------------------------------------------------------------
      // Image branch: validate content, then probe dimensions + insert row.
      //
      // XSS-3 defense-in-depth: an uploaded "image" can be (a) an SVG carrying
      // active content, or (b) a raster MIME whose bytes are actually something
      // else (a script / PE binary renamed .png). We read the head bytes, and:
      //   - if it sniffs as SVG (declared image/svg+xml OR `.png`-renamed SVG),
      //     sanitize the full bytes through DOMPurify and write the cleaned
      //     version back to the SAME key/content-type, or reject if nothing
      //     usable survives;
      //   - else, for a declared raster MIME we magic-check, reject when the
      //     signature doesn't match the declared type.
      // This runs BEFORE the media_assets row is created, so a rejected upload
      // never produces a DB record (and the stored object is deleted).
      // -----------------------------------------------------------------------
      {
        let headBytes: Buffer
        try {
          // First ~64 KB is enough to sniff SVG/XML and any raster signature.
          const obj = await s3.send(
            new GetObjectCommand({ Bucket: BUCKET, Key: storageKey, Range: 'bytes=0-65535' }),
          )
          if (!obj.Body) throw new Error('empty body')
          const chunks: Buffer[] = []
          for await (const chunk of obj.Body as Readable) {
            chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer))
          }
          headBytes = Buffer.concat(chunks)
        } catch (err) {
          log.error({ err }, 'image content read failed')
          await deleteMinIOObject(s3, storageKey)
          throw { status_code: 400, body: 'Failed to read uploaded image for validation.' }
        }

        const declaredMime = mimeRaw.toLowerCase()
        const looksSvg = declaredMime === 'image/svg+xml' || sniffIsSvg(headBytes)

        if (looksSvg) {
          // Sanitize the FULL object (not just the 64 KB head) so we never
          // truncate a large legitimate SVG. Re-read in full.
          let fullBytes: Buffer
          try {
            fullBytes = await getObjectBytes(s3, storageKey)
          } catch (err) {
            log.error({ err }, 'SVG full read failed')
            await deleteMinIOObject(s3, storageKey)
            throw { status_code: 400, body: 'Failed to read uploaded SVG for sanitization.' }
          }

          const cleaned = sanitizeSvg(fullBytes)
          if (!cleaned) {
            await deleteMinIOObject(s3, storageKey)
            throw {
              status_code: 400,
              body: 'SVG rejected: no valid graphic content after sanitization.',
            }
          }

          // Only rewrite when sanitization actually changed the bytes.
          if (!cleaned.equals(fullBytes)) {
            try {
              await s3.send(
                new PutObjectCommand({
                  Bucket: BUCKET,
                  Key: storageKey,
                  Body: cleaned,
                  ContentType: 'image/svg+xml',
                }),
              )
              sizeBytes = cleaned.byteLength
            } catch (err) {
              log.error({ err }, 'sanitized SVG PutObject failed')
              await deleteMinIOObject(s3, storageKey)
              throw { status_code: 500, body: 'Failed to store sanitized SVG.' }
            }
          }
        } else if (
          MAGIC_CHECKED_MIMES.has(declaredMime) &&
          !magicBytesMatch(declaredMime, headBytes)
        ) {
          // Declared a raster type whose actual signature disagrees — reject.
          await deleteMinIOObject(s3, storageKey)
          throw {
            status_code: 400,
            body: `Upload rejected: file content does not match declared type ${mimeRaw}.`,
          }
        }
      }

      // Probe image dimensions (non-fatal if probe fails)
      let dims: { width: number; height: number } | undefined
      dims = await probeImageDimensions(s3, storageKey)
      if (!dims) {
        log.warn({ storageKey }, 'probe-image-size returned no result')
        // Non-fatal: SVGs and some exotic formats may not probe; insert row without dims.
      }

      // A raster above imgproxy's source limit would never render (imgproxy
      // answers 422), so it is brought under the limit now, in its own
      // format, under the same key — see storedImageLimits.ts. The head probe
      // above decides; only an oversize image pays for the full read. A
      // failed downscale keeps the original rather than losing the upload.
      if (
        dims !== undefined &&
        exceedsStoredImageLimits(dims.width, dims.height) &&
        canDownscaleStoredImage(mimeRaw)
      ) {
        try {
          const downscaled = await downscaleForStorage(
            await getObjectBytes(s3, storageKey),
            mimeRaw,
          )
          if (downscaled !== null) {
            await s3.send(
              new PutObjectCommand({
                Bucket: BUCKET,
                Key: storageKey,
                Body: downscaled.bytes,
                ContentType: mimeRaw,
              }),
            )
            log.info(
              {
                storageKey,
                fromBytes: sizeBytes,
                toBytes: downscaled.bytes.byteLength,
                from: dims,
                to: { width: downscaled.width, height: downscaled.height },
              },
              'downscaled oversize image to the stored-image limits',
            )
            sizeBytes = downscaled.bytes.byteLength
            dims = { width: downscaled.width, height: downscaled.height }
          }
        } catch (err) {
          log.error({ err, storageKey }, 'downscaling an oversize image failed, keeping original')
        }
      }

      // Insert media_assets row
      try {
        await createMediaAsset(db, {
          id: assetId,
          deckId,
          uploaderUserId: userId,
          mimeType: mimeRaw,
          sizeBytes,
          storageKey,
          ...(filename !== undefined ? { originalFilename: filename } : {}),
          ...(dims !== undefined ? { width: dims.width, height: dims.height } : {}),
          kind: 'image',
        })
      } catch (err) {
        log.error({ err }, 'createMediaAsset failed')
        throw { status_code: 500, body: 'Failed to persist media asset metadata' }
      }

      // Return finalization body (non-standard but supported by most tus clients)
      const responseBody = JSON.stringify({
        assetId,
        storageKey,
        mimeType: mimeRaw,
        sizeBytes,
        width: dims?.width ?? null,
        height: dims?.height ?? null,
      })

      const imageHeaders: Record<string, string | number> = {
        'Content-Type': 'application/json',
        'X-Narrative-Asset-Id': assetId,
      }
      if (dims?.width !== undefined) imageHeaders['X-Narrative-Width'] = dims.width
      if (dims?.height !== undefined) imageHeaders['X-Narrative-Height'] = dims.height

      return {
        res,
        status_code: 200,
        headers: imageHeaders,
        body: responseBody,
      }
    },
  })

  // -------------------------------------------------------------------------
  // Fastify route: forward /api/uploads/* to tus handler
  //
  // We use app.all() for both paths — it covers GET, HEAD, POST, PATCH, DELETE, OPTIONS.
  // tus handles OPTIONS itself (Tus-Version discovery header) and does not require auth.
  // Auth is enforced inside onUploadCreate / onIncomingRequest hooks above.
  // -------------------------------------------------------------------------

  // tus uses `application/offset+octet-stream` on PATCH and no body on POST/HEAD;
  // Fastify's default ContentTypeParser rejects both with 415 before our handler
  // runs. Register a passthrough parser for these tus-specific types so the raw
  // request reaches tusServer.handle().
  const passthroughParser = (
    _req: unknown,
    payload: NodeJS.ReadableStream,
    done: (err: Error | null, body?: unknown) => void,
  ) => {
    // Do not consume the stream — tus reads from req.raw directly.
    done(null, payload)
  }
  app.addContentTypeParser('application/offset+octet-stream', passthroughParser)
  app.addContentTypeParser('application/x-www-form-urlencoded', passthroughParser)

  const corsOriginRaw = process.env['CORS_ORIGIN'] ?? 'http://localhost:5173'
  // Allowlist: comma-separated list of origins. The first is the default
  // returned when the request lacks an Origin header.
  const allowedOrigins = corsOriginRaw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
  const defaultOrigin = allowedOrigins[0] ?? 'http://localhost:5173'
  const exposeHeaders =
    'Location, Upload-Offset, Upload-Length, Upload-Metadata, Tus-Version, Tus-Resumable, Tus-Max-Size, Tus-Extension, X-Narrative-Asset-Id, X-Narrative-Width, X-Narrative-Height'

  const applyCorsHeaders = (req: FastifyRequest, reply: FastifyReply) => {
    const origin = req.headers.origin
    // Only echo Origin back if it's in the allowlist — never reflect arbitrary
    // origins, which would let any cross-origin caller through.
    if (origin !== undefined && allowedOrigins.includes(origin)) {
      reply.raw.setHeader('Access-Control-Allow-Origin', origin)
      reply.raw.setHeader('Vary', 'Origin')
    } else {
      reply.raw.setHeader('Access-Control-Allow-Origin', defaultOrigin)
    }
    reply.raw.setHeader('Access-Control-Expose-Headers', exposeHeaders)
  }

  app.all('/api/uploads', async (req, reply) => {
    applyCorsHeaders(req, reply)
    await tusServer.handle(req.raw, reply.raw)
  })

  app.all('/api/uploads/*', async (req, reply) => {
    applyCorsHeaders(req, reply)
    await tusServer.handle(req.raw, reply.raw)
  })

  app.log.info('[tus] Upload plugin registered at /api/uploads (maxSize=%d)', MAX_UPLOAD_SIZE)
}
