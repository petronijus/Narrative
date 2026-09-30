/**
 * services/mediaSharing.test.ts — MediaService.upload (the agent upload
 * path: bytes decide the type, the shared upload policy decides the limits,
 * the shared finalize step does the checks) and the asset scoping of the
 * read / delete methods, with the folder-sharing rules for a component's
 * media and a folder's fonts (docs/plans/folder-sharing.md);
 * SharingService.setRole and revoke.
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
  return {
    ...original,
    resolveDeckAccess: vi.fn(),
    grantPermission: vi.fn(),
    revokePermission: vi.fn(),
    resolveFolderContentAccess: vi.fn(),
  }
})
vi.mock('../auth/users.js', () => ({
  getUserBySub: vi.fn(),
  getUserByEmail: vi.fn(),
  listUsersBySubs: vi.fn(),
}))
vi.mock('../hocuspocus/connections.js', () => ({
  closeDeckConnections: vi.fn(),
  closeUserConnectionsOnDocument: vi.fn(),
}))
/** Whether the caller may upload or delete a component's media (an editor of its folder). */
const canWriteComponentMedia = vi.fn()
/** Whether the caller may see it (whoever reads the folder's content, share links included). */
const canReadComponentMedia = vi.fn()
vi.mock('../media/mediaOwner.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../media/mediaOwner.js')>()
  return {
    ...original,
    canWriteComponentMedia: (...a: unknown[]) => canWriteComponentMedia(...a),
    canReadComponentMedia: (...a: unknown[]) => canReadComponentMedia(...a),
  }
})

const { finalizeMediaUpload, UploadRejected } = await import('../media/finalizeUpload.js')
const { getMediaAsset, getFontAsset, deleteMediaAsset } = await import('../media/assets.js')
const { resolveDeckAccess, grantPermission, revokePermission, resolveFolderContentAccess } =
  await import('../auth/permissions.js')
const { getUserBySub } = await import('../auth/users.js')
const { closeDeckConnections, closeUserConnectionsOnDocument } =
  await import('../hocuspocus/connections.js')
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
      owner: { deckId: 'd1' },
      source: { kind: 'base64', data: PNG.toString('base64'), mimeType: 'image/jpeg' },
    })
    const args = finalizeMock.mock.calls[0]![0]
    expect(args.mimeType).toBe('image/png')
    expect(args.owner).toEqual({ deckId: 'd1' })
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
      owner: { deckId: 'd1' },
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
        media().upload({
          userId: 'u1',
          owner: { deckId: 'd1' },
          source: { kind: 'base64', data: text },
        }),
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
          owner: { deckId: 'd1' },
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
        owner: { deckId: 'd1' },
        source: { kind: 'base64', data: PNG.toString('base64') },
      }),
    )
    expect(err.status).toBe(400)
    expect(err.code).toBe('invalid_input')
  })
})

describe('MediaService.upload into a component master', () => {
  it('stores the picture under the component, which owns it', async () => {
    canWriteComponentMedia.mockResolvedValue(true)
    await media().upload({
      userId: 'u1',
      owner: { componentId: 'c1' },
      source: { kind: 'base64', data: PNG.toString('base64') },
    })
    const args = finalizeMock.mock.calls[0]![0]
    expect(args.owner).toEqual({ componentId: 'c1' })
    expect(args.storageKey).toMatch(/^components\/c1\/uploads\/[\w-]{16}\/original\.png$/)
  })

  it('answers 404 for a master the caller may not change (a folder viewer, an outsider), before reading the file', async () => {
    canWriteComponentMedia.mockResolvedValue(false)
    expect(
      await status(
        media().upload({
          userId: 'u1',
          owner: { componentId: 'c1' },
          source: { kind: 'base64', data: PNG.toString('base64') },
        }),
      ),
    ).toBe(404)
    expect(canWriteComponentMedia).toHaveBeenCalledWith(expect.anything(), 'c1', 'u1')
    expect(send).not.toHaveBeenCalled()
  })

  it("refuses a font (415) without storing it: the folder's fonts cover a master", async () => {
    canWriteComponentMedia.mockResolvedValue(true)
    const otf = Buffer.concat([Buffer.from('OTTO'), Buffer.alloc(8)])
    expect(
      await status(
        media().upload({
          userId: 'u1',
          owner: { componentId: 'c1' },
          source: { kind: 'base64', data: otf.toString('base64') },
        }),
      ),
    ).toBe(415)
    expect(send).not.toHaveBeenCalled()
  })
})

