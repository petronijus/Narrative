/**
 * media/tus.test.ts
 *
 * Tests for the tus upload plugin registered at /api/uploads.
 *
 * Strategy:
 *   - @tus/server and @tus/s3-store are mocked — no real S3/MinIO connection.
 *   - The TusServer mock captures the options passed to it, especially the
 *     onUploadCreate / onUploadFinish / onIncomingRequest hooks.
 *   - We call those hooks directly in tests to verify auth, role, and MIME logic.
 *   - Fastify passthrough tests (OPTIONS / POST / PATCH routing) verify that
 *     tusServer.handle is called for the right paths.
 *
 * Auth in tests: registerAuthPlugin with bypass=true → 'dev-user'.
 * For the "unauthorized" tests we temporarily provide a real verifier mock.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import type { Database } from '../db/client.js'
import { registerAuthPlugin } from '../auth/fastifyAuth.js'

// ---------------------------------------------------------------------------
// Mock @tus/server and @tus/s3-store
// ---------------------------------------------------------------------------

// Capture the options passed to TusServer constructor so we can call hooks directly.
let capturedTusOptions: Record<string, unknown> = {}
const mockHandle = vi
  .fn()
  .mockImplementation(async (_req, res: { statusCode: number; end: () => void }) => {
    res.statusCode = 204
    res.end()
  })

// TUS-1: onIncomingRequest now loads the stored upload via
// `tusServer.datastore.getUpload(id)` to recover its creator + deck binding.
// The mock exposes a configurable datastore so PATCH/DELETE tests can hand
// back an upload with arbitrary stored metadata.
let mockStoredUpload: Record<string, unknown> = {}
const mockGetUpload = vi.fn().mockImplementation(async () => mockStoredUpload)

/** Upload-Metadata as tus decodes it for `namingFunction`. */
function decodedMetadata(header: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (typeof header !== 'string') return out
  for (const pair of header.split(',')) {
    const [key, value = ''] = pair.trim().split(' ')
    if (key) out[key] = Buffer.from(value, 'base64').toString('utf8')
  }
  return out
}

vi.mock('@tus/server', () => ({
  Server: vi.fn().mockImplementation(function (opts: Record<string, unknown>) {
    // As tus does: a creation is named (`namingFunction`, from the request's
    // Upload-Metadata) before `onUploadCreate` sees it. A test that passes an
    // upload without an id gets the one the server would have made.
    const naming = opts['namingFunction'] as (
      req: Request,
      metadata: Record<string, string>,
    ) => string
    const create = opts['onUploadCreate'] as (
      req: Request,
      upload: { id?: string; metadata?: Record<string, string> },
    ) => Promise<unknown>
    capturedTusOptions = {
      ...opts,
      onUploadCreate: (req: Request, upload: { id?: string; metadata?: Record<string, string> }) =>
        create(req, {
          ...upload,
          id:
            upload.id ??
            naming(req, {
              ...(upload.metadata ?? {}),
              ...decodedMetadata(req.headers.get('upload-metadata')),
            }),
        }),
    }
    return { handle: mockHandle, datastore: { getUpload: mockGetUpload } }
  }),
}))

vi.mock('@tus/s3-store', () => ({
  S3Store: vi.fn().mockImplementation(function () {
    return {}
  }),
}))

// Valid signatures so the image-branch magic-byte check passes for the
// existing image upload tests. We return bytes whose signature matches the
// object key's extension (the storageKey ends in original.<ext>), so a
// .jpg upload reads back JPEG bytes and a .png reads back PNG bytes. The
// dedicated rejection-path coverage lives in svgSanitize.test.ts.
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])
/** An ISO BMFF header: size, then the `ftyp` box type at offset 4. */
const MP4_BYTES = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypmp42', 'latin1'),
  Buffer.alloc(12),
])

