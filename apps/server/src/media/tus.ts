/**
 * media/tus.ts
 *
 * Fastify plugin: mounts the tus resumable upload server at /api/uploads.
 *
 * Architecture:
 *   - Uses @tus/server v2 with @tus/s3-store (MinIO-compatible via forcePathStyle S3).
 *   - Fastify forwards raw Node.js req/res to tusServer.handle() for all /api/uploads/* requests.
 *   - Auth is enforced in onUploadCreate (JWT required, must have deck editor/owner role;
 *     a component upload — metadata `componentId` — needs the component's folder).
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
 *   - A component master's pictures and videos (A2.12b) are uploaded with
 *     metadata `componentId` instead of `deckId`: only the owner of the
 *     component's folder (resolveComponentAccess — the rule of the master's
 *     Y.Doc), images and videos only (fonts belong to the folder, a .pptx to
 *     a deck); an upload session issued for the component may carry one. Key:
 *     `components/<componentId>/uploads/<assetId>/original.<ext>`, compound
 *     id `<assetId>:unknown:<base64url(key)>` (media/mediaOwner.ts).
 *   - An upload session token (`nus_…`, media/uploadSessions.ts — what
 *     `media.uploadSession` hands an agent) may create ONE media upload in
 *     its own deck or component master, and then only continue that upload.
 *   - A personal access token (scope `api` or `mcp`) may upload media only —
 *     image/*, video/* and fonts. A .pptx by token is refused at create, and
 *     at every PATCH/finish (M2): deck import/append by an agent goes through
 *     `deck.importPptx` / `deck.insertFrom`, which the server host validates,
 *     attributes and audits.
 *   - MIME checked via Upload-Metadata content-type; probe-image-size confirms on finalize.
 *
 * Known limitations / TODOs:
 *   - Orphaned MinIO objects on termination/error are not cleaned up (documented M29 GC).
 *   - No per-user rate limiting (M29).
 *   - HLS presigned URLs for private buckets (M29).
 *   - Video width/height not available at upload time — filled by worker after ffprobe.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Readable } from 'node:stream'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { nanoid } from 'nanoid'
import { Server as TusServer } from '@tus/server'
import type { Upload } from '@tus/server'
import { S3Store } from '@tus/s3-store'
import type { S3ClientConfig } from '@aws-sdk/client-s3'
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3'
import type { Database } from '../db/client.js'
import { COMPONENT_FONT_REFUSED, finalizeMediaUpload, UploadRejected } from './finalizeUpload.js'
import {
  canUseComponentMedia,
  encodeTusUploadId,
  isStorageSafeId,
  mediaOriginalPath,
  mediaOwnerPrefix,
  parseTusUploadId,
  type MediaOwner,
} from './mediaOwner.js'
import {
  MAX_FONT_UPLOAD_SIZE,
  MAX_IMAGE_UPLOAD_SIZE,
  MAX_PPTX_UPLOAD_SIZE,
  MAX_VIDEO_UPLOAD_SIZE,
  PPTX_MIME,
  classifyUpload,
  extensionFromMimeOrFilename,
  isFontUpload,
  maxUploadBytes,
  tooLargeMessage,
} from './uploadPolicy.js'
import { resolveDeckAccess, roleAtLeast } from '../auth/permissions.js'
import { eq } from 'drizzle-orm'
import { folders, decks } from '../db/schema.js'
import { DeleteObjectCommand } from '@aws-sdk/client-s3'
import { importDeckFromPptxBytes } from '../pptx/importDeck.js'
import { appendPptxToDeck } from '../pptx/appendDeck.js'
import { hasAnyScope, resolveRequestIdentity } from '../auth/identity.js'
import {
  createDrizzlePatStore,
  createPatService,
  refuseAllPatOwners,
  type PatScope,
  type PatService,
} from '../auth/personalAccessTokens.js'
import { subsystemLogger } from '../observability/logger.js'
import {
  readBearerUploadSession,
  type UploadSessionService,
  type VerifiedUploadSession,
} from './uploadSessions.js'

const log = subsystemLogger('tus')

// ---------------------------------------------------------------------------
// Config constants
// ---------------------------------------------------------------------------

// Per-kind limits, the accepted kinds and the MIME → extension map live in
// ./uploadPolicy.ts, shared with the server-side upload agents use.

/**
 * The storage key named in `uploadId` (namingFunction, which runs before any
 * check) must lie in the namespace of the owner onUploadCreate authorised:
 * two readers of the same metadata must never disagree about where the
 * bytes go. 400 otherwise.
 */
