/**
 * media/s3Client.ts
 *
 * Shared MinIO S3 client config — same shape used by the tus plugin and
 * by ad-hoc PUT operations (e.g. deck thumbnail uploads). Keeping it
 * here avoids a circular import on tus.ts and keeps `MEDIA_BUCKET`
 * resolution centralised.
 */

import { createHash } from 'node:crypto'
import type { S3ClientConfig } from '@aws-sdk/client-s3'
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

export { PutObjectCommand, DeleteObjectCommand }

export const MEDIA_BUCKET = process.env['MEDIA_BUCKET'] ?? 'narrative-media'

export function buildS3Config(): S3ClientConfig {
  const endpoint = process.env['MINIO_ENDPOINT']
  const base: S3ClientConfig = {
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env['MINIO_ROOT_USER'] ?? '',
      secretAccessKey: process.env['MINIO_ROOT_PASSWORD'] ?? '',
    },
  }
  if (endpoint !== undefined) {
    return { ...base, endpoint }
  }
  return base
}

/**
 * The media bucket's client. It adds `Content-MD5` to DeleteObjects (the
 * batch delete every storage cleanup uses): the SDK sends a CRC32 checksum
 * there since 3.729 and no MD5, and MinIO (RELEASE.2024-12-18, what
 * production and dev run) refuses that with `MissingContentMD5` — so every
 * purge failed and left its files behind, logged as "batch delete failed
 * (orphans left)". With the MD5 both checksums are present and either kind
 * of server accepts the request.
 */
export function buildS3Client(): S3Client {
  const client = new S3Client(buildS3Config())
  client.middlewareStack.add(
    (next, context) => async (args) => {
      const request = args.request as { headers?: Record<string, string>; body?: unknown }
      if (context.commandName === 'DeleteObjectsCommand' && request.headers !== undefined) {
        const body = request.body
        if (typeof body === 'string' || body instanceof Uint8Array) {
          request.headers['content-md5'] = createHash('md5').update(body).digest('base64')
        }
      }
      return next(args)
    },
    { step: 'build', name: 'contentMd5ForDeleteObjects' },
  )
  return client
}

/**
 * Browser-facing routing for presigned URLs (MEDIA-1).
 *
 * A SigV4 presigned URL is bound to BOTH the host header and the canonical
 * request path; either mismatching what MinIO actually RECEIVES ⇒
 * SignatureDoesNotMatch. So we must sign against the exact host+path MinIO
 * sees after any reverse-proxy rewriting.
 *
 * Two deployment shapes:
 *
 *  • PROD — `MINIO_PUBLIC_URL` is ABSOLUTE, e.g. `https://DOMAIN/storage`.
 *    The browser hits `https://DOMAIN/storage/<bucket>/<key>?…`. Caddy's
 *    `handle_path /storage/*` STRIPS the `/storage` prefix and reverse-
 *    proxies to `minio:9000`, forwarding the ORIGINAL Host (Caddy v2 keeps
 *    the incoming Host by default — the `/storage` block sets no header_up).
 *    So MinIO receives Host=`DOMAIN`, path=`/<bucket>/<key>`. We therefore
 *    sign against the public ORIGIN only (`https://DOMAIN`, no path prefix)
 *    so the canonical signed path is `/<bucket>/<key>`, then PREPEND
 *    `/storage` to the returned URL purely for routing (outside the
 *    signature, stripped again before MinIO).
 *
 *  • DEV / unset — `MINIO_PUBLIC_URL` is path-only (`/storage`) or unset.
 *    Vite's `/storage` proxy uses `changeOrigin: true`, which REWRITES the
 *    Host to the target (`localhost:9100`), so a placeholder-host signature
 *    wouldn't validate. Instead we sign against `MINIO_ENDPOINT` directly
 *    (`http://127.0.0.1:9100`) and return that ABSOLUTE URL — the browser
 *    reaches MinIO directly on the published port, Host matches, signature
 *    validates. (This is exactly how the folder-font list presigning has
 *    always worked in dev.) The `/storage` Vite route is still used by
 *    imgproxy/poster paths; presigned media just bypasses it in dev.
 *
 * Returns:
 *   - prod: absolute `https://DOMAIN/storage/<bucket>/<key>?X-Amz-…`
 *   - dev:  absolute `http://127.0.0.1:9100/<bucket>/<key>?X-Amz-…`
 */