// A hostile SVG returned for .svg keys so the onUploadFinish SVG path can be
// exercised end-to-end (sanitize → PutObject). Overridable per-test.
let svgBytesForGet: Buffer = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script><rect width="10" height="10" onload="x()"/></svg>`,
  'utf8',
)

// The S3 Key is the compound upload id `assetId:deckId:<base64url(path)>`;
// the real file extension lives in the base64url-encoded path segment, so we
// decode it to decide which signature bytes to hand back.
function decodedExt(key: string | undefined): string {
  if (!key) return ''
  const seg = key.split(':')[2]
  if (!seg) return key // not a compound id — match against raw key
  try {
    return Buffer.from(seg, 'base64url').toString('utf8')
  } catch {
    return key
  }
}

function bytesForKey(key: string | undefined): Buffer {
  const path = decodedExt(key)
  if (/\.svg$/i.test(path)) return svgBytesForGet
  if (/\.jpe?g$/i.test(path)) return JPEG_BYTES
  if (/\.mp4$/i.test(path)) return MP4_BYTES
  return PNG_BYTES
}

// Last-built S3 send mock, so tests can inspect PutObject/DeleteObject calls.
let lastS3Send: ReturnType<typeof vi.fn>

// Discriminate command instances by a `__type` tag set in the constructor mock
// so the shared `send` can answer Head vs Get vs Put vs Delete appropriately.
function makeS3Send() {
  const send = vi.fn().mockImplementation(async (cmd: { __type?: string; Key?: string }) => {
    switch (cmd?.__type) {
      case 'get': {
        const { Readable } = await import('node:stream')
        const bytes = bytesForKey(cmd.Key)
        return { ContentLength: bytes.length, Body: Readable.from([bytes]) }
      }
      case 'put':
      case 'delete':
        return {}
      case 'head':
      default:
        return { ContentLength: 1024 }
    }
  })
  lastS3Send = send
  return send
}

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(function () {
    return { send: makeS3Send() }
  }),
  GetObjectCommand: vi.fn().mockImplementation(function (input: Record<string, unknown>) {
    return { __type: 'get', ...input }
  }),
  HeadObjectCommand: vi.fn().mockImplementation(function (input: Record<string, unknown>) {
    return { __type: 'head', ...input }
  }),
  PutObjectCommand: vi.fn().mockImplementation(function (input: Record<string, unknown>) {
    return { __type: 'put', ...input }
  }),
  DeleteObjectCommand: vi.fn().mockImplementation(function (input: Record<string, unknown>) {
    return { __type: 'delete', ...input }
  }),
}))

vi.mock('./assets.js', () => ({
  createMediaAsset: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('./enqueue.js', () => ({
  enqueueVideoTranscode: vi.fn().mockResolvedValue(undefined),
}))

// Mock probe-image-size (createRequire path)
vi.mock('node:module', () => ({
  createRequire: vi.fn(
    () => () =>
      vi.fn().mockResolvedValue({ width: 100, height: 100, mime: 'image/jpeg', type: 'jpg' }),
  ),
}))

vi.mock('../auth/permissions.js', () => ({
  resolveDeckAccess: vi.fn(),
  resolveComponentAccess: vi.fn(),
  roleAtLeast: vi.fn(),
}))

import { resolveComponentAccess, resolveDeckAccess, roleAtLeast } from '../auth/permissions.js'

/** The real role order, for the tests whose outcome depends on a role boundary. */
const { roleAtLeast: realRoleAtLeast } =
  await vi.importActual<typeof import('../auth/permissions.js')>('../auth/permissions.js')
import { createMediaAsset } from './assets.js'
import { enqueueVideoTranscode } from './enqueue.js'
import { registerTusPlugin, tokenMayUpload } from './tus.js'
import { createAllowingUploadSessionService } from '../test-support/memoryUploadSessionStore.js'

// ---------------------------------------------------------------------------
// Types used in hook calls
// ---------------------------------------------------------------------------

// Hooks from @tus/server 2.x take a web Request (and the Upload or its id)
type OnUploadCreate = (req: Request, upload: unknown) => Promise<Record<string, unknown>>
type OnIncomingRequest = (req: Request, uploadId: string) => Promise<void>
type OnUploadFinish = (req: Request, upload: unknown) => Promise<Record<string, unknown>>

import type { IncomingMessage } from 'node:http'

/**
 * A hook's request as tus 2 hands it over: a web Request whose
 * `runtime.node.req` is the Node request Fastify handled (srvx's bridge) —
 * the object the hooks resolve the uploader from.
 */
function buildRequest(opts: {
  authHeader?: string
  uploadMetadata?: string
  method?: string
}): Request {
  const headers: Record<string, string> = {}
  if (opts.authHeader) headers['authorization'] = opts.authHeader
  if (opts.uploadMetadata) headers['upload-metadata'] = opts.uploadMetadata
  const method = opts.method ?? 'POST'
  const node = { headers, method } as unknown as IncomingMessage
  return {
    method,
    headers: new Headers(headers),
    runtime: { node: { req: node } },
  } as unknown as Request
}

/** Encodes a metadata pair as tus Upload-Metadata format (base64 value). */
/** The compound upload id namingFunction makes for a deck's image upload. */
function deckUploadId(assetId: string, deckId = 'deck-1', ext = 'png'): string {
  const path = `decks/${deckId}/uploads/${assetId}/original.${ext}`
  return `${assetId}:${deckId}:${Buffer.from(path).toString('base64url')}`
}

function tusMetadata(pairs: Record<string, string>): string {
  return Object.entries(pairs)
    .map(([k, v]) => `${k} ${Buffer.from(v).toString('base64')}`)
    .join(',')
}

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

async function buildApp(bypassAuth = true): Promise<FastifyInstance> {
  capturedTusOptions = {}

  const app = Fastify({ logger: false })
  const mockDb = {} as unknown as Database

  const authOpts = bypassAuth
    ? { verifier: null, bypass: true, db: mockDb }
    : {
        verifier: {
          verify: vi.fn().mockRejectedValue(new Error('invalid token')),
        },
        bypass: false,
        db: mockDb,
      }

  registerAuthPlugin(app, authOpts)
  registerTusPlugin(app, { db: mockDb, uploadSessions: createAllowingUploadSessionService() })

  await app.ready()
  return app
}

// ---------------------------------------------------------------------------
// Tests: Fastify passthrough routing
// ---------------------------------------------------------------------------

describe('tus Fastify passthrough', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedTusOptions = {}
  })

  it('forwards OPTIONS /api/uploads to tusServer.handle', async () => {
    const app = await buildApp()
    await app.inject({ method: 'OPTIONS', url: '/api/uploads' })
    expect(mockHandle).toHaveBeenCalled()
  })

  it('forwards POST /api/uploads to tusServer.handle', async () => {
    const app = await buildApp()
    await app.inject({ method: 'POST', url: '/api/uploads' })
    expect(mockHandle).toHaveBeenCalled()
  })

  it('forwards PATCH /api/uploads/some-id to tusServer.handle', async () => {
    const app = await buildApp()
    await app.inject({ method: 'PATCH', url: '/api/uploads/abc123' })
    expect(mockHandle).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Tests: onUploadCreate hook
// ---------------------------------------------------------------------------

describe('onUploadCreate hook', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedTusOptions = {}
  })

  it('throws 401 when no Authorization header and auth is not bypassed', async () => {
    await buildApp(false)
    const hook = capturedTusOptions['onUploadCreate'] as OnUploadCreate

    const req = buildRequest({}) // no auth header
    const upload = { size: 1024, metadata: { deckId: 'deck-1', 'content-type': 'image/jpeg' } }

    await expect(hook(req, upload)).rejects.toMatchObject({ status_code: 401 })
  })

  it('throws 400 when deckId is missing from Upload-Metadata', async () => {
    await buildApp(true) // bypass → dev-user
    const hook = capturedTusOptions['onUploadCreate'] as OnUploadCreate

    const req = buildRequest({
      uploadMetadata: tusMetadata({ 'content-type': 'image/png' }),
    })
    const upload = { size: 1024, metadata: {} }

    await expect(hook(req, upload)).rejects.toMatchObject({ status_code: 400 })
  })

  it('throws 415 when MIME type is neither image/* nor video/*', async () => {
    await buildApp(true)
    const hook = capturedTusOptions['onUploadCreate'] as OnUploadCreate

    vi.mocked(resolveDeckAccess).mockResolvedValue({ role: 'editor', reason: 'direct' })
    vi.mocked(roleAtLeast).mockReturnValue(true)

    const req = buildRequest({
      uploadMetadata: tusMetadata({ deckId: 'deck-1', 'content-type': 'application/pdf' }),
    })
    const upload = { metadata: { deckId: 'deck-1' }, size: 1000 }

    await expect(hook(req, upload)).rejects.toMatchObject({ status_code: 415 })
  })

  it('accepts video/mp4 MIME type for editor role', async () => {
    await buildApp(true)
    const hook = capturedTusOptions['onUploadCreate'] as OnUploadCreate

    vi.mocked(resolveDeckAccess).mockResolvedValue({ role: 'editor', reason: 'direct' })
    vi.mocked(roleAtLeast).mockReturnValue(true)

    const req = buildRequest({
      uploadMetadata: tusMetadata({ deckId: 'deck-1', 'content-type': 'video/mp4' }),
    })
    const upload = { metadata: { deckId: 'deck-1' }, size: 1000 }

    await expect(hook(req, upload)).resolves.toBeDefined()
  })

  it('throws 413 when video size exceeds MAX_VIDEO_UPLOAD_SIZE', async () => {
    await buildApp(true)
    const hook = capturedTusOptions['onUploadCreate'] as OnUploadCreate

    vi.mocked(resolveDeckAccess).mockResolvedValue({ role: 'editor', reason: 'direct' })
    vi.mocked(roleAtLeast).mockReturnValue(true)

    const req = buildRequest({
      uploadMetadata: tusMetadata({ deckId: 'deck-1', 'content-type': 'video/mp4' }),
    })
    // 501 MB — above the default 500 MB video limit
    const upload = { metadata: { deckId: 'deck-1' }, size: 501_000_000 }

    await expect(hook(req, upload)).rejects.toMatchObject({ status_code: 413 })
  })

  it('throws 413 when image size exceeds MAX_IMAGE_UPLOAD_SIZE', async () => {
    await buildApp(true)
    const hook = capturedTusOptions['onUploadCreate'] as OnUploadCreate

    vi.mocked(resolveDeckAccess).mockResolvedValue({ role: 'editor', reason: 'direct' })
    vi.mocked(roleAtLeast).mockReturnValue(true)

    const req = buildRequest({
      uploadMetadata: tusMetadata({ deckId: 'deck-1', 'content-type': 'image/jpeg' }),
    })
    // 26 MB — above the default 25 MB image limit
    const upload = { metadata: { deckId: 'deck-1' }, size: 26_000_000 }

    await expect(hook(req, upload)).rejects.toMatchObject({ status_code: 413 })
  })

  it('throws 403 when user has viewer role (not editor or owner)', async () => {
    await buildApp(true)
    const hook = capturedTusOptions['onUploadCreate'] as OnUploadCreate

    vi.mocked(resolveDeckAccess).mockResolvedValue({ role: 'viewer', reason: 'share-link' })
    vi.mocked(roleAtLeast).mockReturnValue(false)

    const req = buildRequest({
      uploadMetadata: tusMetadata({ deckId: 'deck-1', 'content-type': 'image/jpeg' }),
    })
    const upload = { size: 1024, metadata: { deckId: 'deck-1' } }

    await expect(hook(req, upload)).rejects.toMatchObject({ status_code: 403 })
  })

  it('resolves successfully for an editor role with valid image MIME', async () => {
    await buildApp(true)
    const hook = capturedTusOptions['onUploadCreate'] as OnUploadCreate

    vi.mocked(resolveDeckAccess).mockResolvedValue({ role: 'editor', reason: 'direct' })
    vi.mocked(roleAtLeast).mockReturnValue(true)

    const req = buildRequest({
      uploadMetadata: tusMetadata({ deckId: 'deck-1', 'content-type': 'image/png' }),
    })
    const upload = { size: 1024, metadata: { deckId: 'deck-1' } }

    await expect(hook(req, upload)).resolves.toBeDefined()
  })

  it('resolves successfully for an owner role', async () => {
    await buildApp(true)
    const hook = capturedTusOptions['onUploadCreate'] as OnUploadCreate

    vi.mocked(resolveDeckAccess).mockResolvedValue({ role: 'owner', reason: 'direct' })
    vi.mocked(roleAtLeast).mockReturnValue(true)

    const req = buildRequest({
      uploadMetadata: tusMetadata({ deckId: 'deck-1', 'content-type': 'image/jpeg' }),
    })
    const upload = { size: 1024, metadata: { deckId: 'deck-1' } }

    await expect(hook(req, upload)).resolves.toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Tests: onIncomingRequest hook (PATCH auth re-check)
// ---------------------------------------------------------------------------

describe('onUploadCreate: declared length', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(resolveDeckAccess).mockResolvedValue({ role: 'editor', reason: 'direct' })
    vi.mocked(roleAtLeast).mockReturnValue(true)
  })

  it('refuses a deferred Upload-Length: every size cap is checked against it', async () => {
    await buildApp(true)
    const hook = capturedTusOptions['onUploadCreate'] as OnUploadCreate
    const req = buildRequest({
      uploadMetadata: tusMetadata({ deckId: 'deck-1', 'content-type': 'image/png' }),
    })
    for (const upload of [
      { metadata: { deckId: 'deck-1' } },
      { size: undefined, sizeIsDeferred: true, metadata: { deckId: 'deck-1' } },
    ]) {
      await expect(hook(req, upload)).rejects.toMatchObject({ status_code: 400 })
    }
  })
})

describe('onIncomingRequest hook', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedTusOptions = {}
    mockStoredUpload = {}
    // Permissive deck access by default; creator-binding tests override the
    // stored upload's creatorUserId to force a mismatch instead.
    vi.mocked(resolveDeckAccess).mockResolvedValue({ role: 'editor', reason: 'direct' })
    vi.mocked(roleAtLeast).mockReturnValue(true)
  })

  it('throws 401 on PATCH without auth when auth is not bypassed', async () => {
    await buildApp(false)
    const hook = capturedTusOptions['onIncomingRequest'] as OnIncomingRequest

    const req = buildRequest({ method: 'PATCH' })
    await expect(hook(req, 'upload-id-123')).rejects.toMatchObject({ status_code: 401 })
  })

  it('refuses GET outright: stored bytes are served through signed media URLs only', async () => {
    await buildApp(true)
    const hook = capturedTusOptions['onIncomingRequest'] as OnIncomingRequest
    await expect(hook(buildRequest({ method: 'GET' }), 'asset-x:deck-1:abc')).rejects.toMatchObject(
      { status_code: 404 },
    )
  })

  it("guards HEAD like PATCH: no one but the upload's creator learns its offset and metadata", async () => {
    await buildApp(false)
    const hook = capturedTusOptions['onIncomingRequest'] as OnIncomingRequest
    await expect(
      hook(buildRequest({ method: 'HEAD' }), 'asset-x:deck-1:abc'),
    ).rejects.toMatchObject({ status_code: 401 })

    await buildApp(true)
    const bypassed = capturedTusOptions['onIncomingRequest'] as OnIncomingRequest
    mockStoredUpload = {
      id: 'asset-x:deck-1:abc',
      metadata: { deckId: 'deck-1', 'content-type': 'image/png', creatorUserId: 'someone-else' },
    }
    await expect(
      bypassed(buildRequest({ method: 'HEAD' }), 'asset-x:deck-1:abc'),
    ).rejects.toMatchObject({ status_code: 403 })
  })

  it('does not throw on OPTIONS (no auth check)', async () => {
    await buildApp(false)
    const hook = capturedTusOptions['onIncomingRequest'] as OnIncomingRequest

    const req = buildRequest({ method: 'OPTIONS' })
    await expect(hook(req, '')).resolves.toBeUndefined()
  })

  // TUS-1: a PATCH from a user who is NOT the upload's creator must be
  // rejected even when they hold a valid session. Bypass mode resolves the
  // live user to 'dev-user'; we store a *different* creator so the binding
  // check fails.
  it('throws 403 on PATCH when requester is not the upload creator', async () => {
    await buildApp(true)
    const hook = capturedTusOptions['onIncomingRequest'] as OnIncomingRequest

    mockStoredUpload = {
      id: 'asset-x:deck-1:abc',
      metadata: { deckId: 'deck-1', 'content-type': 'image/png', creatorUserId: 'someone-else' },
    }

    const req = buildRequest({ method: 'PATCH' })
    await expect(hook(req, 'asset-x:deck-1:abc')).rejects.toMatchObject({
      status_code: 403,
    })
  })

  // TUS-1: fail closed when the stored upload has no recorded creator (a
  // legacy in-flight upload created before this binding existed).
  it('throws 403 on PATCH when the upload has no recorded creator', async () => {
    await buildApp(true)
    const hook = capturedTusOptions['onIncomingRequest'] as OnIncomingRequest

    mockStoredUpload = {
      id: 'asset-y:deck-1:abc',
      metadata: { deckId: 'deck-1', 'content-type': 'image/png' },
    }

    const req = buildRequest({ method: 'PATCH' })
    await expect(hook(req, 'asset-y:deck-1:abc')).rejects.toMatchObject({
      status_code: 403,
    })
  })

  // TUS-1: even the correct creator is rejected if deck access was revoked.
  it('throws 403 on PATCH when creator matches but deck access was revoked', async () => {
    await buildApp(true)
    const hook = capturedTusOptions['onIncomingRequest'] as OnIncomingRequest

    vi.mocked(resolveDeckAccess).mockResolvedValue(null)

    mockStoredUpload = {
      id: 'asset-z:deck-1:abc',
      metadata: { deckId: 'deck-1', 'content-type': 'image/png', creatorUserId: 'dev-user' },
    }

    const req = buildRequest({ method: 'PATCH' })
    await expect(hook(req, 'asset-z:deck-1:abc')).rejects.toMatchObject({
      status_code: 403,
    })
  })

  // TUS-1: the happy path — correct creator with live editor access proceeds.
  it('resolves on PATCH for the creator with live editor access', async () => {
    await buildApp(true)
    const hook = capturedTusOptions['onIncomingRequest'] as OnIncomingRequest

    mockStoredUpload = {
      id: 'asset-ok:deck-1:abc',
      metadata: { deckId: 'deck-1', 'content-type': 'image/png', creatorUserId: 'dev-user' },
    }

    const req = buildRequest({ method: 'PATCH' })
    await expect(hook(req, 'asset-ok:deck-1:abc')).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Tests: onUploadFinish hook
// ---------------------------------------------------------------------------

describe('onUploadFinish hook', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedTusOptions = {}
    // TUS-1: onUploadFinish now re-runs the creator + deck-access check
    // before writing the media_assets row. Default the access mocks to
    // "editor allowed" so the happy-path tests exercise the insert; the
    // creator binding is supplied per-test via upload.metadata.creatorUserId.
    vi.mocked(resolveDeckAccess).mockResolvedValue({ role: 'editor', reason: 'direct' })
    vi.mocked(roleAtLeast).mockReturnValue(true)
  })

  it('refuses a stored object larger than its kind allows before reading it', async () => {
    await buildApp(true)
    const hook = capturedTusOptions['onUploadFinish'] as OnUploadFinish
    const assetId = 'asset-bigfont1'
    const deckId = 'deck-bigfont'
    const decodedPath = `decks/${deckId}/fonts/${assetId}/original.ttf`
    const uploadId = `${assetId}:${deckId}:${Buffer.from(decodedPath).toString('base64url')}`
    // The store holds far more than the 8 MB font limit.
    lastS3Send!.mockImplementationOnce(async () => ({ ContentLength: 400_000_000 }))
    await expect(
      hook(buildRequest({}), {
        id: uploadId,
        size: 1024,
        offset: 1024,
        metadata: { deckId, creatorUserId: 'dev-user', 'content-type': 'font/ttf' },
      }),
    ).rejects.toMatchObject({ status_code: 413 })
  })

  it('decides what the upload is from the metadata checked at create, not the finishing request', async () => {
    await buildApp(true)
    const hook = capturedTusOptions['onUploadFinish'] as OnUploadFinish
    const assetId = 'asset-retype01'
    const deckId = 'deck-retype'
    const decodedPath = `decks/${deckId}/uploads/${assetId}/original.png`
    const uploadId = `${assetId}:${deckId}:${Buffer.from(decodedPath).toString('base64url')}`
    // The last PATCH re-declares the checked image as a .pptx.
    const req = buildRequest({
      uploadMetadata: tusMetadata({
        deckId,
        'content-type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      }),
    })
    const upload = {
      id: uploadId,
      size: 2048,
      offset: 2048,
      metadata: { deckId, 'content-type': 'image/png', creatorUserId: 'dev-user' },
    }
    const result = await hook(req, upload)
    // Finished as the image it was created as: the asset JSON, no deck import.
    expect(JSON.parse(result['body'] as string)).toMatchObject({ assetId, mimeType: 'image/png' })
  })

  it('calls createMediaAsset with correct storageKey and assetId', async () => {
    await buildApp(true)
    const hook = capturedTusOptions['onUploadFinish'] as OnUploadFinish

    const assetId = 'asset-abc123456'
    const deckId = 'deck-beta'
    // tus-server writes the file at the @tus/s3-store-managed key `upload.id`.
    // onUploadFinish stores `upload.id` directly as `storageKey` so the
    // record's pointer matches the actual S3 object — see tus.ts:467-476.
    const decodedPath = `decks/${deckId}/uploads/${assetId}/original.jpg`
    const storageKeyB64 = Buffer.from(decodedPath).toString('base64url')
    const uploadId = `${assetId}:${deckId}:${storageKeyB64}`

    const req = buildRequest({
      uploadMetadata: tusMetadata({
        deckId,
        'content-type': 'image/jpeg',
        filename: 'test.jpg',
      }),
    })

    const upload = {
      id: uploadId,
      size: 2048,
      offset: 2048,
      metadata: { deckId, 'content-type': 'image/jpeg', creatorUserId: 'dev-user' },
    }
    await hook(req, upload)

    expect(createMediaAsset).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: assetId,
        deckId,
        storageKey: uploadId,
        mimeType: 'image/jpeg',
      }),
    )
  })

  it('returns a JSON body with assetId, storageKey, mimeType, sizeBytes', async () => {
    await buildApp(true)
    const hook = capturedTusOptions['onUploadFinish'] as OnUploadFinish

    const assetId = 'asset-xyz789'
    const deckId = 'deck-gamma'
    const decodedPath = `decks/${deckId}/uploads/${assetId}/original.png`
    const storageKeyB64 = Buffer.from(decodedPath).toString('base64url')
    const uploadId = `${assetId}:${deckId}:${storageKeyB64}`

    const req = buildRequest({
      uploadMetadata: tusMetadata({ deckId, 'content-type': 'image/png' }),
    })

    const upload = {
      id: uploadId,
      size: 4096,
      offset: 4096,
      metadata: { deckId, creatorUserId: 'dev-user', 'content-type': 'image/png' },
    }
    const result = (await hook(req, upload)) as { status_code: number; body: string }

    expect(result.status_code).toBe(200)
    const body = JSON.parse(result.body) as Record<string, unknown>
    expect(body['assetId']).toBe(assetId)
    // storageKey is the full upload.id — that's what @tus/s3-store wrote to S3.
    expect(body['storageKey']).toBe(uploadId)
  })

  // TUS-1: onUploadFinish must reject a finalize from a non-creator so it
  // never writes a media_assets row against a deck the requester didn't
  // create the upload under. Bypass resolves the live user to 'dev-user';
  // we store a different creator to force the mismatch.
  it('throws 403 and does NOT insert when finalizer is not the creator', async () => {
    await buildApp(true)
    const hook = capturedTusOptions['onUploadFinish'] as OnUploadFinish

    const assetId = 'asset-notmine'
    const deckId = 'deck-victim'
    const decodedPath = `decks/${deckId}/uploads/${assetId}/original.jpg`
    const uploadId = `${assetId}:${deckId}:${Buffer.from(decodedPath).toString('base64url')}`

    const req = buildRequest({
      uploadMetadata: tusMetadata({ deckId, 'content-type': 'image/jpeg' }),
    })
    const upload = {
      id: uploadId,
      size: 2048,
      offset: 2048,
      metadata: { deckId, 'content-type': 'image/jpeg', creatorUserId: 'someone-else' },
    }

    await expect(hook(req, upload)).rejects.toMatchObject({ status_code: 403 })
    expect(createMediaAsset).not.toHaveBeenCalled()
  })

  it('throws 500 if upload id is malformed', async () => {
    await buildApp(true)
    const hook = capturedTusOptions['onUploadFinish'] as OnUploadFinish

    const req = buildRequest({})
    const upload = { id: 'bad-id-no-colon', size: 100, offset: 100, metadata: {} }

    await expect(hook(req, upload)).rejects.toMatchObject({ status_code: 500 })
  })

  it('video upload: creates asset with kind=video and transcodeStatus=pending', async () => {
    await buildApp(true)
    const hook = capturedTusOptions['onUploadFinish'] as OnUploadFinish

    const assetId = 'asset-video01'
    const deckId = 'deck-video'
    const decodedPath = `decks/${deckId}/uploads/${assetId}/original.mp4`
    const storageKeyB64 = Buffer.from(decodedPath).toString('base64url')
    const uploadId = `${assetId}:${deckId}:${storageKeyB64}`

    const req = buildRequest({
      uploadMetadata: tusMetadata({
        deckId,
        'content-type': 'video/mp4',
        filename: 'clip.mp4',
      }),
    })

    const upload = {
      id: uploadId,
      size: 10_000_000,
      offset: 10_000_000,
      metadata: { deckId, 'content-type': 'video/mp4', creatorUserId: 'dev-user' },
    }
    const result = (await hook(req, upload)) as { status_code: number; body: string }

    expect(createMediaAsset).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: assetId,
        deckId,
        storageKey: uploadId,
        mimeType: 'video/mp4',
        kind: 'video',
        transcodeStatus: 'pending',
      }),
    )

    expect(result.status_code).toBe(200)
    const body = JSON.parse(result.body) as Record<string, unknown>
    expect(body['transcodeStatus']).toBe('pending')
    expect(body['assetId']).toBe(assetId)
  })

  it('video upload: enqueues a transcode job with correct args', async () => {
    await buildApp(true)
    const hook = capturedTusOptions['onUploadFinish'] as OnUploadFinish

    const assetId = 'asset-video02'
    const deckId = 'deck-video2'
    const decodedPath = `decks/${deckId}/uploads/${assetId}/original.mp4`
    const storageKeyB64 = Buffer.from(decodedPath).toString('base64url')
    const uploadId = `${assetId}:${deckId}:${storageKeyB64}`

    const req = buildRequest({
      uploadMetadata: tusMetadata({ deckId, 'content-type': 'video/mp4' }),
    })

    const upload = {
      id: uploadId,
      size: 5_000_000,
      offset: 5_000_000,
      metadata: { deckId, creatorUserId: 'dev-user', 'content-type': 'video/mp4' },
    }
    await hook(req, upload)

    expect(enqueueVideoTranscode).toHaveBeenCalledWith(
      expect.objectContaining({
        assetId,
        deckId,
        storageKey: uploadId,
        mimeType: 'video/mp4',
      }),
    )
  })

  it('svg upload: sanitizes hostile SVG and writes cleaned bytes back via PutObject', async () => {
    await buildApp(true)
    const hook = capturedTusOptions['onUploadFinish'] as OnUploadFinish

    const assetId = 'asset-svg01'
    const deckId = 'deck-svg'
    const decodedPath = `decks/${deckId}/uploads/${assetId}/original.svg`
    const uploadId = `${assetId}:${deckId}:${Buffer.from(decodedPath).toString('base64url')}`

    const req = buildRequest({
      uploadMetadata: tusMetadata({ deckId, 'content-type': 'image/svg+xml', filename: 'x.svg' }),
    })
    const upload = {
      id: uploadId,
      size: 200,
      offset: 200,
      metadata: { deckId, creatorUserId: 'dev-user', 'content-type': 'image/svg+xml' },
    }

    const result = (await hook(req, upload)) as { status_code: number }
    expect(result.status_code).toBe(200)

    // A PutObject with sanitized (script-free) SVG must have been issued.
    const putCall = lastS3Send.mock.calls.find(
      (c) => (c[0] as { __type?: string }).__type === 'put',
    )
    expect(putCall).toBeDefined()
    const body = (putCall![0] as { Body: Buffer }).Body.toString('utf8').toLowerCase()
    expect(body).not.toContain('<script')
    expect(body).not.toContain('onload')
    expect(body).toContain('<svg')
    expect(createMediaAsset).toHaveBeenCalled()
  })

  it('svg upload: rejects (400) and deletes object when SVG sanitizes to nothing', async () => {
    await buildApp(true)
    const hook = capturedTusOptions['onUploadFinish'] as OnUploadFinish

    svgBytesForGet = Buffer.from('<script>alert(1)</script>', 'utf8')

    const assetId = 'asset-svg02'
    const deckId = 'deck-svg2'
    const decodedPath = `decks/${deckId}/uploads/${assetId}/original.svg`
    const uploadId = `${assetId}:${deckId}:${Buffer.from(decodedPath).toString('base64url')}`

    const req = buildRequest({
      uploadMetadata: tusMetadata({ deckId, 'content-type': 'image/svg+xml' }),
    })
    const upload = {
      id: uploadId,
      size: 25,
      offset: 25,
      metadata: { deckId, creatorUserId: 'dev-user', 'content-type': 'image/svg+xml' },
    }

    await expect(hook(req, upload)).rejects.toMatchObject({ status_code: 400 })
    const deleteCall = lastS3Send.mock.calls.find(
      (c) => (c[0] as { __type?: string }).__type === 'delete',
    )
    expect(deleteCall).toBeDefined()
    expect(createMediaAsset).not.toHaveBeenCalled()

    // restore default hostile-but-valid SVG for subsequent tests
    svgBytesForGet = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>`,
      'utf8',
    )
  })
})