function requireKeyOfOwner(uploadId: string, owner: MediaOwner): void {
  const path = parseTusUploadId(uploadId)?.path ?? null
  if (path === null || !path.startsWith(`${mediaOwnerPrefix(owner)}/`)) {
    throw { status_code: 400, body: 'The upload metadata names no single owner' }
  }
}

/** tus server-level maxSize — set to the largest of the four; per-MIME enforcement is in onUploadCreate. */
const MAX_UPLOAD_SIZE = Math.max(
  MAX_IMAGE_UPLOAD_SIZE,
  MAX_VIDEO_UPLOAD_SIZE,
  MAX_FONT_UPLOAD_SIZE,
  MAX_PPTX_UPLOAD_SIZE,
)
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
    pats?: PatService
  }
}

/**
 * PAT scopes that may upload media: agents upload through the command
 * surface (MCP or the batch API), so a token with either scope qualifies.
 */
const UPLOAD_TOKEN_SCOPES: readonly PatScope[] = ['api', 'mcp']

/**
 * What a personal access token may upload through tus: media only — images,
 * videos and fonts. A .pptx import or append by token must go through the
 * commands (`deck.importPptx`, `deck.insertFrom`), which the server host
 * validates, attributes to a run and records in the audit log; the tus pptx
 * path would do the same import with none of that.
 */
export function tokenMayUpload(mime: string, filename?: string): boolean {
  return classifyUpload(mime, filename) !== null
}

const COMPONENT_KIND_REFUSED =
  'A component takes pictures and videos only (image/*, video/*); ' +
  'a .pptx is imported into a deck, fonts belong to the folder.'

const TOKEN_PPTX_REFUSED =
  'Forbidden: a personal access token cannot upload a .pptx through tus; ' +
  'import it with deck.importPptx or add its slides with deck.insertFrom'

interface Uploader {
  userId: string
  /** Authenticated with a token (personal access or upload session), not a browser session. */
  viaToken: boolean
  /** Authenticated with an upload session token: the session, else null. */
  session: VerifiedUploadSession | null
}