interface PublicRouting {
  /** Origin to sign against (scheme+host[:port], no path). */
  signOrigin: string
  /** Routing prefix to prepend to the signed path for the browser, e.g. `/storage`. */
  pathPrefix: string
}

function publicRouting(): PublicRouting | null {
  const pub = process.env['MINIO_PUBLIC_URL']
  // Only an ABSOLUTE public URL triggers the prefix-routing path (prod).
  // Path-only / unset values fall through to direct MINIO_ENDPOINT signing.
  if (pub === undefined || pub === '' || pub.startsWith('/')) return null
  const u = new URL(pub)
  return { signOrigin: u.origin, pathPrefix: u.pathname.replace(/\/+$/, '') }
}

/**
 * Generates a presigned GET URL for a private MinIO object (MEDIA-1).
 * Valid for `expiresIn` seconds (default 3600 — 1 h).
 *
 * The bucket is private (no anonymous download policy), so this signed URL
 * is the ONLY way a browser can reach the object: access re-authorizes on
 * every fetch, and a revoked share/permission can't keep fetching past the
 * TTL. See `publicRouting` for how the URL is kept browser-reachable while
 * the SigV4 signature stays valid against MinIO.
 */
export async function presignGetUrl(key: string, expiresIn = 3600): Promise<string> {
  const routing = publicRouting()
  const cfg = buildS3Config()
  // Prod: sign against the public origin so Host matches what Caddy forwards.
  // Dev/unset: sign against MINIO_ENDPOINT (buildS3Config already set it).
  const s3 = new S3Client(routing !== null ? { ...cfg, endpoint: routing.signOrigin } : cfg)
  const cmd = new GetObjectCommand({ Bucket: MEDIA_BUCKET, Key: key })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const signed = await getSignedUrl(s3 as any, cmd, { expiresIn })

  if (routing === null) return signed

  // Insert the `/storage` routing prefix between origin and `/<bucket>` —
  // it is outside the signed material and Caddy strips it before MinIO.
  const url = new URL(signed)
  return `${url.origin}${routing.pathPrefix}${url.pathname}${url.search}`
}

/**
 * Generates a presigned PUT URL for one object, routed like `presignGetUrl`
 * (prod: `https://DOMAIN/storage/<bucket>/<key>?…`, through Caddy; dev: the
 * MinIO port). The render worker uploads a finished slide with it (agentic
 * A3): it holds no storage credentials, so it can write exactly the objects
 * the server signed, until the URL expires.
 *
 * The object's type and caching are signed too (`signableHeaders`; the
 * presigner leaves them out by default): the uploader must send `headers`
 * exactly, storage refuses the PUT otherwise, and the stored object then
 * carries them — `Cache-Control: private, no-store` keeps a private slide out
 * of shared caches (Cloudflare caches `.png` by default) whatever link serves
 * it later.
 */
export async function presignPutUrl(
  key: string,
  contentType: string,
  expiresIn: number,
): Promise<{ url: string; headers: Record<string, string> }> {
  const headers = { 'content-type': contentType, 'cache-control': PRIVATE_NO_STORE }
  const routing = publicRouting()
  const cfg = buildS3Config()
  const s3 = new S3Client(routing !== null ? { ...cfg, endpoint: routing.signOrigin } : cfg)
  const cmd = new PutObjectCommand({
    Bucket: MEDIA_BUCKET,
    Key: key,
    ContentType: headers['content-type'],
    CacheControl: headers['cache-control'],
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const signed = await getSignedUrl(s3 as any, cmd, {
    expiresIn,
    signableHeaders: new Set(Object.keys(headers)),
  })
  if (routing === null) return { url: signed, headers }
  const url = new URL(signed)
  return { url: `${url.origin}${routing.pathPrefix}${url.pathname}${url.search}`, headers }
}

const PRIVATE_NO_STORE = 'private, no-store'
