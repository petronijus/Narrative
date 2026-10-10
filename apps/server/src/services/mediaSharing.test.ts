/**
 * services/mediaSharing.test.ts — MediaService.upload (the agent upload
 * path: bytes decide the type, the shared upload policy decides the limits,
 * the shared finalize step does the checks) and the asset scoping of the
 * read / delete methods, with the folder-sharing rules for a component's
 * media (removing it hands it to the folder), a folder's own media (only
 * its owner deletes it) and a folder's fonts (their own route) —
 * docs/plans/folder-sharing.md;
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
    resolveFolderAccess: vi.fn(),
    resolveFolderContentAccess: vi.fn(),
  }
})
/** The files a removal deletes (those no other media row names). */
const purgeUnreferencedKeys = vi.fn().mockResolvedValue({ deleted: 0, pages: 0, errors: 0 })
vi.mock('../media/bucketCleanup.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../media/bucketCleanup.js')>()),
  purgeUnreferencedKeys: (...a: unknown[]) => purgeUnreferencedKeys(...a),
}))
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

/** The folder of each deck and component the tests name (media/visibleMedia.ts folderOfOwner). */
const folderOf: Record<string, string | null> = { d1: 'F1', c1: 'F1', c9: 'F9', 'd-other': 'F1' }
vi.mock('../media/visibleMedia.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../media/visibleMedia.js')>()),
  folderOfOwner: async (_db: unknown, owner: { deckId?: string; componentId?: string }) =>
    folderOf[owner.deckId ?? owner.componentId ?? ''] ?? null,
}))

const { finalizeMediaUpload, UploadRejected } = await import('../media/finalizeUpload.js')
const { getMediaAsset, getFontAsset, deleteMediaAsset } = await import('../media/assets.js')
const {
  resolveDeckAccess,
  grantPermission,
  revokePermission,
  resolveFolderAccess,
  resolveFolderContentAccess,
} = await import('../auth/permissions.js')
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

