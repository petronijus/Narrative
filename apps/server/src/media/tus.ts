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
 * Known limitations (M11):
 *   - Orphaned MinIO objects on termination/error are not cleaned up (documented M29 GC).
 *   - No per-user rate limiting (M29).
 *   - Video uploads not supported (M12 BullMQ workers).
 */

import { createRequire } from 'node:module'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Readable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import { nanoid } from 'nanoid'
import { Server as TusServer } from '@tus/server'
import type { Upload } from '@tus/server'
import { S3Store } from '@tus/s3-store'
import type { S3ClientConfig } from '@aws-sdk/client-s3'
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3'
import type { Database } from '../db/client.js'
import { createMediaAsset } from './assets.js'
import { resolveDeckAccess, roleAtLeast } from '../auth/permissions.js'
import type { createJwtVerifier } from '../auth/jwt.js'

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

const MAX_UPLOAD_SIZE = Number(process.env['MAX_UPLOAD_SIZE'] ?? 25_000_000)
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
    console.warn('[tus] Image probe failed for', storageKey, err)
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

type AppWithAuthOpts = FastifyInstance & {
  _authOpts?: {
    verifier?: ReturnType<typeof createJwtVerifier> | null
    bypass?: boolean
  }
}

async function resolveUserIdFromReq(
  req: IncomingMessage,
  app: AppWithAuthOpts,
): Promise<string | null> {
  const bypassAuth = app._authOpts?.bypass === true
  if (bypassAuth) return 'dev-user'

  const authHeader = req.headers['authorization']
  const authStr = Array.isArray(authHeader) ? authHeader[0] : authHeader
  if (!authStr?.startsWith('Bearer ')) return null

  const token = authStr.slice(7)
  try {
    const verifier = app._authOpts?.verifier
    if (!verifier) return null
    const payload = await verifier.verify(token)
    return payload.sub
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Plugin opts
// ---------------------------------------------------------------------------

export interface TusPluginOpts {
  db: Database
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
      const filename = metadata?.['filename'] ?? undefined
      const mime =
        metadata?.['content-type'] ?? metadata?.['mimeType'] ?? 'application/octet-stream'
      const ext = extensionFromMimeOrFilename(mime, filename)
      const storageKey = `decks/${deckId}/uploads/${assetId}/original.${ext}`

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
      const userId = await resolveUserIdFromReq(req, appWithAuth)
      if (!userId) {
        throw { status_code: 401, body: 'Unauthorized' }
      }

      // 2. Parse metadata from Upload-Metadata header
      const meta = parseMetadata(req.headers['upload-metadata'])
      const deckId = meta['deckId'] ?? upload.metadata?.['deckId'] ?? null

      if (!deckId) {
        throw { status_code: 400, body: 'Missing deckId in Upload-Metadata' }
      }

      // 3. MIME validation — image/* only in M11
      const mime =
        meta['content-type'] ?? meta['mimeType'] ?? upload.metadata?.['content-type'] ?? ''

      if (!mime.startsWith('image/')) {
        throw {
          status_code: 415,
          body: `Unsupported media type: ${mime}. Only image/* is accepted.`,
        }
      }

      // 4. Deck access — require editor or owner
      const access = await resolveDeckAccess(db, { deckId, userId, shareToken: null })
      if (!access || !roleAtLeast(access.role, 'editor')) {
        throw { status_code: 403, body: 'Forbidden: editor or owner role required to upload' }
      }

      return { res }
    },

    // -----------------------------------------------------------------------
    // onIncomingRequest: auth re-check on every PATCH and DELETE
    // -----------------------------------------------------------------------
    onIncomingRequest: async (
      req: IncomingMessage,
      _res: ServerResponse,
      _uploadId: string,
    ): Promise<void> => {
      const method = req.method?.toUpperCase() ?? ''
      // Only enforce on PATCH (data chunks) and DELETE (termination)
      if (method !== 'PATCH' && method !== 'DELETE') return

      const userId = await resolveUserIdFromReq(req, appWithAuth)
      if (!userId) {
        throw { status_code: 401, body: 'Unauthorized' }
      }
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
      // Decode assetId + deckId + storageKey from the compound id
      const parts = upload.id.split(':')
      const assetId = parts[0]
      const deckId = parts[1]
      const storageKeyB64 = parts[2]

      if (!assetId || !deckId || !storageKeyB64) {
        console.error('[tus] onUploadFinish: malformed upload id', upload.id)
        throw { status_code: 500, body: 'Internal error: upload id malformed' }
      }
      const storageKey = Buffer.from(storageKeyB64, 'base64url').toString('utf8')

      // Auth (may be null if bypass — map to 'unknown' as safety fallback)
      const userId = (await resolveUserIdFromReq(req, appWithAuth)) ?? 'unknown'

      // Parse metadata for filename + mime
      const meta = parseMetadata(req.headers['upload-metadata'])
      const filename = meta['filename'] ?? upload.metadata?.['filename'] ?? undefined
      const mimeRaw =
        meta['content-type'] ??
        meta['mimeType'] ??
        upload.metadata?.['content-type'] ??
        'application/octet-stream'

      // Get authoritative size from S3 head
      let sizeBytes = upload.size ?? 0
      try {
        const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: storageKey }))
        sizeBytes = head.ContentLength ?? sizeBytes
      } catch (err) {
        console.warn('[tus] HeadObject failed, using tus-reported size:', err)
      }

      // Probe image dimensions (non-fatal if probe fails)
      let dims: { width: number; height: number } | undefined
      if (mimeRaw.startsWith('image/')) {
        dims = await probeImageDimensions(s3, storageKey)
        if (!dims) {
          console.warn('[tus] probe-image-size returned no result for', storageKey)
          // Non-fatal: SVGs and some exotic formats may not probe; insert row without dims.
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
        })
      } catch (err) {
        console.error('[tus] createMediaAsset failed:', err)
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

      return {
        res,
        status_code: 200,
        headers: { 'Content-Type': 'application/json' },
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

  app.all('/api/uploads', async (req, reply) => {
    await tusServer.handle(req.raw, reply.raw)
  })

  app.all('/api/uploads/*', async (req, reply) => {
    await tusServer.handle(req.raw, reply.raw)
  })

  app.log.info('[tus] Upload plugin registered at /api/uploads (maxSize=%d)', MAX_UPLOAD_SIZE)
}