// ---------------------------------------------------------------------------
// Tests: personal access tokens (agentic A1)
// ---------------------------------------------------------------------------

describe('tus upload with a personal access token', () => {
  // Built with a real PAT service over an in-memory store, auth NOT bypassed.
  async function buildPatApp() {
    const { createPatService } = await import('../auth/personalAccessTokens.js')
    const { createMemoryPatStore, allowAllPatOwners } =
      await import('../test-support/memoryPatStore.js')
    const pats = createPatService(createMemoryPatStore(), { isOwnerAllowed: allowAllPatOwners })
    capturedTusOptions = {}
    const app = Fastify({ logger: false })
    const db = {} as unknown as Database
    registerAuthPlugin(app, { bypass: false, db, pats })
    registerTusPlugin(app, { db, uploadSessions: createAllowingUploadSessionService() })
    await app.ready()
    return { app, pats }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(resolveDeckAccess).mockResolvedValue({ role: 'editor', reason: 'direct' })
    vi.mocked(roleAtLeast).mockReturnValue(true)
  })

  it.each([[['api']], [['mcp']]] as const)(
    'accepts a PAT with scope %j and records its user as the upload creator',
    async (scopes) => {
      const { pats } = await buildPatApp()
      const { token } = await pats.create('pat-user', {
        name: 'agent',
        scopes: [...scopes],
        expiresInDays: 365,
      })
      const hook = capturedTusOptions['onUploadCreate'] as OnUploadCreate

      const req = buildRequest({
        authHeader: `Bearer ${token}`,
        uploadMetadata: tusMetadata({ deckId: 'deck-1', 'content-type': 'image/png' }),
      })
      const result = await hook(req, {
        size: 1024,
        metadata: { deckId: 'deck-1' },
      })
      expect(result).toMatchObject({
        metadata: expect.objectContaining({ creatorUserId: 'pat-user' }),
      })
      expect(resolveDeckAccess).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ userId: 'pat-user' }),
      )
    },
  )

  it('rejects a revoked PAT with 401', async () => {
    const { pats } = await buildPatApp()
    const { token, summary } = await pats.create('pat-user', {
      name: 'agent',
      scopes: ['api'],
      expiresInDays: 365,
    })
    await pats.revoke('pat-user', summary.id)
    const hook = capturedTusOptions['onUploadCreate'] as OnUploadCreate

    const req = buildRequest({
      authHeader: `Bearer ${token}`,
      uploadMetadata: tusMetadata({ deckId: 'deck-1', 'content-type': 'image/png' }),
    })
    await expect(hook(req, { size: 1024, metadata: { deckId: 'deck-1' } })).rejects.toMatchObject({
      status_code: 401,
    })
  })

  it('lets the creating PAT continue its own upload (PATCH)', async () => {
    const { pats } = await buildPatApp()
    const { token } = await pats.create('pat-user', {
      name: 'agent',
      scopes: ['api'],
      expiresInDays: 365,
    })
    const hook = capturedTusOptions['onIncomingRequest'] as OnIncomingRequest
    mockStoredUpload = {
      id: 'asset-x:deck-1:abc',
      metadata: { deckId: 'deck-1', 'content-type': 'image/png', creatorUserId: 'pat-user' },
    }
    const req = buildRequest({ method: 'PATCH', authHeader: `Bearer ${token}` })
    await expect(hook(req, 'asset-x:deck-1:abc')).resolves.toBeUndefined()
  })

  const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

  it('refuses a .pptx from a PAT, deck- or folder-bound: decks go through the commands', async () => {
    const { pats } = await buildPatApp()
    const { token } = await pats.create('pat-user', {
      name: 'agent',
      scopes: ['api', 'mcp'],
      expiresInDays: 30,
    })
    const hook = capturedTusOptions['onUploadCreate'] as OnUploadCreate
    for (const binding of [{ deckId: 'deck-1' }, { folderId: 'folder-1' }]) {
      const req = buildRequest({
        authHeader: `Bearer ${token}`,
        uploadMetadata: tusMetadata({ ...binding, 'content-type': PPTX }),
      })
      await expect(hook(req, { size: 1024, metadata: binding })).rejects.toMatchObject({
        status_code: 403,
        body: expect.stringContaining('deck.importPptx'),
      })
    }
    expect(resolveDeckAccess).not.toHaveBeenCalled()
  })

  it('refuses anything but image, video and font from a PAT', async () => {
    const { pats } = await buildPatApp()
    const { token } = await pats.create('pat-user', {
      name: 'agent',
      scopes: ['api'],
      expiresInDays: 30,
    })
    const hook = capturedTusOptions['onUploadCreate'] as OnUploadCreate
    for (const type of ['application/pdf', 'text/html', '']) {
      const req = buildRequest({
        authHeader: `Bearer ${token}`,
        uploadMetadata: tusMetadata({ deckId: 'deck-1', 'content-type': type }),
      })
      await expect(hook(req, { size: 1024, metadata: { deckId: 'deck-1' } })).rejects.toMatchObject(
        { status_code: 415 },
      )
    }
  })

  it('refuses to continue or finish a .pptx upload with a PAT, even the user’s own', async () => {
    const { pats } = await buildPatApp()
    const { token } = await pats.create('pat-user', {
      name: 'agent',
      scopes: ['api'],
      expiresInDays: 30,
    })
    const hook = capturedTusOptions['onIncomingRequest'] as OnIncomingRequest
    mockStoredUpload = {
      id: 'asset-p:deck-1:abc',
      metadata: { deckId: 'deck-1', 'content-type': PPTX, creatorUserId: 'pat-user' },
    }
    const req = buildRequest({ method: 'PATCH', authHeader: `Bearer ${token}` })
    await expect(hook(req, 'asset-p:deck-1:abc')).rejects.toMatchObject({
      status_code: 403,
    })
  })
})

