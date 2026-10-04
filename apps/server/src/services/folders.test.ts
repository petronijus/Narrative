/**
 * services/folders.test.ts — folder membership (folder sharing,
 * docs/plans/folder-sharing.md): a new folder and a provisioned Drafts get
 * their creator's owner row with them; deleting is the owner's; a folder's
 * fonts are read by its members and its decks' guests.
 *
 * `folder.delete` (FolderService.delete, `remove` in folders.ts) and the
 * bucket: every storage key of what the folder held is collected BEFORE the
 * cascade removes the rows, and swept after it — the contained decks'
 * `decks/<id>/` prefixes, the contained component masters'
 * `components/<id>/` prefixes (A2.12b) and those of components deleted
 * earlier (their media is the folder's now), and the explicit keys of their media
 * rows, which reach outside those prefixes (tus originals under `uploads/`,
 * video playback / poster / thumbnail outputs, folder fonts).
 * The database is scripted (test-support/scriptedDb.ts); the bucket cleanup
 * is mocked, so nothing touches storage.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { quietLog } from '../test-support/agentWorld.js'
import { scriptedDb, type ScriptedDb } from '../test-support/scriptedDb.js'
import { serviceErrorOf } from '../test-support/serviceErrors.js'

/** How many database deletes had been issued when each purge ran. */
const purgeCalls: Array<{ purge: string; arg: unknown; deletesBefore: number }> = []
/** The sweeps scheduled to run again after the grace window. */
const secondSweeps: Array<() => Promise<unknown>> = []
let current: ScriptedDb | null = null
const deletesSoFar = (): number => current?.writes.filter((w) => w.kind === 'delete').length ?? 0

vi.mock('../media/bucketCleanup.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../media/bucketCleanup.js')>()
  const record = (purge: string) =>
    vi.fn(async (_db: unknown, arg: unknown) => {
      purgeCalls.push({ purge, arg, deletesBefore: deletesSoFar() })
      return { deleted: 0, failed: 0 }
    })
  return {
    componentIdsInKeys: original.componentIdsInKeys,
    purgeDeckBucketPrefix: record('deck'),
    purgeComponentBucketPrefix: record('component'),
    purgeExplicitKeys: vi.fn(async (keys: unknown) => {
      purgeCalls.push({ purge: 'explicit', arg: keys, deletesBefore: deletesSoFar() })
      return { deleted: 0, failed: 0 }
    }),
    // The keys of the deleted rows, of which those another row still names stay.
    purgeUnreferencedKeys: vi.fn(async (_db: unknown, keys: unknown) => {
      purgeCalls.push({ purge: 'explicit', arg: keys, deletesBefore: deletesSoFar() })
      return { deleted: 0, failed: 0 }
    }),
    sweepAgainAfterGrace: vi.fn((sweep: () => Promise<unknown>) => {
      secondSweeps.push(sweep)
    }),
  }
})
vi.mock('../media/s3Client.js', () => ({
  MEDIA_BUCKET: 'bucket',
  buildS3Client: () => ({ send: vi.fn() }),
  presignGetUrl: vi.fn(),
}))

const { purgeComponentBucketPrefix, purgeDeckBucketPrefix, purgeUnreferencedKeys } =
  await import('../media/bucketCleanup.js')
const { createFoldersService, getOrProvisionDrafts } = await import('./folders.js')

const FOLDER = { id: 'fold_1', ownerUserId: 'u1', name: 'Client work' }

function service(db: ScriptedDb) {
  current = db
  return createFoldersService({ db: db.db, log: quietLog, hocuspocus: () => null })
}

beforeEach(() => {
  purgeCalls.length = 0
  secondSweeps.length = 0
  vi.mocked(purgeDeckBucketPrefix).mockClear()
  vi.mocked(purgeComponentBucketPrefix).mockClear()
  vi.mocked(purgeUnreferencedKeys).mockClear()
})

