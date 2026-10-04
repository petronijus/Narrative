/**
 * media/bucketCleanup.test.ts
 *
 * Unit tests for the `decks/<deckId>/` prefix purge helper, and for what a
 * sweep keeps although no row names it yet (the transcode race, the grace
 * window).
 *
 * The S3 client is mocked at the `./s3Client.js` module boundary so we
 * can assert exactly which AWS SDK commands the helper issues, without
 * needing a live MinIO. ListObjectsV2 + DeleteObjects are the two
 * commands under test; we drive multi-page pagination, per-object
 * Errors arrays, and list-failure short-circuit paths.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3'
import type { Database } from '../db/client.js'

const sendMock = vi.fn()

vi.mock('./s3Client.js', () => ({
  buildS3Client: () => ({ send: sendMock }),
  MEDIA_BUCKET: 'test-bucket',
}))

const {
  DEFAULT_SWEEP_GRACE_MS,
  componentIdsInKeys,
  purgeComponentBucketPrefix,
  purgeDeckBucketPrefix,
  sweepGraceMs,
} = await import('./bucketCleanup.js')

/**
 * A database in which media rows name `named` as their stored files
 * (keysStillReferenced), or whose lookup fails.
 */
function rowsNaming(named: string[], opts: { fail?: boolean } = {}): Database {
  const chain = {
    from: () => chain,
    where: async () => {
      if (opts.fail === true) throw new Error('database down')
      return named.map((storageKey) => ({
        storageKey,
        playbackKey: null,
        posterKey: null,
        thumbnailKey: null,
      }))
    },
  }
  return { select: () => chain } as unknown as Database
}

const noRows = rowsNaming([])

/** Written well before the grace window: what a sweep may take. */
const OLD = new Date(Date.now() - 2 * DEFAULT_SWEEP_GRACE_MS)

/**
 * A database for the transcode race: media rows `ids` exist (the video
 * worker writes `videos/<id>/…` before the row names those keys), and none
 * names any listed key yet.
 */
function rowsExisting(ids: string[]): Database {
  const select = (fields: Record<string, unknown>) => {
    const chain = {
      from: () => chain,
      where: async () => ('id' in fields ? ids.map((id) => ({ id })) : []),
    }
    return chain
  }
  return { select } as unknown as Database
}

function makeLog() {
  return {
    warn: vi.fn(),
    info: vi.fn(),
  }
}

beforeEach(() => {
  sendMock.mockReset()
})