// ---------------------------------------------------------------------------
// Tests: upload session tokens (media.uploadSession, agentic A2.7a)
// ---------------------------------------------------------------------------

describe('tus upload with an upload session token', () => {
  async function buildSessionApp() {
    const { createUploadSessionService } = await import('./uploadSessions.js')
    const { createMemoryUploadSessionStore } =
      await import('../test-support/memoryUploadSessionStore.js')
    const store = createMemoryUploadSessionStore()
    const sessions = createUploadSessionService(store, { isOwnerAllowed: async () => true })
    capturedTusOptions = {}
    const app = Fastify({ logger: false })
    const db = {} as unknown as Database
    registerAuthPlugin(app, { bypass: false, db })
    registerTusPlugin(app, { db, uploadSessions: sessions })
    await app.ready()
    return { app, sessions, store }
  }

  const create = () => capturedTusOptions['onUploadCreate'] as OnUploadCreate
  const incoming = () => capturedTusOptions['onIncomingRequest'] as OnIncomingRequest

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(resolveDeckAccess).mockResolvedValue({ role: 'editor', reason: 'direct' })
    vi.mocked(roleAtLeast).mockReturnValue(true)
  })

  it('creates one media upload in its deck as its user, and is spent by it', async () => {
    const { sessions, store } = await buildSessionApp()
    const { token } = await sessions.issue({
      userSub: 'agent-user',
      owner: { deckId: 'deck-1' },
      sizeBytes: 1024,
      kind: 'image',
    })
    const req = () =>
      buildRequest({
        authHeader: `Bearer ${token}`,
        uploadMetadata: tusMetadata({ deckId: 'deck-1', 'content-type': 'image/png' }),
      })
    const result = await create()(req(), {
      id: deckUploadId('a1'),
      size: 1024,
      metadata: { deckId: 'deck-1' },
    })
    expect(result).toMatchObject({
      metadata: expect.objectContaining({ creatorUserId: 'agent-user' }),
    })
    expect(store.rows[0]!.uploadId).toBe(deckUploadId('a1'))
    // A second upload with the same token is refused: the session is spent.
    await expect(
      create()(req(), {
        id: deckUploadId('a2'),
        size: 1024,
        metadata: { deckId: 'deck-1' },
      }),
    ).rejects.toMatchObject({ status_code: 403 })
    expect(store.rows[0]!.uploadId).toBe(deckUploadId('a1'))
  })

  it('uploads into the component master it was issued for, and nowhere else', async () => {
    const { sessions, store } = await buildSessionApp()
    // The session's user is an editor of the component's folder.
    vi.mocked(resolveComponentAccess).mockResolvedValue({ role: 'editor', reason: 'folder' })
    vi.mocked(roleAtLeast).mockImplementation(realRoleAtLeast)
    const { token } = await sessions.issue({
      userSub: 'agent-user',
      owner: { componentId: 'comp-1' },
      sizeBytes: 1024,
      kind: 'image',
    })
    const attempt = (pairs: Record<string, string>) =>
      create()(
        buildRequest({ authHeader: `Bearer ${token}`, uploadMetadata: tusMetadata(pairs) }),
        { size: 1024, metadata: { ...pairs } },
      )
    await expect(attempt({ deckId: 'deck-1', 'content-type': 'image/png' })).rejects.toMatchObject({
      status_code: 403,
    })
    await expect(
      attempt({ componentId: 'comp-2', 'content-type': 'image/png' }),
    ).rejects.toMatchObject({ status_code: 403 })
    expect(store.rows[0]!.uploadId).toBeNull()
    const result = await attempt({ componentId: 'comp-1', 'content-type': 'image/png' })
    expect(result).toMatchObject({ metadata: expect.objectContaining({ componentId: 'comp-1' }) })
    expect(store.rows[0]!.uploadId).toMatch(/:unknown:/)
    // Spent: a second upload with the same token is refused.
    await expect(
      attempt({ componentId: 'comp-1', 'content-type': 'image/png' }),
    ).rejects.toMatchObject({ status_code: 403 })
  })

  it('refuses another deck, a .pptx and a non-media type, and stays usable after a refusal', async () => {
    const { sessions, store } = await buildSessionApp()
    const { token } = await sessions.issue({
      userSub: 'agent-user',
      owner: { deckId: 'deck-1' },
      sizeBytes: 1024,
      kind: 'image',
    })
    const attempt = (deckId: string, type: string) =>
      create()(
        buildRequest({
          authHeader: `Bearer ${token}`,
          uploadMetadata: tusMetadata({ deckId, 'content-type': type }),
        }),
        { id: deckUploadId('x', deckId), size: 1024, metadata: { deckId } },
      )
    await expect(attempt('deck-2', 'image/png')).rejects.toMatchObject({ status_code: 403 })
    await expect(
      attempt(
        'deck-1',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      ),
    ).rejects.toMatchObject({ status_code: 403 })
    await expect(attempt('deck-1', 'text/html')).rejects.toMatchObject({ status_code: 415 })
    expect(store.rows[0]!.uploadId).toBeNull()
    await expect(attempt('deck-1', 'image/jpeg')).resolves.toBeDefined()
  })

  it('takes only a file of the declared size and kind', async () => {
    const { sessions, store } = await buildSessionApp()
    const { token } = await sessions.issue({
      userSub: 'agent-user',
      owner: { deckId: 'deck-1' },
      sizeBytes: 1024,
      kind: 'image',
    })
    const attempt = (type: string, size: number) =>
      create()(
        buildRequest({
          authHeader: `Bearer ${token}`,
          uploadMetadata: tusMetadata({ deckId: 'deck-1', 'content-type': type }),
        }),
        { id: deckUploadId(`x${size}`), size, metadata: { deckId: 'deck-1' } },
      )
    await expect(attempt('image/png', 1025)).rejects.toMatchObject({ status_code: 403 })
    await expect(attempt('image/png', 1023)).rejects.toMatchObject({ status_code: 403 })
    await expect(attempt('video/mp4', 1024)).rejects.toMatchObject({ status_code: 403 })
    expect(store.rows[0]!.uploadId).toBeNull()
    await expect(attempt('image/png', 1024)).resolves.toBeDefined()
  })

  it('continues only the upload it created', async () => {
    const { sessions } = await buildSessionApp()
    const { token } = await sessions.issue({
      userSub: 'agent-user',
      owner: { deckId: 'deck-1' },
      sizeBytes: 1024,
      kind: 'image',
    })
    await create()(
      buildRequest({
        authHeader: `Bearer ${token}`,
        uploadMetadata: tusMetadata({ deckId: 'deck-1', 'content-type': 'image/png' }),
      }),
      { id: deckUploadId('mine'), size: 1024, metadata: { deckId: 'deck-1' } },
    )
    const stored = (id: string) => ({
      id,
      metadata: { creatorUserId: 'agent-user', deckId: 'deck-1', 'content-type': 'image/png' },
    })
    mockStoredUpload = stored(deckUploadId('mine'))
    await expect(
      incoming()(
        buildRequest({ method: 'PATCH', authHeader: `Bearer ${token}` }),
        deckUploadId('mine'),
      ),
    ).resolves.toBeUndefined()
    mockStoredUpload = stored(deckUploadId('other'))
    await expect(
      incoming()(
        buildRequest({ method: 'PATCH', authHeader: `Bearer ${token}` }),
        deckUploadId('other'),
      ),
    ).rejects.toMatchObject({ status_code: 403 })
  })

  it('refuses an unknown or malformed session token', async () => {
    await buildSessionApp()
    for (const bad of [`nus_${'A'.repeat(43)}`, 'nus_short']) {
      await expect(
        create()(
          buildRequest({
            authHeader: `Bearer ${bad}`,
            uploadMetadata: tusMetadata({ deckId: 'deck-1', 'content-type': 'image/png' }),
          }),
          { id: deckUploadId('x'), size: 1024, metadata: { deckId: 'deck-1' } },
        ),
      ).rejects.toMatchObject({ status_code: 401 })
    }
  })
})