describe('deleting a folder', () => {
  /** A folder holding one deck and one component master with a video. */
  function folderWithDeckAndComponent(): ScriptedDb {
    return scriptedDb({
      selects: [
        // requireFolderRole: the folder, the caller's role in it
        [FOLDER],
        [{ role: 'owner' }],
        // the contained decks
        [{ id: 'deck_a' }],
        // the contained component masters
        [{ id: 'cmp_a' }],
        // the media rows of the decks, the folder and the components
        [
          // a deck picture under its own prefix
          {
            folderId: null,
            storageKey: 'decks/deck_a/img.png',
            playbackKey: null,
            posterKey: null,
            thumbnailKey: null,
          },
          // the component's video: its tus original lives outside
          // components/cmp_a/, its outputs next to it
          {
            folderId: null,
            storageKey: 'uploads/tus/3f9c0a',
            playbackKey: 'components/cmp_a/video/playback.mp4',
            posterKey: 'components/cmp_a/video/poster.jpg',
            thumbnailKey: 'components/cmp_a/video/thumb.jpg',
          },
          // a folder font
          {
            folderId: 'fold_1',
            storageKey: 'folders/fold_1/fonts/brand.woff2',
            playbackKey: '',
            posterKey: null,
            thumbnailKey: null,
          },
        ],
      ],
    })
  }

  it('sweeps the explicit keys of every media row it held, the tus original included', async () => {
    const db = folderWithDeckAndComponent()
    await service(db).delete({ userId: 'u1', folderId: 'fold_1' })

    expect(purgeUnreferencedKeys).toHaveBeenCalledTimes(1)
    const [, keys] = vi.mocked(purgeUnreferencedKeys).mock.calls[0]!
    expect([...keys].sort()).toEqual(
      [
        'decks/deck_a/img.png',
        'uploads/tus/3f9c0a',
        'components/cmp_a/video/playback.mp4',
        'components/cmp_a/video/poster.jpg',
        'components/cmp_a/video/thumb.jpg',
        'folders/fold_1/fonts/brand.woff2',
      ].sort(),
    )
    expect(db.remaining().selects).toBe(0)
  })

  it('sweeps the prefix of each contained deck and each contained component master', async () => {
    const db = folderWithDeckAndComponent()
    const out = await service(db).delete({ userId: 'u1', folderId: 'fold_1' })

    expect(out).toEqual({ deletedDeckCount: 1 })
    expect(vi.mocked(purgeDeckBucketPrefix).mock.calls.map((c) => c[1])).toEqual(['deck_a'])
    expect(vi.mocked(purgeComponentBucketPrefix).mock.calls.map((c) => c[1])).toEqual(['cmp_a'])

    // Once more after the grace window: what a transcode or a copy was still
    // writing (media/bucketCleanup.ts) — the same prefixes, no explicit keys.
    expect(secondSweeps).toHaveLength(1)
    await secondSweeps[0]!()
    expect(vi.mocked(purgeDeckBucketPrefix).mock.calls.map((c) => c[1])).toEqual([
      'deck_a',
      'deck_a',
    ])
    expect(vi.mocked(purgeComponentBucketPrefix).mock.calls.map((c) => c[1])).toEqual([
      'cmp_a',
      'cmp_a',
    ])
  })

  it('sweeps the bucket only after the decks and the folder rows are deleted', async () => {
    const db = folderWithDeckAndComponent()
    await service(db).delete({ userId: 'u1', folderId: 'fold_1' })

    expect(db.writes.filter((w) => w.kind === 'delete').map((w) => w.table)).toEqual([
      'decks',
      'folders',
    ])
    expect(purgeCalls.map((c) => c.purge).sort()).toEqual(['component', 'deck', 'explicit'])
    for (const call of purgeCalls) expect(call.deletesBefore).toBe(2)
  })

  it('sweeps every component master of a folder that holds no deck', async () => {
    const db = scriptedDb({
      selects: [
        [FOLDER],
        [{ role: 'owner' }],
        [],
        [{ id: 'cmp_a' }, { id: 'cmp_b' }],
        [
          {
            folderId: null,
            storageKey: 'uploads/tus/aa11',
            playbackKey: null,
            posterKey: null,
            thumbnailKey: null,
          },
        ],
      ],
    })
    const out = await service(db).delete({ userId: 'u1', folderId: 'fold_1' })

    expect(out).toEqual({ deletedDeckCount: 0 })
    expect(purgeDeckBucketPrefix).not.toHaveBeenCalled()
    expect(vi.mocked(purgeComponentBucketPrefix).mock.calls.map((c) => c[1])).toEqual([
      'cmp_a',
      'cmp_b',
    ])
    expect(vi.mocked(purgeUnreferencedKeys).mock.calls[0]![1]).toEqual(['uploads/tus/aa11'])
    // No deck to delete: only the folder row goes (its components cascade).
    expect(db.writes.filter((w) => w.kind === 'delete').map((w) => w.table)).toEqual(['folders'])
  })

  it('sweeps the prefixes of components deleted earlier, named by the media the folder took over', async () => {
    const tusOriginal = `v1:unknown:${Buffer.from('components/cmp_gone/uploads/v1/original.mp4').toString('base64url')}`
    const db = scriptedDb({
      selects: [
        [FOLDER],
        [{ role: 'owner' }],
        [],
        // no live component any more
        [],
        [
          // a deleted component's picture, now the folder's
          {
            folderId: 'fold_1',
            storageKey: 'components/cmp_old/uploads/p1/original.png',
            playbackKey: null,
            posterKey: null,
            thumbnailKey: null,
          },
          // another one's video, its original a tus upload id
          {
            folderId: 'fold_1',
            storageKey: tusOriginal,
            playbackKey: 'components/cmp_gone/videos/v1/playback.mp4',
            posterKey: null,
            thumbnailKey: null,
          },
          // a folder font: no component prefix
          {
            folderId: 'fold_1',
            storageKey: 'fonts/fold_1/f1/original.otf',
            playbackKey: null,
            posterKey: null,
            thumbnailKey: null,
          },
        ],
      ],
    })
    await service(db).delete({ userId: 'u1', folderId: 'fold_1' })

    expect(
      vi
        .mocked(purgeComponentBucketPrefix)
        .mock.calls.map((c) => c[1])
        .sort(),
    ).toEqual(['cmp_gone', 'cmp_old'])
    expect([...vi.mocked(purgeUnreferencedKeys).mock.calls[0]![1]].sort()).toEqual(
      [
        'components/cmp_old/uploads/p1/original.png',
        tusOriginal,
        'components/cmp_gone/videos/v1/playback.mp4',
        'fonts/fold_1/f1/original.otf',
      ].sort(),
    )
  })

  it('refuses the Drafts folder and sweeps nothing', async () => {
    // Drafts by its flag, whatever its name.
    const db = scriptedDb({ selects: [[{ ...FOLDER, isDrafts: true }], [{ role: 'owner' }]] })
    const err = await serviceErrorOf(service(db).delete({ userId: 'u1', folderId: 'fold_1' }))

    expect(err.status).toBe(409)
    expect(db.writes).toEqual([])
    expect(purgeCalls).toEqual([])
  })

  it("refuses an editor of the folder — deleting it is the owner's — and sweeps nothing", async () => {
    const db = scriptedDb({ selects: [[FOLDER], [{ role: 'editor' }]] })
    const err = await serviceErrorOf(service(db).delete({ userId: 'u2', folderId: 'fold_1' }))

    expect(err.status).toBe(403)
    expect(err.message).toMatch(/owner/)
    expect(db.writes).toEqual([])
    expect(purgeCalls).toEqual([])
  })
})

