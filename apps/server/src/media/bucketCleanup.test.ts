/**
 * media/bucketCleanup.test.ts
 *
 * Unit tests for the `decks/<deckId>/` prefix purge helper.
 *
 * The S3 client is mocked at the `./s3Client.js` module boundary so we
 * can assert exactly which AWS SDK commands the helper issues, without
 * needing a live MinIO. ListObjectsV2 + DeleteObjects are the two
 * commands under test; we drive multi-page pagination, per-object
 * Errors arrays, and list-failure short-circuit paths.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3'

const sendMock = vi.fn()

vi.mock('./s3Client.js', () => ({
  buildS3Client: () => ({ send: sendMock }),
  MEDIA_BUCKET: 'test-bucket',
}))

const { purgeDeckBucketPrefix } = await import('./bucketCleanup.js')

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
          { Key: 'decks/abc/thumb.jpg' },
          { Key: 'decks/abc/uploads/x/original.png' },
          { Key: 'decks/abc/videos/y/master.m3u8' },
          { Key: 'decks/abc/videos/y/segment_000.ts' },
        ],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({ Errors: [] })

    const log = makeLog()
    const result = await purgeDeckBucketPrefix('abc', log)

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
      { Key: 'decks/abc/videos/y/master.m3u8' },
      { Key: 'decks/abc/videos/y/segment_000.ts' },
    ])
    expect(deleteCall.input.Delete?.Quiet).toBe(true)

    expect(log.warn).not.toHaveBeenCalled()
  })

  it('paginates with ContinuationToken when IsTruncated', async () => {
    sendMock
      .mockResolvedValueOnce({
        Contents: [{ Key: 'decks/big/a' }],
        IsTruncated: true,
        NextContinuationToken: 'token-2',
      })
      .mockResolvedValueOnce({}) // first DeleteObjects
      .mockResolvedValueOnce({
        Contents: [{ Key: 'decks/big/b' }],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({}) // second DeleteObjects

    const log = makeLog()
    const result = await purgeDeckBucketPrefix('big', log)

    expect(result).toEqual({ deleted: 2, pages: 2, errors: 0 })

    const firstList = sendMock.mock.calls[0]![0] as InstanceType<typeof ListObjectsV2Command>
    expect(firstList.input.ContinuationToken).toBeUndefined()

    const secondList = sendMock.mock.calls[2]![0] as InstanceType<typeof ListObjectsV2Command>
    expect(secondList.input.ContinuationToken).toBe('token-2')
  })

  it('skips DeleteObjects when a page has no Contents', async () => {
    sendMock.mockResolvedValueOnce({ Contents: [], IsTruncated: false })

    const log = makeLog()
    const result = await purgeDeckBucketPrefix('empty', log)

    expect(result).toEqual({ deleted: 0, pages: 1, errors: 0 })
    expect(sendMock).toHaveBeenCalledTimes(1)
  })

  it('records per-object Errors but does not throw', async () => {
    sendMock
      .mockResolvedValueOnce({
        Contents: [{ Key: 'decks/p/a' }, { Key: 'decks/p/b' }],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({
        Errors: [{ Key: 'decks/p/b', Code: 'AccessDenied', Message: 'nope' }],
      })

    const log = makeLog()
    const result = await purgeDeckBucketPrefix('p', log)

    expect(result.deleted).toBe(2)
    expect(result.errors).toBe(1)
    expect(log.warn).toHaveBeenCalledOnce()
  })

  it('aborts on list failure but does not throw', async () => {
    sendMock.mockRejectedValueOnce(new Error('S3 unavailable'))

    const log = makeLog()
    const result = await purgeDeckBucketPrefix('boom', log)

    expect(result).toEqual({ deleted: 0, pages: 0, errors: 1 })
    expect(log.warn).toHaveBeenCalledOnce()
    expect(sendMock).toHaveBeenCalledTimes(1)
  })

  it('logs but swallows DeleteObjects batch failure', async () => {
    sendMock
      .mockResolvedValueOnce({
        Contents: [{ Key: 'decks/q/a' }],
        IsTruncated: false,
      })
      .mockRejectedValueOnce(new Error('batch failed'))

    const log = makeLog()
    const result = await purgeDeckBucketPrefix('q', log)

    expect(result.errors).toBe(1)
    expect(log.warn).toHaveBeenCalledOnce()
  })
})