describe("an agent's upload must prove its content type", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(resolveDeckAccess).mockResolvedValue({ role: 'editor', reason: 'direct' })
    vi.mocked(roleAtLeast).mockReturnValue(true)
  })

  async function finishWithSession(ext: string, mime: string) {
    const { createMemoryUploadSessionStore } =
      await import('../test-support/memoryUploadSessionStore.js')
    const { createUploadSessionService } = await import('./uploadSessions.js')
    const sessions = createUploadSessionService(createMemoryUploadSessionStore(), {
      isOwnerAllowed: async () => true,
    })
    capturedTusOptions = {}
    const app = Fastify({ logger: false })
    const db = {} as unknown as Database
    registerAuthPlugin(app, { bypass: false, db })
    registerTusPlugin(app, { db, uploadSessions: sessions })
    await app.ready()
    const deckId = 'deck-agent'
    const assetId = `asset-agent-${ext}`
    const uploadId = `${assetId}:${deckId}:${Buffer.from(`decks/${deckId}/uploads/${assetId}/original.${ext}`).toString('base64url')}`
    const { token } = await sessions.issue({
      userSub: 'agent-user',
      owner: { deckId },
      sizeBytes: 1024,
      kind: mime.startsWith('video/') ? 'video' : 'image',
    })
    const session = (await sessions.verify(token))!
    await sessions.claim(session, uploadId)
    const hook = capturedTusOptions['onUploadFinish'] as OnUploadFinish
    return hook(buildRequest({ authHeader: `Bearer ${token}` }), {
      id: uploadId,
      size: 1024,
      offset: 1024,
      metadata: { deckId, creatorUserId: 'agent-user', 'content-type': mime },
    })
  }

  it('accepts a real MP4 and refuses a "video" that is not one', async () => {
    await expect(finishWithSession('mp4', 'video/mp4')).resolves.toMatchObject({ status_code: 200 })
    await expect(finishWithSession('webm', 'video/webm')).rejects.toMatchObject({
      status_code: 415,
    })
  })
})