describe('MediaService scoping', () => {
  it('keeps deck and component media apart: each answers 404 under the other owner', async () => {
    vi.mocked(getMediaAsset).mockResolvedValue({
      id: 'a1',
      deckId: null,
      componentId: 'c1',
      storageKey: 'k',
    } as never)
    expect(
      await status(
        media().url({ userId: 'u1', assetId: 'a1', variant: 'display', owner: { deckId: 'd1' } }),
      ),
    ).toBe(404)
    vi.mocked(getMediaAsset).mockResolvedValue({
      id: 'a2',
      deckId: 'd1',
      componentId: null,
      storageKey: 'k',
    } as never)
    expect(
      await status(
        media().url({
          userId: 'u1',
          assetId: 'a2',
          variant: 'display',
          owner: { componentId: 'c1' },
        }),
      ),
    ).toBe(404)
    expect(canReadComponentMedia).not.toHaveBeenCalled()
    expect(resolveDeckAccess).not.toHaveBeenCalled()
  })

  it("lets whoever reads the component's folder see its media, a share link passed along", async () => {
    vi.mocked(getMediaAsset).mockResolvedValue({
      id: 'a1',
      deckId: null,
      componentId: 'c1',
      storageKey: 'k',
    } as never)
    canReadComponentMedia.mockResolvedValue(true)
    await expect(
      media().url({ userId: null, shareToken: 'tok-1', assetId: 'a1', variant: 'display' }),
    ).resolves.toEqual({ url: 'https://img.test/signed' })
    expect(canReadComponentMedia).toHaveBeenCalledWith(expect.anything(), 'c1', null, 'tok-1')

    canReadComponentMedia.mockResolvedValue(false)
    expect(await status(media().url({ userId: 'u1', assetId: 'a1', variant: 'display' }))).toBe(403)
    expect(resolveDeckAccess).not.toHaveBeenCalled()
  })

  it("deletes a component's media only for an editor of its folder, never on the read rule", async () => {
    vi.mocked(getMediaAsset).mockResolvedValue({
      id: 'a1',
      deckId: null,
      componentId: 'c1',
      storageKey: 'k',
    } as never)
    canReadComponentMedia.mockResolvedValue(true)
    canWriteComponentMedia.mockResolvedValue(false)
    expect(await status(media().delete({ userId: 'u1', assetId: 'a1' }))).toBe(403)
    expect(deleteMediaAsset).not.toHaveBeenCalled()

    canWriteComponentMedia.mockResolvedValue(true)
    await media().delete({ userId: 'u1', assetId: 'a1' })
    expect(canWriteComponentMedia).toHaveBeenLastCalledWith(expect.anything(), 'c1', 'u1')
    expect(deleteMediaAsset).toHaveBeenCalledWith(expect.anything(), 'a1')
    expect(canReadComponentMedia).not.toHaveBeenCalled()
  })

  it("answers 404 for another deck's asset, before any access check", async () => {
    vi.mocked(getMediaAsset).mockResolvedValue({
      id: 'a1',
      deckId: 'd-other',
      storageKey: 'k',
    } as never)
    expect(
      await status(
        media().url({ userId: 'u1', assetId: 'a1', variant: 'display', owner: { deckId: 'd1' } }),
      ),
    ).toBe(404)
    expect(
      await status(media().delete({ userId: 'u1', assetId: 'a1', owner: { deckId: 'd1' } })),
    ).toBe(404)
    expect(resolveDeckAccess).not.toHaveBeenCalled()
    expect(deleteMediaAsset).not.toHaveBeenCalled()
  })

  it('needs the owner role to delete', async () => {
    vi.mocked(getMediaAsset).mockResolvedValue({ id: 'a1', deckId: 'd1', storageKey: 'k' } as never)
    vi.mocked(resolveDeckAccess).mockResolvedValue({ role: 'editor', reason: 'direct' })
    expect(
      await status(media().delete({ userId: 'u1', assetId: 'a1', owner: { deckId: 'd1' } })),
    ).toBe(403)
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

describe('MediaService.fontUrl', () => {
  const FONT = {
    id: 'font-1',
    folderId: 'f1',
    storageKey: 'fonts/f1/font-1/original.otf',
    fontFamily: 'Brand Sans',
    fontWeight: 400,
    fontStyle: 'normal',
    fontPostscriptName: 'BrandSans-Regular',
    mimeType: 'font/otf',
  }
  // requireFolderContentReader: the folder row, then the content access.
  const fonts = () =>
    createMediaService({ db: scriptedDb({ selects: [[{ id: 'f1' }]] }).db, log: quietLog })

  it("signs a folder font for a guest of one of the folder's decks: the deck renders with it", async () => {
    vi.mocked(getFontAsset).mockResolvedValue(FONT as never)
    vi.mocked(resolveFolderContentAccess).mockResolvedValue({ role: 'viewer', via: 'deck' })

    const out = await fonts().fontUrl({ userId: 'guest', assetId: 'font-1' })

    expect(out).toMatchObject({
      assetId: 'font-1',
      url: 'https://storage.test/signed',
      family: 'Brand Sans',
    })
    expect(resolveFolderContentAccess).toHaveBeenCalledWith(expect.anything(), {
      folderId: 'f1',
      userId: 'guest',
      alsoAs: [],
    })
  })

  it('refuses someone with no access to the folder or any of its decks (403)', async () => {
    vi.mocked(getFontAsset).mockResolvedValue(FONT as never)
    vi.mocked(resolveFolderContentAccess).mockResolvedValue(null)

    expect(await status(fonts().fontUrl({ userId: 'stranger', assetId: 'font-1' }))).toBe(403)
  })
})

describe('SharingService.revoke', () => {
  // The deck's owners, then (after the revoke) the deck's folder.
  const sharing = () =>
    createSharingService({
      db: scriptedDb({
        selects: [[{ userId: 'u1' }], [{ folderId: 'f1' }]],
      }).db,
      log: quietLog,
    })

  it("closes the revoked user's folder document too when that deck was their way into the folder", async () => {
    vi.mocked(resolveFolderContentAccess).mockResolvedValue(null)

    await sharing().revoke({ deckId: 'd1', callerUserId: 'u1', userId: 'jana' })

    expect(revokePermission).toHaveBeenCalledWith(expect.anything(), {
      deckId: 'd1',
      userId: 'jana',
    })
    expect(closeDeckConnections).toHaveBeenCalledWith('d1', { userId: 'jana' })
    expect(resolveFolderContentAccess).toHaveBeenCalledWith(expect.anything(), {
      folderId: 'f1',
      userId: 'jana',
    })
    expect(closeUserConnectionsOnDocument).toHaveBeenCalledWith('folder:f1', 'jana')
  })

  it('leaves their folder document open while they still reach the folder another way', async () => {
    vi.mocked(resolveFolderContentAccess).mockResolvedValue({ role: 'viewer', via: 'deck' })

    await sharing().revoke({ deckId: 'd1', callerUserId: 'u1', userId: 'jana' })

    expect(closeDeckConnections).toHaveBeenCalledWith('d1', { userId: 'jana' })
    expect(closeUserConnectionsOnDocument).not.toHaveBeenCalled()
  })
})

describe('media.openUploadSession', () => {
  async function service() {
    const { createUploadSessionService } = await import('../media/uploadSessions.js')
    const { createMemoryUploadSessionStore } =
      await import('../test-support/memoryUploadSessionStore.js')
    const store = createMemoryUploadSessionStore()
    const svc = createMediaService({
      db: scriptedDb().db,
      log: quietLog,
      apiBaseUrl: 'https://narrative.test/api/',
      uploadSessions: createUploadSessionService(store, { isOwnerAllowed: async () => true }),
    })
    return { svc, store }
  }

  it('opens a session for an editor: tus URL, token, metadata naming deck, file and type', async () => {
    vi.mocked(resolveDeckAccess).mockResolvedValue({ role: 'editor', reason: 'direct' })
    const { svc, store } = await service()
    const out = await svc.openUploadSession({
      userId: 'u1',
      owner: { deckId: 'd1' },
      filename: 'logo.PNG',
      sizeBytes: 32,
    })
    expect(out).toMatchObject({
      url: 'https://narrative.test/api/api/uploads',
      kind: 'image',
      mimeType: 'image/png',
    })
    expect(out.token).toMatch(/^nus_/)
    const meta = Object.fromEntries(
      out.uploadMetadata.split(',').map((pair) => {
        const [k, v] = pair.split(' ') as [string, string]
        return [k, Buffer.from(v, 'base64').toString('utf8')]
      }),
    )
    expect(meta).toEqual({ deckId: 'd1', filename: 'logo.PNG', 'content-type': 'image/png' })
    expect(store.rows).toHaveLength(1)
    expect(store.rows[0]).toMatchObject({
      userSub: 'u1',
      deckId: 'd1',
      uploadId: null,
      sizeBytes: 32,
      kind: 'image',
    })
  })

  it('refuses a viewer, an unknown deck, and a file that is not media', async () => {
    const { svc, store } = await service()
    vi.mocked(resolveDeckAccess).mockResolvedValue({ role: 'viewer', reason: 'direct' })
    expect(
      await status(
        svc.openUploadSession({
          userId: 'u1',
          owner: { deckId: 'd1' },
          filename: 'a.png',
          sizeBytes: 10,
        }),
      ),
    ).toBe(403)
    vi.mocked(resolveDeckAccess).mockResolvedValue(null)
    expect(
      await status(
        svc.openUploadSession({
          userId: 'u1',
          owner: { deckId: 'd1' },
          filename: 'a.png',
          sizeBytes: 10,
        }),
      ),
    ).toBe(404)
    vi.mocked(resolveDeckAccess).mockResolvedValue({ role: 'owner', reason: 'direct' })
    expect(
      await status(
        svc.openUploadSession({
          userId: 'u1',
          owner: { deckId: 'd1' },
          filename: 'notes.txt',
          sizeBytes: 10,
        }),
      ),
    ).toBe(415)
    expect(
      await status(
        svc.openUploadSession({
          userId: 'u1',
          owner: { deckId: 'd1' },
          filename: 'x',
          mimeType: 'text/html',
          sizeBytes: 10,
        }),
      ),
    ).toBe(415)
    // Larger than its kind may be (the test config caps images at 64 bytes).
    expect(
      await status(
        svc.openUploadSession({
          userId: 'u1',
          owner: { deckId: 'd1' },
          filename: 'a.png',
          sizeBytes: 65,
        }),
      ),
    ).toBe(413)
    expect(store.rows).toHaveLength(0)
    // An extensionless name is fine with its type given.
    await expect(
      svc.openUploadSession({
        userId: 'u1',
        owner: { deckId: 'd1' },
        filename: 'clip',
        mimeType: 'video/mp4',
        sizeBytes: 10,
      }),
    ).resolves.toMatchObject({ kind: 'video' })
  })

  it("opens one for an editor of a component master's folder: pictures and videos, no fonts", async () => {
    const { svc, store } = await service()
    canWriteComponentMedia.mockResolvedValue(true)
    const out = await svc.openUploadSession({
      userId: 'u1',
      owner: { componentId: 'c1' },
      filename: 'badge.png',
      sizeBytes: 32,
    })
    expect(out.uploadMetadata.split(',')[0]).toBe(
      `componentId ${Buffer.from('c1').toString('base64')}`,
    )
    expect(store.rows[0]).toMatchObject({ deckId: null, componentId: 'c1' })
    expect(
      await status(
        svc.openUploadSession({
          userId: 'u1',
          owner: { componentId: 'c1' },
          filename: 'brand.otf',
          sizeBytes: 10,
        }),
      ),
    ).toBe(415)
    // A folder viewer (or an outsider) may not add to the master.
    canWriteComponentMedia.mockResolvedValue(false)
    expect(
      await status(
        svc.openUploadSession({
          userId: 'u1',
          owner: { componentId: 'c1' },
          filename: 'badge.png',
          sizeBytes: 32,
        }),
      ),
    ).toBe(404)
    expect(store.rows).toHaveLength(1)
    expect(resolveDeckAccess).not.toHaveBeenCalled()
  })
})