describe('the creator is the first member', () => {
  it("creating a folder writes its row and the creator's owner row together", async () => {
    // The folder's document is seeded afterwards from its (empty) stored rows.
    const db = scriptedDb({ selects: [[]] })
    const out = await service(db).create({ userId: 'u1', name: 'Client work' })

    expect(out).toMatchObject({ name: 'Client work', deckCount: 0, role: 'owner' })
    const inserts = db.writes.filter((w) => w.kind === 'insert')
    expect(inserts.slice(0, 2)).toEqual([
      {
        kind: 'insert',
        table: 'folders',
        values: expect.objectContaining({ id: out.id, ownerUserId: 'u1' }),
      },
      {
        kind: 'insert',
        table: 'folder_permissions',
        values: { folderId: out.id, userId: 'u1', role: 'owner' },
      },
    ])
  })

  it('provisioning Drafts makes its user the owner member', async () => {
    const db = scriptedDb({ selects: [[], []] }) // no Drafts yet; its empty stored document
    const id = await getOrProvisionDrafts(
      { db: db.db, log: quietLog, hocuspocus: () => null },
      'u1',
    )

    expect(db.writes.filter((w) => w.kind === 'insert').slice(0, 2)).toEqual([
      {
        kind: 'insert',
        table: 'folders',
        values: expect.objectContaining({ id, ownerUserId: 'u1', name: 'Drafts' }),
      },
      {
        kind: 'insert',
        table: 'folder_permissions',
        values: { folderId: id, userId: 'u1', role: 'owner' },
      },
    ])
  })

  it('returns an existing Drafts without writing anything', async () => {
    const db = scriptedDb({ selects: [[{ id: 'drafts_1' }]] })
    expect(
      await getOrProvisionDrafts({ db: db.db, log: quietLog, hocuspocus: () => null }, 'u1'),
    ).toBe('drafts_1')
    expect(db.writes).toEqual([])
  })
})

describe("a folder's fonts", () => {
  it('are listed for a guest of one of its decks: the deck renders with them', async () => {
    // The folder; no folder role; a deck grant on one of its decks; its fonts (none).
    const db = scriptedDb({ selects: [[{ id: 'fold_1' }], [], [{ deckId: 'deck_a' }], []] })
    await expect(service(db).listFonts({ userId: 'guest', folderId: 'fold_1' })).resolves.toEqual(
      [],
    )
    expect(db.remaining().selects).toBe(0)
  })

  it('are refused to someone with no access to the folder or any of its decks', async () => {
    const db = scriptedDb({ selects: [[{ id: 'fold_1' }], [], [], []] })
    const err = await serviceErrorOf(
      service(db).listFonts({ userId: 'stranger', folderId: 'fold_1' }),
    )
    expect(err.status).toBe(403)
  })

  it('are deleted only by an editor: a viewer is refused before anything is read', async () => {
    const db = scriptedDb({ selects: [[FOLDER], [{ role: 'viewer' }]] })
    const err = await serviceErrorOf(
      service(db).deleteFont({ userId: 'viewer', folderId: 'fold_1', assetId: 'font_1' }),
    )
    expect(err.status).toBe(403)
    expect(err.message).toMatch(/editor role/)
    expect(db.writes).toEqual([])
  })
})