describe('tokenMayUpload', () => {
  it('allows images, videos and fonts only', () => {
    expect(tokenMayUpload('image/png')).toBe(true)
    expect(tokenMayUpload('video/mp4')).toBe(true)
    expect(tokenMayUpload('font/ttf')).toBe(true)
    expect(tokenMayUpload('application/octet-stream', 'Brand.otf')).toBe(true)
    expect(
      tokenMayUpload('application/vnd.openxmlformats-officedocument.presentationml.presentation'),
    ).toBe(false)
    expect(tokenMayUpload('application/pdf')).toBe(false)
    expect(tokenMayUpload('')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Tests: a component master's own pictures and videos (A2.12b)
// ---------------------------------------------------------------------------

describe('tus upload into a component master (metadata componentId)', () => {
  const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  const EDITOR = { role: 'editor', reason: 'folder' } as const
  const VIEWER = { role: 'viewer', reason: 'folder' } as const

  const create = () => capturedTusOptions['onUploadCreate'] as OnUploadCreate
  const incoming = () => capturedTusOptions['onIncomingRequest'] as OnIncomingRequest
  const finish = () => capturedTusOptions['onUploadFinish'] as OnUploadFinish
  const naming = () =>
    capturedTusOptions['namingFunction'] as (
      req: Request,
      metadata?: Record<string, string | null>,
    ) => string

  /** A create request declaring `pairs` (header) with the same stored metadata. */
  function createFor(
    pairs: Record<string, string>,
    size = 1024,
    authHeader?: string,
  ): Promise<Record<string, unknown>> {
    return create()(
      buildRequest({ uploadMetadata: tusMetadata(pairs), ...(authHeader ? { authHeader } : {}) }),
      { size, metadata: { ...pairs } },
    )
  }

  /** The compound id tus gives a component upload: `unknown` in the deck slot. */
  function componentUploadId(assetId: string, componentId: string, ext: string): string {
    const path = `components/${componentId}/uploads/${assetId}/original.${ext}`
    return `${assetId}:unknown:${Buffer.from(path).toString('base64url')}`
  }

  beforeEach(() => {
    vi.clearAllMocks()
    capturedTusOptions = {}
    // A deck role would let anybody in: a component upload must never ask for one.
    vi.mocked(resolveDeckAccess).mockResolvedValue({ role: 'owner', reason: 'direct' })
    // Uploading into a master needs the editor role in its folder.
    vi.mocked(roleAtLeast).mockImplementation(realRoleAtLeast)
    vi.mocked(resolveComponentAccess).mockResolvedValue(EDITOR)
  })

  it("names the object under components/<id>/uploads/ with 'unknown' in the deck slot", async () => {
    await buildApp(true)
    const id = naming()(buildRequest({}), {
      componentId: 'comp-1',
      'content-type': 'image/png',
      filename: 'logo.png',
    })
    const [assetId, deckSlot, encoded] = id.split(':') as [string, string, string]
    expect(assetId).toMatch(/^[\w-]{16}$/)
    expect(deckSlot).toBe('unknown')
    expect(Buffer.from(encoded, 'base64url').toString('utf8')).toBe(
      `components/comp-1/uploads/${assetId}/original.png`,
    )
  })

  it("accepts an editor of the component's folder and binds the upload to the component", async () => {
    await buildApp(true)
    const result = await createFor({ componentId: 'comp-1', 'content-type': 'image/png' })

    expect(resolveComponentAccess).toHaveBeenCalledWith(expect.anything(), {
      componentId: 'comp-1',
      userId: 'dev-user',
    })
    expect(resolveDeckAccess).not.toHaveBeenCalled()
    expect(result['metadata']).toMatchObject({
      componentId: 'comp-1',
      creatorUserId: 'dev-user',
      'content-type': 'image/png',
    })
    expect(result['metadata']).not.toHaveProperty('deckId')
  })

  it("names an empty deckId next to componentId as no deck: the key is the component's", async () => {
    await buildApp(true)
    const naming = capturedTusOptions['namingFunction'] as (
      req: unknown,
      metadata: Record<string, string>,
    ) => string
    const id = naming(buildRequest({}), {
      deckId: '',
      componentId: 'comp-1',
      'content-type': 'image/png',
    })
    expect(id).toMatch(/^[\w-]+:unknown:/)
    await expect(
      createFor({ deckId: '', componentId: 'comp-1', 'content-type': 'image/png' }),
    ).resolves.toBeDefined()
  })

  it('refuses an id that cannot name storage keys when naming the upload (400)', async () => {
    await buildApp(true)
    const naming = capturedTusOptions['namingFunction'] as (
      req: unknown,
      metadata: Record<string, string>,
    ) => string
    for (const metadata of [
      { componentId: 'victim/uploads', 'content-type': 'image/png' },
      { deckId: '../x', 'content-type': 'image/png' },
    ]) {
      expect(() => naming(buildRequest({}), metadata)).toThrow(
        expect.objectContaining({ status_code: 400 }),
      )
    }
  })

  it('refuses an upload whose key names another owner than the one authorised (400)', async () => {
    await buildApp(true)
    await expect(
      create()(
        buildRequest({
          uploadMetadata: tusMetadata({ componentId: 'comp-1', 'content-type': 'image/png' }),
        }),
        {
          id: deckUploadId('a1', 'deck-9'),
          size: 1024,
          metadata: { componentId: 'comp-1', 'content-type': 'image/png' },
        },
      ),
    ).rejects.toMatchObject({ status_code: 400 })
  })

  it('accepts a video from a folder editor', async () => {
    await buildApp(true)
    await expect(
      createFor({ componentId: 'comp-1', 'content-type': 'video/mp4' }, 5_000_000),
    ).resolves.toBeDefined()
  })

  it("refuses anybody outside the component's folder (403)", async () => {
    await buildApp(true)
    vi.mocked(resolveComponentAccess).mockResolvedValue(null)
    await expect(
      createFor({ componentId: 'comp-1', 'content-type': 'image/png' }),
    ).rejects.toMatchObject({ status_code: 403 })
  })

  it("refuses a viewer of the component's folder: uploading changes the master (403)", async () => {
    await buildApp(true)
    vi.mocked(resolveComponentAccess).mockResolvedValue(VIEWER)
    await expect(
      createFor({ componentId: 'comp-1', 'content-type': 'image/png' }),
    ).rejects.toMatchObject({ status_code: 403, body: expect.stringMatching(/editor/) })
  })

  it('refuses a font (it belongs to the folder) and a .pptx (it belongs to a deck) with 415', async () => {
    await buildApp(true)
    const font = createFor({ componentId: 'comp-1', 'content-type': 'font/ttf', filename: 'a.ttf' })
    await expect(font).rejects.toMatchObject({ status_code: 415 })
    await expect(font).rejects.toMatchObject({ body: expect.stringMatching(/folder/) })
    const nameOnly = createFor({
      componentId: 'comp-1',
      'content-type': 'application/octet-stream',
      filename: 'brand.otf',
    })
    await expect(nameOnly).rejects.toMatchObject({ status_code: 415 })
    await expect(createFor({ componentId: 'comp-1', 'content-type': PPTX })).rejects.toMatchObject({
      status_code: 415,
    })
    await expect(
      createFor({ componentId: 'comp-1', 'content-type': 'application/pdf' }),
    ).rejects.toMatchObject({ status_code: 415 })
    expect(resolveComponentAccess).not.toHaveBeenCalled()
  })

  it("applies the kind's size limit (413)", async () => {
    await buildApp(true)
    await expect(
      createFor({ componentId: 'comp-1', 'content-type': 'image/png' }, 900_000_000),
    ).rejects.toMatchObject({ status_code: 413 })
  })

  it('refuses an upload naming a component and a deck or folder (one owner, 400)', async () => {
    await buildApp(true)
    for (const other of [{ deckId: 'deck-1' }, { folderId: 'folder-1' }]) {
      await expect(
        createFor({ componentId: 'comp-1', ...other, 'content-type': 'image/png' }),
      ).rejects.toMatchObject({ status_code: 400 })
    }
  })

  it('refuses a component upload through a session issued for a deck', async () => {
    const { createUploadSessionService } = await import('./uploadSessions.js')
    const { createMemoryUploadSessionStore } =
      await import('../test-support/memoryUploadSessionStore.js')
    const store = createMemoryUploadSessionStore()
    const sessions = createUploadSessionService(store, { isOwnerAllowed: async () => true })
    const app = Fastify({ logger: false })
    const db = {} as unknown as Database
    registerAuthPlugin(app, { bypass: false, db })
    registerTusPlugin(app, { db, uploadSessions: sessions })
    await app.ready()
    const { token } = await sessions.issue({
      userSub: 'agent-user',
      owner: { deckId: 'deck-1' },
      sizeBytes: 1024,
      kind: 'image',
    })

    await expect(
      createFor({ componentId: 'comp-1', 'content-type': 'image/png' }, 1024, `Bearer ${token}`),
    ).rejects.toMatchObject({ status_code: 403 })
    expect(resolveComponentAccess).not.toHaveBeenCalled()
    expect(store.rows[0]!.uploadId).toBeNull()
  })

  it('a personal access token follows the same kind rules: an image in, a .pptx and a font out', async () => {
    const { createPatService } = await import('../auth/personalAccessTokens.js')
    const { createMemoryPatStore, allowAllPatOwners } =
      await import('../test-support/memoryPatStore.js')
    const pats = createPatService(createMemoryPatStore(), { isOwnerAllowed: allowAllPatOwners })
    const app = Fastify({ logger: false })
    const db = {} as unknown as Database
    registerAuthPlugin(app, { bypass: false, db, pats })
    registerTusPlugin(app, { db, uploadSessions: createAllowingUploadSessionService() })
    await app.ready()
    const { token } = await pats.create('pat-user', {
      name: 'agent',
      scopes: ['mcp'],
      expiresInDays: 30,
    })
    const bearer = `Bearer ${token}`

    await expect(
      createFor({ componentId: 'comp-1', 'content-type': 'image/png' }, 1024, bearer),
    ).resolves.toMatchObject({ metadata: expect.objectContaining({ creatorUserId: 'pat-user' }) })
    await expect(
      createFor({ componentId: 'comp-1', 'content-type': PPTX }, 1024, bearer),
    ).rejects.toMatchObject({ status_code: 403 })
    await expect(
      createFor({ componentId: 'comp-1', 'content-type': 'font/ttf' }, 1024, bearer),
    ).rejects.toMatchObject({ status_code: 415 })
  })

  it('re-checks the component on every PATCH / HEAD, never a deck', async () => {
    await buildApp(true)
    const id = componentUploadId('asset-c1', 'comp-1', 'png')
    mockStoredUpload = {
      id,
      metadata: { componentId: 'comp-1', 'content-type': 'image/png', creatorUserId: 'dev-user' },
    }
    await expect(incoming()(buildRequest({ method: 'PATCH' }), id)).resolves.toBeUndefined()

    // Demoted to viewer, then removed from the folder: refused both times.
    for (const access of [VIEWER, null]) {
      vi.mocked(resolveComponentAccess).mockResolvedValue(access)
      await expect(incoming()(buildRequest({ method: 'HEAD' }), id)).rejects.toMatchObject({
        status_code: 403,
      })
    }
    expect(resolveDeckAccess).not.toHaveBeenCalled()
  })

  it('finishes an image as a row owned by the component: componentId set, no deck, no folder', async () => {
    await buildApp(true)
    const id = componentUploadId('asset-c2', 'comp-1', 'png')
    const result = await finish()(buildRequest({}), {
      id,
      size: 1024,
      offset: 1024,
      metadata: { componentId: 'comp-1', 'content-type': 'image/png', creatorUserId: 'dev-user' },
    })

    expect(JSON.parse(result['body'] as string)).toMatchObject({ assetId: 'asset-c2' })
    const row = vi.mocked(createMediaAsset).mock.calls[0]![1]
    expect(row).toMatchObject({
      id: 'asset-c2',
      componentId: 'comp-1',
      storageKey: id,
      kind: 'image',
    })
    expect(row).not.toHaveProperty('deckId')
    expect(row).not.toHaveProperty('folderId')
  })

  it('finishes a video: pending row on the component and a transcode job without a deck', async () => {
    await buildApp(true)
    const id = componentUploadId('asset-c3', 'comp-1', 'mp4')
    await finish()(buildRequest({}), {
      id,
      size: 5_000_000,
      offset: 5_000_000,
      metadata: { componentId: 'comp-1', 'content-type': 'video/mp4', creatorUserId: 'dev-user' },
    })

    expect(createMediaAsset).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ componentId: 'comp-1', kind: 'video', transcodeStatus: 'pending' }),
    )
    const job = vi.mocked(enqueueVideoTranscode).mock.calls[0]![0]
    expect(job).toMatchObject({ assetId: 'asset-c3', storageKey: id, mimeType: 'video/mp4' })
    expect(job).not.toHaveProperty('deckId')
  })

  it('refuses to finish once they are no longer an editor of the folder, and writes no row', async () => {
    await buildApp(true)
    vi.mocked(resolveComponentAccess).mockResolvedValue(VIEWER)
    const id = componentUploadId('asset-c4', 'comp-1', 'png')
    await expect(
      finish()(buildRequest({}), {
        id,
        size: 1024,
        offset: 1024,
        metadata: { componentId: 'comp-1', 'content-type': 'image/png', creatorUserId: 'dev-user' },
      }),
    ).rejects.toMatchObject({ status_code: 403 })
    expect(createMediaAsset).not.toHaveBeenCalled()
  })
})
