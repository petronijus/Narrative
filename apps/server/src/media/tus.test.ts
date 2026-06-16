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

vi.mock('@tus/server', () => ({
  Server: vi.fn().mockImplementation(function (opts: Record<string, unknown>) {
    capturedTusOptions = opts
    return { handle: mockHandle }
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
  roleAtLeast: vi.fn(),
}))

import { resolveDeckAccess, roleAtLeast } from '../auth/permissions.js'
import { createMediaAsset } from './assets.js'
import { enqueueVideoTranscode } from './enqueue.js'
import { registerTusPlugin } from './tus.js'

// ---------------------------------------------------------------------------
// Types used in hook calls
// ---------------------------------------------------------------------------

// Hooks from @tus/server v2 take Node.js IncomingMessage, ServerResponse, Upload
type OnUploadCreate = (
  req: IncomingMessage,
  res: ServerResponse,
  upload: unknown,
) => Promise<Record<string, unknown>>
type OnIncomingRequest = (
  req: IncomingMessage,
  res: ServerResponse,
  uploadId: string,
) => Promise<void>
type OnUploadFinish = (
  req: IncomingMessage,
  res: ServerResponse,
  upload: unknown,
) => Promise<Record<string, unknown>>

/** Node.js mock types for hook parameters */
import type { IncomingMessage, ServerResponse } from 'node:http'

/** Builds a minimal IncomingMessage mock */
function buildRequest(opts: {
  authHeader?: string
  uploadMetadata?: string
  method?: string
}): IncomingMessage {
  const headers: Record<string, string> = {}
  if (opts.authHeader) headers['authorization'] = opts.authHeader
  if (opts.uploadMetadata) headers['upload-metadata'] = opts.uploadMetadata

  return {
    headers,
    method: opts.method ?? 'POST',
  } as unknown as IncomingMessage
}

/** Minimal ServerResponse mock */
function buildResponse(): ServerResponse {
  return {} as unknown as ServerResponse
}

/** Encodes a metadata pair as tus Upload-Metadata format (base64 value). */
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
  registerTusPlugin(app, { db: mockDb })

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
    const res = buildResponse()
    const upload = { metadata: { deckId: 'deck-1', 'content-type': 'image/jpeg' } }

    await expect(hook(req, res, upload)).rejects.toMatchObject({ status_code: 401 })
  })

  it('throws 400 when deckId is missing from Upload-Metadata', async () => {
    await buildApp(true) // bypass → dev-user
    const hook = capturedTusOptions['onUploadCreate'] as OnUploadCreate

    const req = buildRequest({
      uploadMetadata: tusMetadata({ 'content-type': 'image/png' }),
    })
    const res = buildResponse()
    const upload = { metadata: {} }

    await expect(hook(req, res, upload)).rejects.toMatchObject({ status_code: 400 })
  })

  it('throws 415 when MIME type is neither image/* nor video/*', async () => {
    await buildApp(true)
    const hook = capturedTusOptions['onUploadCreate'] as OnUploadCreate

    vi.mocked(resolveDeckAccess).mockResolvedValue({ role: 'editor', reason: 'direct' })
    vi.mocked(roleAtLeast).mockReturnValue(true)

    const req = buildRequest({
      uploadMetadata: tusMetadata({ deckId: 'deck-1', 'content-type': 'application/pdf' }),
    })
    const res = buildResponse()
    const upload = { metadata: { deckId: 'deck-1' }, size: 1000 }

    await expect(hook(req, res, upload)).rejects.toMatchObject({ status_code: 415 })
  })

  it('accepts video/mp4 MIME type for editor role', async () => {
    await buildApp(true)
    const hook = capturedTusOptions['onUploadCreate'] as OnUploadCreate

    vi.mocked(resolveDeckAccess).mockResolvedValue({ role: 'editor', reason: 'direct' })
    vi.mocked(roleAtLeast).mockReturnValue(true)

    const req = buildRequest({
      uploadMetadata: tusMetadata({ deckId: 'deck-1', 'content-type': 'video/mp4' }),
    })
    const res = buildResponse()
    const upload = { metadata: { deckId: 'deck-1' }, size: 1000 }

    await expect(hook(req, res, upload)).resolves.toBeDefined()
  })

  it('throws 413 when video size exceeds MAX_VIDEO_UPLOAD_SIZE', async () => {
    await buildApp(true)
    const hook = capturedTusOptions['onUploadCreate'] as OnUploadCreate

    vi.mocked(resolveDeckAccess).mockResolvedValue({ role: 'editor', reason: 'direct' })
    vi.mocked(roleAtLeast).mockReturnValue(true)

    const req = buildRequest({
      uploadMetadata: tusMetadata({ deckId: 'deck-1', 'content-type': 'video/mp4' }),
    })
    const res = buildResponse()
    // 501 MB — above the default 500 MB video limit
    const upload = { metadata: { deckId: 'deck-1' }, size: 501_000_000 }

    await expect(hook(req, res, upload)).rejects.toMatchObject({ status_code: 413 })
  })

  it('throws 413 when image size exceeds MAX_IMAGE_UPLOAD_SIZE', async () => {
    await buildApp(true)
    const hook = capturedTusOptions['onUploadCreate'] as OnUploadCreate

    vi.mocked(resolveDeckAccess).mockResolvedValue({ role: 'editor', reason: 'direct' })
    vi.mocked(roleAtLeast).mockReturnValue(true)

    const req = buildRequest({
      uploadMetadata: tusMetadata({ deckId: 'deck-1', 'content-type': 'image/jpeg' }),
    })
    const res = buildResponse()
    // 26 MB — above the default 25 MB image limit
    const upload = { metadata: { deckId: 'deck-1' }, size: 26_000_000 }

    await expect(hook(req, res, upload)).rejects.toMatchObject({ status_code: 413 })
  })

  it('throws 403 when user has viewer role (not editor or owner)', async () => {
    await buildApp(true)
    const hook = capturedTusOptions['onUploadCreate'] as OnUploadCreate

    vi.mocked(resolveDeckAccess).mockResolvedValue({ role: 'viewer', reason: 'share-link' })
    vi.mocked(roleAtLeast).mockReturnValue(false)

    const req = buildRequest({
      uploadMetadata: tusMetadata({ deckId: 'deck-1', 'content-type': 'image/jpeg' }),
    })
    const res = buildResponse()
    const upload = { metadata: { deckId: 'deck-1' } }

    await expect(hook(req, res, upload)).rejects.toMatchObject({ status_code: 403 })
  })

  it('resolves successfully for an editor role with valid image MIME', async () => {
    await buildApp(true)
    const hook = capturedTusOptions['onUploadCreate'] as OnUploadCreate

    vi.mocked(resolveDeckAccess).mockResolvedValue({ role: 'editor', reason: 'direct' })
    vi.mocked(roleAtLeast).mockReturnValue(true)

    const req = buildRequest({
      uploadMetadata: tusMetadata({ deckId: 'deck-1', 'content-type': 'image/png' }),
    })
    const res = buildResponse()
    const upload = { metadata: { deckId: 'deck-1' } }

    await expect(hook(req, res, upload)).resolves.toBeDefined()
  })

  it('resolves successfully for an owner role', async () => {
    await buildApp(true)
    const hook = capturedTusOptions['onUploadCreate'] as OnUploadCreate

    vi.mocked(resolveDeckAccess).mockResolvedValue({ role: 'owner', reason: 'direct' })
    vi.mocked(roleAtLeast).mockReturnValue(true)

    const req = buildRequest({
      uploadMetadata: tusMetadata({ deckId: 'deck-1', 'content-type': 'image/jpeg' }),
    })
    const res = buildResponse()
    const upload = { metadata: { deckId: 'deck-1' } }

    await expect(hook(req, res, upload)).resolves.toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Tests: onIncomingRequest hook (PATCH auth re-check)
// ---------------------------------------------------------------------------

describe('onIncomingRequest hook', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedTusOptions = {}
  })

  it('throws 401 on PATCH without auth when auth is not bypassed', async () => {
    await buildApp(false)
    const hook = capturedTusOptions['onIncomingRequest'] as OnIncomingRequest

    const req = buildRequest({ method: 'PATCH' })
    const res = buildResponse()
    await expect(hook(req, res, 'upload-id-123')).rejects.toMatchObject({ status_code: 401 })
  })

  it('does not throw on OPTIONS (no auth check)', async () => {
    await buildApp(false)
    const hook = capturedTusOptions['onIncomingRequest'] as OnIncomingRequest

    const req = buildRequest({ method: 'OPTIONS' })
    const res = buildResponse()
    await expect(hook(req, res, '')).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Tests: onUploadFinish hook
// ---------------------------------------------------------------------------

describe('onUploadFinish hook', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedTusOptions = {}
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
      metadata: { deckId, 'content-type': 'image/jpeg' },
    }

    const res = buildResponse()
    await hook(req, res, upload)

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
      metadata: { deckId },
    }

    const res = buildResponse()
    const result = (await hook(req, res, upload)) as { status_code: number; body: string }

    expect(result.status_code).toBe(200)
    const body = JSON.parse(result.body) as Record<string, unknown>
    expect(body['assetId']).toBe(assetId)
    // storageKey is the full upload.id — that's what @tus/s3-store wrote to S3.
    expect(body['storageKey']).toBe(uploadId)
  })

  it('throws 500 if upload id is malformed', async () => {
    await buildApp(true)
    const hook = capturedTusOptions['onUploadFinish'] as OnUploadFinish

    const req = buildRequest({})
    const res = buildResponse()
    const upload = { id: 'bad-id-no-colon', size: 100, offset: 100, metadata: {} }

    await expect(hook(req, res, upload)).rejects.toMatchObject({ status_code: 500 })
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
      metadata: { deckId, 'content-type': 'video/mp4' },
    }

    const res = buildResponse()
    const result = (await hook(req, res, upload)) as { status_code: number; body: string }

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
      metadata: { deckId },
    }

    const res = buildResponse()
    await hook(req, res, upload)

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
    const upload = { id: uploadId, size: 200, offset: 200, metadata: { deckId } }

    const result = (await hook(req, buildResponse(), upload)) as { status_code: number }
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
    const upload = { id: uploadId, size: 25, offset: 25, metadata: { deckId } }

    await expect(hook(req, buildResponse(), upload)).rejects.toMatchObject({ status_code: 400 })
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