/** The HTTP status the call answers with: 200 when it succeeds, else its ServiceError's. */
async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p
    return 200
  } catch (e) {
    if (e instanceof ServiceError) return e.status
    throw e
  }
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
  it("lets a deck show its folder's master picture, never a master another deck's", async () => {
    // A stamp links the master's picture (media/visibleMedia.ts): a deck of
    // the master's folder may resolve it, its access checked as the master's.
    vi.mocked(getMediaAsset).mockResolvedValue({
      id: 'a1',
      deckId: null,
      componentId: 'c1',
      storageKey: 'k',
      kind: 'image',
    } as never)
    canReadComponentMedia.mockResolvedValue(true)
    expect(
      await status(
        media().url({ userId: 'u1', assetId: 'a1', variant: 'display', owner: { deckId: 'd1' } }),
      ),
    ).toBe(200)
    expect(canReadComponentMedia).toHaveBeenCalledWith(expect.anything(), 'c1', 'u1', undefined)

    // A master of another folder: not this deck's to show.
    vi.mocked(getMediaAsset).mockResolvedValue({
      id: 'a9',
      deckId: null,
      componentId: 'c9',
      storageKey: 'k',
      kind: 'image',
    } as never)
    expect(
      await status(
        media().url({ userId: 'u1', assetId: 'a9', variant: 'display', owner: { deckId: 'd1' } }),
      ),
    ).toBe(404)

    // A deck's picture under a master: masters never show deck media.
    canReadComponentMedia.mockClear()
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

  it("deletes only the named owner's own media, never a linked master picture", async () => {
    vi.mocked(getMediaAsset).mockResolvedValue({
      id: 'a1',
      deckId: null,
      componentId: 'c1',
      storageKey: 'k',
    } as never)
    expect(
      await status(media().delete({ userId: 'u1', assetId: 'a1', owner: { deckId: 'd1' } })),
    ).toBe(404)
    expect(deleteMediaAsset).not.toHaveBeenCalled()
  })

  it("reads a folder's own picture (a deleted component's) for the folder's content readers", async () => {
    vi.mocked(getMediaAsset).mockResolvedValue({
      id: 'af',
      deckId: null,
      componentId: null,
      folderId: 'F1',
      storageKey: 'k',
      kind: 'image',
    } as never)
    vi.mocked(resolveFolderContentAccess).mockResolvedValue({ role: 'viewer', via: 'deck' })
    expect(await status(media().url({ userId: 'u1', assetId: 'af', variant: 'display' }))).toBe(200)
    expect(resolveFolderContentAccess).toHaveBeenCalledWith(expect.anything(), {
      folderId: 'F1',
      userId: 'u1',
      shareToken: null,
    })
    // …and for a deck of that folder an agent names; a deck guest may not delete it.
    expect(
      await status(
        media().url({ userId: 'u1', assetId: 'af', variant: 'display', owner: { deckId: 'd1' } }),
      ),
    ).toBe(200)
    expect(await status(media().delete({ userId: 'u1', assetId: 'af' }))).toBe(403)

    vi.mocked(resolveFolderContentAccess).mockResolvedValue(null)
    expect(await status(media().url({ userId: 'u1', assetId: 'af', variant: 'display' }))).toBe(403)
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

  it("hands a master's picture to its folder for an editor of the folder, deleting nothing", async () => {
    vi.mocked(getMediaAsset).mockResolvedValue({
      id: 'a1',
      deckId: null,
      componentId: 'c1',
      folderId: null,
      storageKey: 'k',
      kind: 'image',
    } as never)
    canReadComponentMedia.mockResolvedValue(true)

    // A viewer of the folder may read it, never remove it.
    const viewer = scriptedDb({ selects: [[{ folderId: 'F1' }]] })
    vi.mocked(resolveFolderAccess).mockResolvedValueOnce({ role: 'viewer', reason: 'direct' })
    expect(
      await status(
        createMediaService({ db: viewer.db, log: quietLog }).delete({
          userId: 'u1',
          assetId: 'a1',
        }),
      ),
    ).toBe(403)
    expect(viewer.writes).toEqual([])

    const editor = scriptedDb({ selects: [[{ folderId: 'F1' }]], updates: [[{ id: 'a1' }]] })
    vi.mocked(resolveFolderAccess).mockResolvedValueOnce({ role: 'editor', reason: 'direct' })
    await expect(
      createMediaService({ db: editor.db, log: quietLog }).delete({
        userId: 'u1',
        assetId: 'a1',
        owner: { componentId: 'c1' },
      }),
    ).resolves.toEqual({ outcome: 'handedToFolder' })
    expect(editor.writes).toEqual([
      { kind: 'update', table: 'media_assets', values: { componentId: null, folderId: 'F1' } },
    ])
    expect(resolveFolderAccess).toHaveBeenLastCalledWith(expect.anything(), {
      folderId: 'F1',
      userId: 'u1',
      alsoAs: [],
    })
    expect(deleteMediaAsset).not.toHaveBeenCalled()
    expect(purgeUnreferencedKeys).not.toHaveBeenCalled()
    expect(canReadComponentMedia).not.toHaveBeenCalled()
  })

  it("deletes a folder's own picture only for the folder's owner, files included", async () => {
    vi.mocked(getMediaAsset).mockResolvedValue({
      id: 'af',
      deckId: null,
      componentId: null,
      folderId: 'F1',
      storageKey: 'components/c-old/uploads/af/original.png',
      playbackKey: null,
      posterKey: null,
      thumbnailKey: null,
      kind: 'image',
    } as never)
    vi.mocked(resolveFolderContentAccess).mockResolvedValue({ role: 'editor', via: 'folder' })

    // Any deck of the folder may link it: an editor may not delete it.
    vi.mocked(resolveFolderAccess).mockResolvedValueOnce({ role: 'editor', reason: 'direct' })
    const refused = await serviceErrorOf(media().delete({ userId: 'u1', assetId: 'af' }))
    expect(refused.status).toBe(403)
    expect(refused.message).toMatch(/only the folder's owner/)
    expect(deleteMediaAsset).not.toHaveBeenCalled()

    vi.mocked(resolveFolderAccess).mockResolvedValueOnce({ role: 'owner', reason: 'direct' })
    await expect(media().delete({ userId: 'u1', assetId: 'af' })).resolves.toEqual({
      outcome: 'deleted',
    })
    expect(deleteMediaAsset).toHaveBeenCalledWith(expect.anything(), 'af')
    expect(purgeUnreferencedKeys).toHaveBeenCalledWith(
      expect.anything(),
      ['components/c-old/uploads/af/original.png'],
      expect.anything(),
    )
  })

  it("takes a folder target for the folder's own media, and nothing else there", async () => {
    vi.mocked(getMediaAsset).mockResolvedValue({
      id: 'af',
      deckId: null,
      componentId: null,
      folderId: 'F1',
      storageKey: 'components/c-old/uploads/af/original.png',
      playbackKey: null,
      posterKey: null,
      thumbnailKey: null,
      kind: 'image',
    } as never)
    vi.mocked(resolveFolderContentAccess).mockResolvedValue({ role: 'owner', via: 'folder' })
    vi.mocked(resolveFolderAccess).mockResolvedValue({ role: 'owner', reason: 'direct' })
    // Another folder named as the owner: not found, nothing deleted.
    const elsewhere = await serviceErrorOf(
      media().delete({ userId: 'u1', assetId: 'af', owner: { folderId: 'F2' } }),
    )
    expect(elsewhere.status).toBe(404)
    // A deck target cannot reach the folder's own media either.
    const viaDeck = await serviceErrorOf(
      media().delete({ userId: 'u1', assetId: 'af', owner: { deckId: 'd1' } }),
    )
    expect(viaDeck.status).toBe(404)
    expect(deleteMediaAsset).not.toHaveBeenCalled()

    await expect(
      media().delete({ userId: 'u1', assetId: 'af', owner: { folderId: 'F1' } }),
    ).resolves.toEqual({ outcome: 'deleted' })
    expect(deleteMediaAsset).toHaveBeenCalledWith(expect.anything(), 'af')

    // A master's picture is not the folder's own: a folder target refuses it.
    vi.mocked(deleteMediaAsset).mockClear()
    vi.mocked(getMediaAsset).mockResolvedValue({
      id: 'am',
      deckId: null,
      componentId: 'c1',
      folderId: null,
      storageKey: 'k',
      kind: 'image',
    } as never)
    const master = await serviceErrorOf(
      media().delete({ userId: 'u1', assetId: 'am', owner: { folderId: 'F1' } }),
    )
    expect(master.status).toBe(404)
    expect(deleteMediaAsset).not.toHaveBeenCalled()
  })

  it('refuses a folder font and names the font route that keeps its decks rendering', async () => {
    vi.mocked(getMediaAsset).mockResolvedValue({
      id: 'font-1',
      deckId: null,
      componentId: null,
      folderId: 'F1',
      storageKey: 'fonts/F1/font-1/original.otf',
      kind: 'font',
    } as never)
    vi.mocked(resolveFolderContentAccess).mockResolvedValue({ role: 'owner', via: 'folder' })
    vi.mocked(resolveFolderAccess).mockResolvedValue({ role: 'owner', reason: 'direct' })
    const err = await serviceErrorOf(media().delete({ userId: 'u1', assetId: 'font-1' }))
    expect(err.status).toBe(400)
    expect(err.message).toContain('DELETE /api/folders/F1/fonts/font-1')
    expect(deleteMediaAsset).not.toHaveBeenCalled()

    // Someone who cannot see the folder learns nothing about it.
    vi.mocked(resolveFolderContentAccess).mockResolvedValue(null)
    const outsider = await serviceErrorOf(media().delete({ userId: 'u2', assetId: 'font-1' }))
    expect(outsider.status).toBe(403)
    expect(outsider.message).not.toContain('F1')
  })

  it("deletes a deck's own asset for the deck's owner, with the files no other row names", async () => {
    vi.mocked(getMediaAsset).mockResolvedValue({
      id: 'v1',
      deckId: 'd1',
      componentId: null,
      folderId: null,
      storageKey: 'decks/d1/uploads/v1/original.mp4',
      playbackKey: 'decks/d1/videos/v1/playback.mp4',
      posterKey: 'decks/d1/videos/v1/poster.jpg',
      thumbnailKey: null,
      kind: 'video',
    } as never)
    vi.mocked(resolveDeckAccess).mockResolvedValue({ role: 'owner', reason: 'direct' })
    await expect(
      media().delete({ userId: 'u1', assetId: 'v1', owner: { deckId: 'd1' } }),
    ).resolves.toEqual({ outcome: 'deleted' })
    expect(deleteMediaAsset).toHaveBeenCalledWith(expect.anything(), 'v1')
    expect(purgeUnreferencedKeys).toHaveBeenCalledWith(
      expect.anything(),
      [
        'decks/d1/uploads/v1/original.mp4',
        'decks/d1/videos/v1/playback.mp4',
        'decks/d1/videos/v1/poster.jpg',
      ],
      expect.anything(),
    )
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
    vi.mocked(getMediaAsset).mockResolvedValue({
      id: 'a1',
      deckId: 'd1',
      componentId: null,
      folderId: null,
      storageKey: 'k',
      kind: 'image',
    } as never)
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
      shareToken: null,
    })
  })

  it('signs it for a share-link visitor of one of its decks, who has no session', async () => {
    // The render worker's page reads fonts the same way (its render token is a share link).
    vi.mocked(getFontAsset).mockResolvedValue(FONT as never)
    vi.mocked(resolveFolderContentAccess).mockResolvedValue({ role: 'viewer', via: 'deck' })

    const out = await fonts().fontUrl({ userId: null, shareToken: 'link-1', assetId: 'font-1' })

    expect(out).toMatchObject({ assetId: 'font-1', family: 'Brand Sans' })
    expect(resolveFolderContentAccess).toHaveBeenCalledWith(expect.anything(), {
      folderId: 'f1',
      userId: null,
      alsoAs: [],
      shareToken: 'link-1',
    })
  })

  it('refuses someone with no access to the folder or any of its decks (403)', async () => {
    vi.mocked(getFontAsset).mockResolvedValue(FONT as never)
    vi.mocked(resolveFolderContentAccess).mockResolvedValue(null)

    expect(await status(fonts().fontUrl({ userId: 'stranger', assetId: 'font-1' }))).toBe(403)
  })

  it('refuses a font of another folder than the target, before asking who may read it (404)', async () => {
    // An agent's media.fontUrl names its folder: a guest of folder f2's decks
    // gets nothing of f1's, nor learns whether the asset exists.
    vi.mocked(getFontAsset).mockResolvedValue(FONT as never)
    vi.mocked(resolveFolderContentAccess).mockResolvedValue({ role: 'viewer', via: 'deck' })

    expect(
      await status(fonts().fontUrl({ userId: 'guest', assetId: 'font-1', folderId: 'f2' })),
    ).toBe(404)
    expect(resolveFolderContentAccess).not.toHaveBeenCalled()
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