describe('purgeDeckBucketPrefix', () => {
  it('lists with prefix decks/<id>/ and batch-deletes all returned keys', async () => {
    sendMock
      .mockResolvedValueOnce({
        Contents: [
          { Key: 'decks/abc/thumb.jpg', LastModified: OLD },
          { Key: 'decks/abc/uploads/x/original.png', LastModified: OLD },
          { Key: 'decks/abc/videos/y/playback.mp4', LastModified: OLD },
          { Key: 'decks/abc/videos/y/poster.jpg', LastModified: OLD },
        ],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({ Errors: [] })

    const log = makeLog()
    const result = await purgeDeckBucketPrefix(noRows, 'abc', log)

    expect(result).toEqual({ deleted: 4, pages: 1, errors: 0 })
    expect(sendMock).toHaveBeenCalledTimes(2)

    const listCall = sendMock.mock.calls[0]![0] as InstanceType<typeof ListObjectsV2Command>
    expect(listCall).toBeInstanceOf(ListObjectsV2Command)
    expect(listCall.input).toEqual({
      Bucket: 'test-bucket',
      Prefix: 'decks/abc/',
      ContinuationToken: undefined,
    })

    const deleteCall = sendMock.mock.calls[1]![0] as InstanceType<typeof DeleteObjectsCommand>
    expect(deleteCall).toBeInstanceOf(DeleteObjectsCommand)
    expect(deleteCall.input.Bucket).toBe('test-bucket')
    expect(deleteCall.input.Delete?.Objects).toEqual([
      { Key: 'decks/abc/thumb.jpg' },
      { Key: 'decks/abc/uploads/x/original.png' },
      { Key: 'decks/abc/videos/y/playback.mp4' },
      { Key: 'decks/abc/videos/y/poster.jpg' },
    ])
    expect(deleteCall.input.Delete?.Quiet).toBe(true)

    expect(log.warn).not.toHaveBeenCalled()
  })

  it('paginates with ContinuationToken when IsTruncated', async () => {
    sendMock
      .mockResolvedValueOnce({
        Contents: [{ Key: 'decks/big/a', LastModified: OLD }],
        IsTruncated: true,
        NextContinuationToken: 'token-2',
      })
      .mockResolvedValueOnce({}) // first DeleteObjects
      .mockResolvedValueOnce({
        Contents: [{ Key: 'decks/big/b', LastModified: OLD }],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({}) // second DeleteObjects

    const log = makeLog()
    const result = await purgeDeckBucketPrefix(noRows, 'big', log)

    expect(result).toEqual({ deleted: 2, pages: 2, errors: 0 })

    const firstList = sendMock.mock.calls[0]![0] as InstanceType<typeof ListObjectsV2Command>
    expect(firstList.input.ContinuationToken).toBeUndefined()

    const secondList = sendMock.mock.calls[2]![0] as InstanceType<typeof ListObjectsV2Command>
    expect(secondList.input.ContinuationToken).toBe('token-2')
  })

  it('skips DeleteObjects when a page has no Contents', async () => {
    sendMock.mockResolvedValueOnce({ Contents: [], IsTruncated: false })

    const log = makeLog()
    const result = await purgeDeckBucketPrefix(noRows, 'empty', log)

    expect(result).toEqual({ deleted: 0, pages: 1, errors: 0 })
    expect(sendMock).toHaveBeenCalledTimes(1)
  })

  it('records per-object Errors but does not throw', async () => {
    sendMock
      .mockResolvedValueOnce({
        Contents: [
          { Key: 'decks/p/a', LastModified: OLD },
          { Key: 'decks/p/b', LastModified: OLD },
        ],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({
        Errors: [{ Key: 'decks/p/b', Code: 'AccessDenied', Message: 'nope' }],
      })

    const log = makeLog()
    const result = await purgeDeckBucketPrefix(noRows, 'p', log)

    expect(result.deleted).toBe(2)
    expect(result.errors).toBe(1)
    expect(log.warn).toHaveBeenCalledOnce()
  })

  it('aborts on list failure but does not throw', async () => {
    sendMock.mockRejectedValueOnce(new Error('S3 unavailable'))

    const log = makeLog()
    const result = await purgeDeckBucketPrefix(noRows, 'boom', log)

    expect(result).toEqual({ deleted: 0, pages: 0, errors: 1 })
    expect(log.warn).toHaveBeenCalledOnce()
    expect(sendMock).toHaveBeenCalledTimes(1)
  })

  it('logs but swallows DeleteObjects batch failure', async () => {
    sendMock
      .mockResolvedValueOnce({
        Contents: [{ Key: 'decks/q/a', LastModified: OLD }],
        IsTruncated: false,
      })
      .mockRejectedValueOnce(new Error('batch failed'))

    const log = makeLog()
    const result = await purgeDeckBucketPrefix(noRows, 'q', log)

    expect(result.errors).toBe(1)
    expect(log.warn).toHaveBeenCalledOnce()
  })

  // H1: a pre-0009 folder font lives under the deck it was uploaded in, and
  // its deleteFont clones share that key — deleting the deck must keep it.
  it('keeps every key a media row still names, with its tus sidecar', async () => {
    const font = 'decks/d1/fonts/f1/original.ttf'
    sendMock
      .mockResolvedValueOnce({
        Contents: [
          { Key: 'decks/d1/thumb.jpg', LastModified: OLD },
          { Key: font, LastModified: OLD },
          { Key: `${font}.info`, LastModified: OLD },
        ],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({ Errors: [] })

    const log = makeLog()
    const result = await purgeDeckBucketPrefix(rowsNaming([font]), 'd1', log)

    const deleteCall = sendMock.mock.calls[1]![0] as InstanceType<typeof DeleteObjectsCommand>
    expect(deleteCall.input.Delete?.Objects).toEqual([{ Key: 'decks/d1/thumb.jpg' }])
    expect(result).toEqual({ deleted: 1, pages: 1, errors: 0 })
  })

  it('deletes nothing when it cannot tell which keys rows still name', async () => {
    sendMock.mockResolvedValueOnce({
      Contents: [{ Key: 'decks/d2/thumb.jpg', LastModified: OLD }],
      IsTruncated: false,
    })

    const log = makeLog()
    const result = await purgeDeckBucketPrefix(rowsNaming([], { fail: true }), 'd2', log)

    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ deleted: 0, pages: 1, errors: 1 })
    expect(log.warn).toHaveBeenCalledOnce()
  })

  it('sends no DeleteObjects when every listed key is still named', async () => {
    sendMock.mockResolvedValueOnce({
      Contents: [{ Key: 'decks/d3/fonts/x/original.otf', LastModified: OLD }],
      IsTruncated: false,
    })
    const result = await purgeDeckBucketPrefix(
      rowsNaming(['decks/d3/fonts/x/original.otf']),
      'd3',
      makeLog(),
    )
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ deleted: 0, pages: 1, errors: 0 })
  })
})

describe('the transcode race: what no row names yet', () => {
  it("keeps a video's outputs while its row exists, though the row does not name them yet", async () => {
    sendMock
      .mockResolvedValueOnce({
        Contents: [
          { Key: 'components/c1/videos/v1/playback.mp4', LastModified: OLD },
          { Key: 'components/c1/videos/v1/poster.jpg', LastModified: OLD },
          { Key: 'components/c1/videos/gone/poster.jpg', LastModified: OLD },
          { Key: 'components/c1/thumb.jpg', LastModified: OLD },
        ],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({ Errors: [] })
    const result = await purgeComponentBucketPrefix(rowsExisting(['v1']), 'c1', makeLog())
    const deleteCall = sendMock.mock.calls[1]![0] as InstanceType<typeof DeleteObjectsCommand>
    expect(deleteCall.input.Delete?.Objects).toEqual([
      { Key: 'components/c1/videos/gone/poster.jpg' },
      { Key: 'components/c1/thumb.jpg' },
    ])
    expect(result.deleted).toBe(2)
  })

  it('keeps anything younger than the grace window, and anything of unknown age', async () => {
    const young = new Date(Date.now() - 60_000)
    sendMock
      .mockResolvedValueOnce({
        Contents: [
          { Key: 'decks/d9/uploads/n1/original.png', LastModified: young },
          { Key: 'decks/d9/videos/n2/poster.jpg', LastModified: young },
          { Key: 'decks/d9/unknown-age.bin' },
          { Key: 'decks/d9/thumb.jpg', LastModified: OLD },
        ],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({ Errors: [] })
    await purgeDeckBucketPrefix(rowsExisting([]), 'd9', makeLog())
    const deleteCall = sendMock.mock.calls[1]![0] as InstanceType<typeof DeleteObjectsCommand>
    expect(deleteCall.input.Delete?.Objects).toEqual([{ Key: 'decks/d9/thumb.jpg' }])
  })

  it('takes its grace window from MEDIA_SWEEP_GRACE_MS, else 15 minutes', () => {
    const before = process.env['MEDIA_SWEEP_GRACE_MS']
    try {
      delete process.env['MEDIA_SWEEP_GRACE_MS']
      expect(sweepGraceMs()).toBe(15 * 60_000)
      process.env['MEDIA_SWEEP_GRACE_MS'] = '0'
      expect(sweepGraceMs()).toBe(0)
      process.env['MEDIA_SWEEP_GRACE_MS'] = '-5'
      expect(sweepGraceMs()).toBe(DEFAULT_SWEEP_GRACE_MS)
    } finally {
      if (before === undefined) delete process.env['MEDIA_SWEEP_GRACE_MS']
      else process.env['MEDIA_SWEEP_GRACE_MS'] = before
    }
  })
})

describe('componentIdsInKeys', () => {
  it('names the components whose prefix holds a key, plain or inside a tus upload id', () => {
    const tus = `asset1:unknown:${Buffer.from('components/c2/uploads/asset1/original.png').toString('base64url')}`
    expect(
      componentIdsInKeys([
        'components/c1/uploads/a/original.png',
        'components/c1/videos/a/poster.jpg',
        tus,
        'decks/d1/uploads/b/original.png',
        'components/../decks/d1/x',
        'components/c3',
      ]),
    ).toEqual(new Set(['c1', 'c2']))
  })
})

describe('purgeComponentBucketPrefix', () => {
  it('sweeps components/<id>/', async () => {
    sendMock
      .mockResolvedValueOnce({
        Contents: [{ Key: 'components/c1/thumb.jpg', LastModified: OLD }],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({ Errors: [] })
    const result = await purgeComponentBucketPrefix(noRows, 'c1', makeLog())
    const list = sendMock.mock.calls[0]![0] as ListObjectsV2Command
    expect(list.input.Prefix).toBe('components/c1/')
    expect(result.deleted).toBe(1)
  })

  it("refuses an id that would widen the prefix into another owner's keys", async () => {
    const log = makeLog()
    // A legacy client-chosen id (before A2.12b): components/<victim>/uploads/.
    const result = await purgeComponentBucketPrefix(noRows, 'victim/uploads', log)
    expect(sendMock).not.toHaveBeenCalled()
    expect(result).toEqual({ deleted: 0, pages: 0, errors: 1 })
    expect(log.warn).toHaveBeenCalled()
    await purgeDeckBucketPrefix(noRows, '../decks', log)
    expect(sendMock).not.toHaveBeenCalled()
  })
})