async function resolveUploader(
  req: IncomingMessage,
  db: Database,
  app: AppWithAuthOpts,
  sessions: UploadSessionService,
): Promise<Uploader | null> {
  // An upload session token authenticates here and nowhere else; it is not
  // a personal access token, so the shared identity resolution ignores it.
  const sessionToken = readBearerUploadSession(req.headers['authorization'])
  if (sessionToken !== null) {
    const session = await sessions.verify(sessionToken)
    return session === null ? null : { userId: session.userSub, viaToken: true, session }
  }
  // tus hooks receive the raw IncomingMessage — the same object Fastify
  // handed to tusServer.handle(), so the identity resolved for it (by the
  // rate limiter or an earlier hook of this request) is reused. Resolution
  // follows authPreHandler: a PAT (`Authorization: Bearer nrt_…`), else
  // BYPASS_AUTH's dev-user, else the narrative_session cookie.
  const result = await resolveRequestIdentity(req, {
    db,
    bypass: app._authOpts?.bypass === true,
    pats:
      app._authOpts?.pats ??
      createPatService(createDrizzlePatStore(db), { isOwnerAllowed: refuseAllPatOwners }),
  })
  if (result.status !== 'ok') return null
  const { user, auth } = result.identity
  if (auth.kind === 'token' && !hasAnyScope(auth, UPLOAD_TOKEN_SCOPES)) return null
  return { userId: user.sub, viaToken: auth.kind === 'token', session: null }
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
  sessions: UploadSessionService,
): Promise<void> {
  const uploader = await resolveUploader(req, db, app, sessions)
  if (!uploader) {
    throw { status_code: 401, body: 'Unauthorized' }
  }
  const { userId } = uploader
  // An upload session continues only the upload it created.
  if (uploader.session !== null && uploader.session.uploadId !== upload.id) {
    throw { status_code: 403, body: 'Forbidden: this upload session belongs to another upload' }
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

  // (b) still-valid access. Recover deckId/folderId/componentId from the
  // upload metadata and the compound id, mirroring what onUploadCreate
  // validated.
  const mime =
    upload.metadata?.['content-type'] ??
    upload.metadata?.['mimeType'] ??
    upload.metadata?.['mimetype'] ??
    ''
  const deckIdFromId = parseTusUploadId(upload.id)?.deckId ?? null
  const deckId = upload.metadata?.['deckId'] ?? deckIdFromId
  const folderId = upload.metadata?.['folderId'] ?? null
  const componentId = upload.metadata?.['componentId'] ?? null

  // A component master's picture or video: the creator must still own the
  // component's folder. Checked first — a component upload has no deck.
  if (componentId) {
    if (mime === PPTX_MIME) throw { status_code: 403, body: 'Forbidden: ' + COMPONENT_KIND_REFUSED }
    if (!(await canUseComponentMedia(db, componentId, userId))) {
      throw { status_code: 403, body: 'Forbidden: access to the component revoked' }
    }
    return
  }

  if (mime === PPTX_MIME) {
    // M2: even the user's own browser-started pptx upload cannot be
    // continued or finished with a token (the finish runs the import).
    if (uploader.viaToken) throw { status_code: 403, body: TOKEN_PPTX_REFUSED }
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
  /**
   * Upload session tokens (`media.uploadSession`). The same service the
   * agent host issues them from (index.ts), with the sign-in policy.
   */
  uploadSessions: UploadSessionService
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
  const sessions = opts.uploadSessions

  // Build S3Store config — bucket is passed inside s3ClientConfig per @tus/s3-store API
  const s3Config = buildS3Config()

  // -------------------------------------------------------------------------
  // Build tus server
  // -------------------------------------------------------------------------
  const tusServer = new TusServer({
    path: '/api/uploads',
    maxSize: MAX_UPLOAD_SIZE,
    // A finished upload is an asset: terminating it through tus would delete
    // the stored bytes under a live media_assets row. Media is removed with
    // media.delete (the row) and the storage sweep.
    disableTerminationForFinishedUploads: true,

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
    // Format: "{assetId}:{deckId}:{storageKey base64url}" — `unknown` in the
    // deck slot for a folder pptx import and for a component upload
    // (media/mediaOwner.ts encodeTusUploadId / parseTusUploadId).
    //
    // Runs BEFORE onUploadCreate: the ids in the metadata are not checked
    // yet. A refused create stores nothing, so a key built from an id that
    // then fails the access check never exists.
    // -----------------------------------------------------------------------
    namingFunction: (_req: IncomingMessage, metadata?: Record<string, string | null>) => {
      const assetId = nanoid(16)
      // `||`, not `??`: an empty id is no id, exactly as onUploadCreate reads it.
      const deckId = metadata?.['deckId'] || 'unknown'
      const folderId = metadata?.['folderId'] || null
      const componentId = metadata?.['componentId'] || null
      // An id that could not name storage keys (mediaOwner.ts) is refused
      // here, before a key is built from it: a 400, not a thrown 500.
      for (const id of [componentId, deckId === 'unknown' ? null : deckId]) {
        if (id !== null && !isStorageSafeId(id)) {
          throw {
            status_code: 400,
            body: 'The upload names a deck or component id that is not valid',
          }
        }
      }
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
      if (componentId && deckId === 'unknown' && mime !== PPTX_MIME) {
        // A component master's picture or video (fonts are refused at create).
        storageKey = mediaOriginalPath({ componentId }, 'uploads', assetId, ext)
        return encodeTusUploadId(assetId, null, storageKey)
      }
      if (mime === PPTX_MIME) {
        // Deck-scoped (insert into an open deck) vs folder-scoped (create a
        // new deck): namespace the transient blob by whichever binding it
        // has, so an orphan sweep can tell what it was for.
        const scope = deckId !== 'unknown' ? `deck/${deckId}` : (folderId ?? 'unknown')
        storageKey = `imports/pptx-temp/${scope}/${assetId}/source.${ext}`
      } else {
        const folder = isFontUpload(mime, filename) ? 'fonts' : 'uploads'
        storageKey = mediaOriginalPath({ deckId }, folder, assetId, ext)
      }

      return encodeTusUploadId(assetId, deckId === 'unknown' ? null : deckId, storageKey)
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
      const uploader = await resolveUploader(req, db, appWithAuth, sessions)
      if (!uploader) {
        throw { status_code: 401, body: 'Unauthorized' }
      }
      const { userId } = uploader

      // Every size check below is against the declared length: an upload
      // that defers it (tus creation-defer-length) could declare anything
      // later, past every per-kind cap. The editor always knows the size.
      if (upload.size === undefined || upload.sizeIsDeferred === true) {
        throw {
          status_code: 400,
          body: 'Upload-Length is required (a deferred length is not accepted)',
        }
      }

      // 2. Parse metadata from Upload-Metadata header
      const meta = parseMetadata(req.headers['upload-metadata'])
      const deckId = meta['deckId'] ?? upload.metadata?.['deckId'] ?? null
      const folderId = meta['folderId'] ?? upload.metadata?.['folderId'] ?? null
      const componentId = meta['componentId'] ?? upload.metadata?.['componentId'] ?? null
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

      // An upload has exactly one owner (A2.12b): a component master, or a
      // deck / folder.
      if (componentId && (deckId || folderId)) {
        throw {
          status_code: 400,
          body: 'An upload has one owner: give componentId, or deckId / folderId, not both',
        }
      }

      // M2: a token uploads media only; decks go through the commands.
      if (uploader.viaToken) {
        const filename = meta['filename'] ?? upload.metadata?.['filename'] ?? undefined
        if (mime === PPTX_MIME) throw { status_code: 403, body: TOKEN_PPTX_REFUSED }
        if (!tokenMayUpload(mime, filename)) {
          throw {
            status_code: 415,
            body: `Unsupported media type for a token upload: ${mime || 'none'}. Only image/*, video/* and font files are accepted.`,
          }
        }
      }

      // An upload session uploads one file of its declared size and kind,
      // into its own deck.
      if (uploader.session !== null) {
        const session = uploader.session
        const filename = meta['filename'] ?? upload.metadata?.['filename'] ?? undefined
        // A session is issued for one deck or one component master
        // (media.uploadSession) and uploads there only.
        const forThisOwner =
          'componentId' in session.owner
            ? componentId === session.owner.componentId && !deckId && !folderId
            : deckId === session.owner.deckId && !componentId
        if (!forThisOwner) {
          throw {
            status_code: 403,
            body: 'Forbidden: this upload session is for another deck or component',
          }
        }
        if (upload.size !== session.sizeBytes) {
          throw {
            status_code: 403,
            body: `Forbidden: this upload session is for a file of ${session.sizeBytes} bytes`,
          }
        }
        if (classifyUpload(mime, filename) !== session.kind) {
          throw {
            status_code: 403,
            body: `Forbidden: this upload session is for a ${session.kind}`,
          }
        }
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
        ...(componentId ? { componentId } : {}),
        ...(insertAtRaw !== null ? { insertAt: insertAtRaw } : {}),
        ...(mime ? { 'content-type': mime } : {}),
      }

      // ─── Component master branch (A2.12b) ──────────────────────────────
      // A master's own pictures and videos. The owner of the component's
      // folder only — whoever may edit the master's document. Fonts belong
      // to the folder and a .pptx to a deck: both refused with 415.
      if (componentId) {
        const filename = meta['filename'] ?? upload.metadata?.['filename'] ?? undefined
        const kind = mime === PPTX_MIME ? null : classifyUpload(mime, filename)
        if (kind === 'font') throw { status_code: 415, body: COMPONENT_FONT_REFUSED }
        if (kind === null) {
          throw {
            status_code: 415,
            body: `Unsupported media type for a component: ${mime || 'none'}. ${COMPONENT_KIND_REFUSED}`,
          }
        }
        if (upload.size > maxUploadBytes(kind)) {
          throw { status_code: 413, body: tooLargeMessage(kind) }
        }
        if (!(await canUseComponentMedia(db, componentId, userId))) {
          throw {
            status_code: 403,
            body: "Forbidden: only the owner of the component's folder may upload into it",
          }
        }
        requireKeyOfOwner(upload.id, { componentId })
        // A session is spent on this upload — last, as in the deck branch.
        if (uploader.session !== null && !(await sessions.claim(uploader.session, upload.id))) {
          throw {
            status_code: 403,
            body: 'Forbidden: this upload session was already used or has expired',
          }
        }
        return { res, metadata: persistedMetadata }
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
      requireKeyOfOwner(upload.id, { deckId })

      // 5. An upload session is spent on this upload — last, so a refused
      // attempt leaves it usable. Atomic: a second creation loses.
      if (uploader.session !== null && !(await sessions.claim(uploader.session, upload.id))) {
        throw {
          status_code: 403,
          body: 'Forbidden: this upload session was already used or has expired',
        }
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
      // GET would serve the stored bytes of an upload (the original file,
      // bypassing signed media URLs and any later loss of access); the
      // editor never downloads through tus, so it is refused outright.
      if (method === 'GET') throw { status_code: 404, body: 'Not found' }
      // PATCH (data), DELETE (termination) and HEAD (the resume offset — it
      // also returns the upload's metadata) are for the upload's creator
      // while they still have access. OPTIONS / POST have their own checks.
      if (method !== 'PATCH' && method !== 'DELETE' && method !== 'HEAD') return

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
      await requireUploadCreatorAndAccess(req, upload, db, appWithAuth, sessions)
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
      const parsedId = parseTusUploadId(upload.id)
      if (parsedId === null) {
        log.error({ uploadId: upload.id }, 'onUploadFinish: malformed upload id')
        throw { status_code: 500, body: 'Internal error: upload id malformed' }
      }
      const { assetId } = parsedId
      const storageKey = upload.id

      // TUS-1: re-authorize before doing any S3 read or DB write. The compound
      // id encodes deckId, but the finish hook previously trusted it blindly —
      // any authenticated user who reached finish on someone else's upload id
      // would have a media_assets row written against the encoded deck. Require
      // the live session user to be the upload's creator AND still hold
      // editor/folder access. (Bypass mode: creator was stored as 'dev-user'
      // and resolveUploader returns 'dev-user', so the check passes.)
      await requireUploadCreatorAndAccess(req, upload, db, appWithAuth, sessions)

      // Auth (may be null if bypass — map to 'unknown' as safety fallback)
      const finisher = await resolveUploader(req, db, appWithAuth, sessions)
      const userId = finisher?.userId ?? 'unknown'
      // An agent's upload (personal access token or upload session) must
      // prove its content type (finalizeUpload.ts `strictContent`).
      const strictContent = finisher?.viaToken === true

      // What the upload IS — type, name, deck / folder, insert index — comes
      // only from the metadata onUploadCreate checked and persisted, never
      // from the finishing request's own Upload-Metadata header: a later
      // PATCH could otherwise re-declare a checked image upload as a .pptx
      // (running an import a token may not) or as a font / SVG (read whole
      // into memory past the image size check).
      const stored = upload.metadata ?? {}
      const filename = stored['filename'] ?? undefined
      const mimeRaw = stored['content-type'] ?? 'application/octet-stream'
      const folderId = stored['folderId'] ?? null
      // A pptx bound to a deck carries its target index; the compound upload
      // id stores 'unknown' for the folder-scoped case, so the metadata is
      // what distinguishes them.
      const pptxDeckId = stored['deckId'] ?? null
      const insertAtRaw = stored['insertAt'] ?? null
      // Who the picture / video belongs to: the component the create checked
      // (its id is in the stored metadata; the deck slot says `unknown`), else
      // the deck of the compound id. Nothing else reaches the media branch —
      // create refuses a media upload with neither.
      const componentId = stored['componentId'] ?? null
      const owner: MediaOwner | null = componentId
        ? { componentId }
        : parsedId.deckId !== null
          ? { deckId: parsedId.deckId }
          : null

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

      // ─── Image / video / font: the shared finalize step ───────────────
      // media/finalizeUpload.ts — the same code the server-side upload agents
      // use (services/media.ts), so both paths apply identical checks.
      if (owner === null) {
        log.error(
          { uploadId: upload.id },
          'onUploadFinish: media upload bound to no deck or component',
        )
        await deleteMinIOObject(s3, storageKey)
        throw { status_code: 400, body: 'Upload is bound to no deck or component' }
      }
      let finalized
      try {
        finalized = await finalizeMediaUpload({
          db,
          s3,
          storageKey,
          assetId,
          owner,
          userId,
          mimeType: mimeRaw,
          filename,
          sizeBytes,
          log,
          strictContent,
        })
      } catch (err) {
        if (err instanceof UploadRejected) throw { status_code: err.status, body: err.message }
        throw err
      }

      if (finalized.kind === 'font') {
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
            sizeBytes: finalized.sizeBytes,
            kind: 'font',
            fontFamily: finalized.fontFamily,
            fontWeight: finalized.fontWeight,
            fontStyle: finalized.fontStyle,
            fontPostscriptName: finalized.fontPostscriptName,
          }),
        }
      }

      if (finalized.kind === 'video') {
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
            sizeBytes: finalized.sizeBytes,
            transcodeStatus: 'pending',
          }),
        }
      }

      // Return finalization body (non-standard but supported by most tus clients)
      const imageHeaders: Record<string, string | number> = {
        'Content-Type': 'application/json',
        'X-Narrative-Asset-Id': assetId,
      }
      if (finalized.width !== null) imageHeaders['X-Narrative-Width'] = finalized.width
      if (finalized.height !== null) imageHeaders['X-Narrative-Height'] = finalized.height

      return {
        res,
        status_code: 200,
        headers: imageHeaders,
        body: JSON.stringify({
          assetId,
          storageKey,
          mimeType: mimeRaw,
          sizeBytes: finalized.sizeBytes,
          width: finalized.width,
          height: finalized.height,
        }),
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
