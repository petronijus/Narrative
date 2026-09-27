/**
 * services/mediaSharing.test.ts — MediaService.upload (the agent upload
 * path: bytes decide the type, the shared upload policy decides the limits,
 * the shared finalize step does the checks) and the asset scoping of the
 * read / delete methods; SharingService.setRole.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// Small limits so the size checks can be exercised (read when uploadPolicy loads).
process.env['MAX_UPLOAD_SIZE'] = '64'

const send = vi.fn().mockResolvedValue({})
vi.mock('../media/s3Client.js', () => ({
  MEDIA_BUCKET: 'bucket',
  buildS3Client: () => ({ send }),
  presignGetUrl: vi.fn().mockResolvedValue('https://storage.test/signed'),
}))
vi.mock('../media/finalizeUpload.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../media/finalizeUpload.js')>()
  return { ...original, finalizeMediaUpload: vi.fn() }
})
vi.mock('../media/assets.js', () => ({
  getMediaAsset: vi.fn(),
  getVideoAsset: vi.fn(),
  getFontAsset: vi.fn(),
  deleteMediaAsset: vi.fn(),
}))
vi.mock('../media/imgproxyUrl.js', () => ({
  signImgproxyUrl: vi.fn().mockReturnValue('https://img.test/signed'),
}))
vi.mock('../auth/permissions.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../auth/permissions.js')>()
  return { ...original, resolveDeckAccess: vi.fn(), grantPermission: vi.fn() }
})
vi.mock('../auth/users.js', () => ({
  getUserBySub: vi.fn(),
  getUserByEmail: vi.fn(),
  listUsersBySubs: vi.fn(),
}))
vi.mock('../hocuspocus/connections.js', () => ({ closeDeckConnections: vi.fn() }))

const { finalizeMediaUpload, UploadRejected } = await import('../media/finalizeUpload.js')
const { getMediaAsset, deleteMediaAsset } = await import('../media/assets.js')
const { resolveDeckAccess, grantPermission } = await import('../auth/permissions.js')
const { getUserBySub } = await import('../auth/users.js')
const { closeDeckConnections } = await import('../hocuspocus/connections.js')
const { createMediaService } = await import('./media.js')
const { createSharingService } = await import('./sharing.js')
const { ServiceError } = await import('./errors.js')
const { scriptedDb } = await import('../test-support/scriptedDb.js')
const { serviceErrorOf } = await import('../test-support/serviceErrors.js')
const { quietLog } = await import('../test-support/agentWorld.js')

const finalizeMock = vi.mocked(finalizeMediaUpload)
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

function media() {
  return createMediaService({ db: scriptedDb().db, log: quietLog })
}

async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p
  } catch (e) {
    if (e instanceof ServiceError) return e.status
    throw e
  }
  throw new Error('expected a ServiceError')
}

beforeEach(() => {
  vi.clearAllMocks()
  finalizeMock.mockImplementation(async (args) => ({
    kind: 'image',
    assetId: args.assetId,
    storageKey: args.storageKey,
    mimeType: args.mimeType,
    sizeBytes: args.sizeBytes,
    width: 1,
    height: 1,
  }))
})

describe('MediaService.upload', () => {
  it('stores the bytes under the deck and finalizes them as what they are, not what was claimed', async () => {
    const out = await media().upload({
      userId: 'u1',
      deckId: 'd1',
      source: { kind: 'base64', data: PNG.toString('base64'), mimeType: 'image/jpeg' },
    })
    const args = finalizeMock.mock.calls[0]![0]
    expect(args.mimeType).toBe('image/png')
    expect(args.deckId).toBe('d1')
    expect(args.storageKey).toMatch(/^decks\/d1\/uploads\/[\w-]{16}\/original\.png$/)
    const put = send.mock.calls[0]![0] as { input: { Key: string; ContentType: string } }
    expect(put.input).toMatchObject({ Key: args.storageKey, ContentType: 'image/png' })
    expect(out).toMatchObject({ kind: 'image', mimeType: 'image/png', width: 1, height: 1 })
  })

  it('files fonts under fonts/ and returns what the file says about itself', async () => {
    finalizeMock.mockImplementationOnce(async (args) => ({
      kind: 'font',
      assetId: args.assetId,
      storageKey: args.storageKey,
      mimeType: args.mimeType,
      sizeBytes: args.sizeBytes,
      fontFamily: 'Brand Sans',
      fontWeight: 700,
      fontStyle: 'normal',
      fontPostscriptName: 'BrandSans-Bold',
    }))
    const otf = Buffer.concat([Buffer.from('OTTO'), Buffer.alloc(8)])
    const out = await media().upload({
      userId: 'u1',
      deckId: 'd1',
      source: { kind: 'base64', data: otf.toString('base64') },
    })
    expect(finalizeMock.mock.calls[0]![0].storageKey).toMatch(/^decks\/d1\/fonts\//)
    expect(out.font).toEqual({
      family: 'Brand Sans',
      weight: 700,
      style: 'normal',
      postscriptName: 'BrandSans-Bold',
    })
  })

  it('refuses a file that is no accepted media type (415) without storing it', async () => {
    const text = Buffer.from('just some text').toString('base64')
    expect(
      await status(
        media().upload({ userId: 'u1', deckId: 'd1', source: { kind: 'base64', data: text } }),
      ),
    ).toBe(415)
    expect(send).not.toHaveBeenCalled()
  })

  it('applies the per-kind size limit of the upload policy (413)', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(100)])
    expect(
      await status(
        media().upload({
          userId: 'u1',
          deckId: 'd1',
          source: { kind: 'bytes', bytes: big, mimeType: 'image/png' },
        }),
      ),
    ).toBe(413)
    expect(send).not.toHaveBeenCalled()
  })

  it('passes a rejection of the finalize step through with its status', async () => {
    finalizeMock.mockRejectedValueOnce(
      new UploadRejected(400, 'SVG rejected: no valid graphic content'),
    )
    const err = await serviceErrorOf(
      media().upload({
        userId: 'u1',
        deckId: 'd1',
        source: { kind: 'base64', data: PNG.toString('base64') },
      }),
    )
    expect(err.status).toBe(400)
    expect(err.code).toBe('invalid_input')
  })
})

describe('MediaService scoping', () => {
  it("answers 404 for another deck's asset, before any access check", async () => {
    vi.mocked(getMediaAsset).mockResolvedValue({
      id: 'a1',
      deckId: 'd-other',
      storageKey: 'k',
    } as never)
    expect(
      await status(media().url({ userId: 'u1', assetId: 'a1', variant: 'display', deckId: 'd1' })),
    ).toBe(404)
    expect(await status(media().delete({ userId: 'u1', assetId: 'a1', deckId: 'd1' }))).toBe(404)
    expect(resolveDeckAccess).not.toHaveBeenCalled()
    expect(deleteMediaAsset).not.toHaveBeenCalled()
  })

  it('needs the owner role to delete', async () => {
    vi.mocked(getMediaAsset).mockResolvedValue({ id: 'a1', deckId: 'd1', storageKey: 'k' } as never)
    vi.mocked(resolveDeckAccess).mockResolvedValue({ role: 'editor', reason: 'direct' })
    expect(await status(media().delete({ userId: 'u1', assetId: 'a1', deckId: 'd1' }))).toBe(403)
    expect(deleteMediaAsset).not.toHaveBeenCalled()
  })
})

describe('SharingService.setRole', () => {
  function sharing(selects: unknown[][] = []) {
    return createSharingService({ db: scriptedDb({ selects }).db, log: quietLog })
  }

  it('changes the role of an existing collaborator and reconnects them', async () => {
    vi.mocked(getUserBySub).mockResolvedValue({
      sub: 'jana',
      email: 'jana@example.com',
      name: 'Jana',
    } as never)
    const out = await sharing([[{ role: 'editor' }]]).setRole({
      deckId: 'd1',
      callerUserId: 'u1',
      userId: 'jana',
      role: 'viewer',
    })
    expect(out).toEqual({ userId: 'jana', email: 'jana@example.com', name: 'Jana', role: 'viewer' })
    expect(grantPermission).toHaveBeenCalledWith(expect.anything(), {
      deckId: 'd1',
      userId: 'jana',
      role: 'viewer',
      grantedBy: 'u1',
    })
    expect(closeDeckConnections).toHaveBeenCalledWith('d1', { userId: 'jana' })
  })

  it('refuses your own role (409) and a non-collaborator (404)', async () => {
    expect(
      await status(
        sharing().setRole({ deckId: 'd1', callerUserId: 'u1', userId: 'u1', role: 'viewer' }),
      ),
    ).toBe(409)
    expect(
      await status(
        sharing([[]]).setRole({ deckId: 'd1', callerUserId: 'u1', userId: 'x', role: 'viewer' }),
      ),
    ).toBe(404)
    expect(grantPermission).not.toHaveBeenCalled()
  })
})
