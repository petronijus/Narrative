/**
 * services/folders.test.ts — `folder.delete` (FolderService.delete, `remove` in folders.ts) and the
 * bucket: every storage key of what the folder held is collected BEFORE the
 * cascade removes the rows, and swept after it — the contained decks'
 * `decks/<id>/` prefixes, the contained component masters'
 * `components/<id>/` prefixes (A2.12b), and the explicit keys of their media
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
let current: ScriptedDb | null = null
const deletesSoFar = (): number => current?.writes.filter((w) => w.kind === 'delete').length ?? 0

vi.mock('../media/bucketCleanup.js', () => {
  const record = (purge: string) =>
    vi.fn(async (arg: unknown) => {
      purgeCalls.push({ purge, arg, deletesBefore: deletesSoFar() })
      return { deleted: 0, failed: 0 }
    })
  return {
    purgeDeckBucketPrefix: record('deck'),
    purgeComponentBucketPrefix: record('component'),
    purgeExplicitKeys: record('explicit'),
  }
})
vi.mock('../media/s3Client.js', () => ({
  MEDIA_BUCKET: 'bucket',
  buildS3Client: () => ({ send: vi.fn() }),
  presignGetUrl: vi.fn(),
}))

const { purgeComponentBucketPrefix, purgeDeckBucketPrefix, purgeExplicitKeys } =
  await import('../media/bucketCleanup.js')
const { createFoldersService } = await import('./folders.js')

const FOLDER = { id: 'fold_1', ownerUserId: 'u1', name: 'Client work' }

function service(db: ScriptedDb) {
  current = db
  return createFoldersService({ db: db.db, log: quietLog, hocuspocus: () => null })
}

beforeEach(() => {
  purgeCalls.length = 0
  vi.mocked(purgeDeckBucketPrefix).mockClear()
  vi.mocked(purgeComponentBucketPrefix).mockClear()
  vi.mocked(purgeExplicitKeys).mockClear()
})

describe('deleting a folder', () => {
  /** A folder holding one deck and one component master with a video. */
  function folderWithDeckAndComponent(): ScriptedDb {
    return scriptedDb({
      selects: [
        // requireOwnedFolder
        [FOLDER],
        // the contained decks
        [{ id: 'deck_a' }],
        // the contained component masters
        [{ id: 'cmp_a' }],
        // the media rows of the decks, the folder and the components
        [
          // a deck picture under its own prefix
          {
            storageKey: 'decks/deck_a/img.png',
            playbackKey: null,
            posterKey: null,
            thumbnailKey: null,
          },
          // the component's video: its tus original lives outside
          // components/cmp_a/, its outputs next to it
          {
            storageKey: 'uploads/tus/3f9c0a',
            playbackKey: 'components/cmp_a/video/playback.mp4',
            posterKey: 'components/cmp_a/video/poster.jpg',
            thumbnailKey: 'components/cmp_a/video/thumb.jpg',
          },
          // a folder font
          {
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

    expect(purgeExplicitKeys).toHaveBeenCalledTimes(1)
    const [keys] = vi.mocked(purgeExplicitKeys).mock.calls[0]!
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
    expect(vi.mocked(purgeDeckBucketPrefix).mock.calls.map((c) => c[0])).toEqual(['deck_a'])
    expect(vi.mocked(purgeComponentBucketPrefix).mock.calls.map((c) => c[0])).toEqual(['cmp_a'])
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
        [],
        [{ id: 'cmp_a' }, { id: 'cmp_b' }],
        [
          {
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
    expect(vi.mocked(purgeComponentBucketPrefix).mock.calls.map((c) => c[0])).toEqual([
      'cmp_a',
      'cmp_b',
    ])
    expect(vi.mocked(purgeExplicitKeys).mock.calls[0]![0]).toEqual(['uploads/tus/aa11'])
    // No deck to delete: only the folder row goes (its components cascade).
    expect(db.writes.filter((w) => w.kind === 'delete').map((w) => w.table)).toEqual(['folders'])
  })

  it('refuses the Drafts folder and sweeps nothing', async () => {
    const db = scriptedDb({ selects: [[{ ...FOLDER, name: 'Drafts' }]] })
    const err = await serviceErrorOf(service(db).delete({ userId: 'u1', folderId: 'fold_1' }))

    expect(err.status).toBe(409)
    expect(db.writes).toEqual([])
    expect(purgeCalls).toEqual([])
  })
})
