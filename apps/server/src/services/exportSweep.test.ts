/**
 * services/exportSweep.test.ts — the periodic export cleanup against an
 * in-memory bucket that answers ListObjectsV2 (with delimiter and
 * pagination) and DeleteObjects the way S3 / MinIO do.
 */

import { describe, expect, it } from 'vitest'
import { DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { EXPORT_MAX_AGE_MS, sweepExpiredExports, type ExportSweepS3 } from './exportSweep.js'

const NOW = new Date('2026-09-27T12:00:00Z')
const HOUR = 60 * 60 * 1000

class FakeBucket implements ExportSweepS3 {
  readonly objects = new Map<string, Date>()
  readonly deleteCalls: string[][] = []
  /** Listings requested, by prefix. */
  readonly listed: string[] = []
  pageSize = 2
  failPrefix: string | null = null

  put(key: string, ageMs: number): void {
    this.objects.set(key, new Date(NOW.getTime() - ageMs))
  }

  async send(command: ListObjectsV2Command | DeleteObjectsCommand): Promise<unknown> {
    if (command instanceof DeleteObjectsCommand) {
      const keys = (command.input.Delete?.Objects ?? []).map((o) => o.Key!)
      this.deleteCalls.push(keys)
      for (const k of keys) this.objects.delete(k)
      return {}
    }
    const { Prefix = '', Delimiter, ContinuationToken } = command.input
    this.listed.push(Prefix)
    if (this.failPrefix !== null && Prefix === this.failPrefix) throw new Error('boom')
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(Prefix)).sort()
    let entries: Array<{ prefix?: string; key?: string }>
    if (Delimiter !== undefined) {
      const prefixes = new Set<string>()
      const plain: string[] = []
      for (const k of keys) {
        const rest = k.slice(Prefix.length)
        const cut = rest.indexOf(Delimiter)
        if (cut === -1) plain.push(k)
        else prefixes.add(Prefix + rest.slice(0, cut + 1))
      }
      entries = [...[...prefixes].map((p) => ({ prefix: p })), ...plain.map((k) => ({ key: k }))]
    } else {
      entries = keys.map((k) => ({ key: k }))
    }
    // Like S3, the continuation token names the last entry returned (not an
    // offset), so deleting objects between pages skips nothing.
    const name = (e: { prefix?: string; key?: string }) => e.prefix ?? e.key!
    entries.sort((a, b) => (name(a) < name(b) ? -1 : 1))
    const rest =
      ContinuationToken === undefined ? entries : entries.filter((e) => name(e) > ContinuationToken)
    const page = rest.slice(0, this.pageSize)
    const truncated = rest.length > this.pageSize
    return {
      CommonPrefixes: page.filter((e) => e.prefix).map((e) => ({ Prefix: e.prefix })),
      Contents: page
        .filter((e) => e.key)
        .map((e) => ({ Key: e.key, LastModified: this.objects.get(e.key!) })),
      IsTruncated: truncated,
      NextContinuationToken: truncated ? name(page[page.length - 1]!) : undefined,
    }
  }
}

const log = { warn: () => undefined, info: () => undefined }

describe('sweepExpiredExports', () => {
  it('deletes export objects older than a day in every deck, and nothing else', async () => {
    const bucket = new FakeBucket()
    bucket.put('decks/a/exports/x1/deck.pptx', 2 * EXPORT_MAX_AGE_MS)
    bucket.put('decks/a/exports/x2/deck.pptx', HOUR)
    bucket.put('decks/a/thumbnail.webp', 30 * EXPORT_MAX_AGE_MS)
    bucket.put('decks/b/exports/y1/deck.pptx', EXPORT_MAX_AGE_MS + 1)
    bucket.put('decks/b/video/v1.mp4', 30 * EXPORT_MAX_AGE_MS)
    bucket.put('decks/c/exports/z1/deck.pptx', EXPORT_MAX_AGE_MS - 1)
    bucket.put('media/other/exports/old.pptx', 30 * EXPORT_MAX_AGE_MS)
    // A component master's card render left behind, and its own card picture.
    bucket.put('components/m/exports/k1/thumb.png', 2 * EXPORT_MAX_AGE_MS)
    bucket.put('components/m/thumb-abc.png', 30 * EXPORT_MAX_AGE_MS)

    const result = await sweepExpiredExports({ s3: bucket, bucket: 'b', log, now: () => NOW })

    expect(result).toEqual({ decks: 3, components: 1, deleted: 3, failures: 0 })
    expect(bucket.objects.has('components/m/thumb-abc.png')).toBe(true)
    expect(bucket.objects.has('components/m/exports/k1/thumb.png')).toBe(false)
    expect([...bucket.objects.keys()].sort()).toEqual([
      'components/m/thumb-abc.png',
      'decks/a/exports/x2/deck.pptx',
      'decks/a/thumbnail.webp',
      'decks/b/video/v1.mp4',
      'decks/c/exports/z1/deck.pptx',
      'media/other/exports/old.pptx',
    ])
    // Only the exports folders were listed per deck, never whole deck prefixes.
    expect(bucket.listed.filter((p) => p !== 'decks/' && p !== 'components/')).toEqual([
      'decks/a/exports/',
      'decks/b/exports/',
      'decks/c/exports/',
      'components/m/exports/',
    ])
  })

  it('follows pagination of both the deck listing and the exports listing', async () => {
    const bucket = new FakeBucket()
    for (let d = 0; d < 5; d++) {
      for (let e = 0; e < 5; e++)
        bucket.put(`decks/d${d}/exports/e${e}/deck.pptx`, 3 * EXPORT_MAX_AGE_MS)
    }
    const result = await sweepExpiredExports({ s3: bucket, bucket: 'b', log, now: () => NOW })
    expect(result).toEqual({ decks: 5, components: 0, deleted: 25, failures: 0 })
    expect(bucket.objects.size).toBe(0)
  })

  it('keeps going when one deck fails, and reports it', async () => {
    const bucket = new FakeBucket()
    bucket.put('decks/a/exports/x/deck.pptx', 3 * EXPORT_MAX_AGE_MS)
    bucket.put('decks/b/exports/y/deck.pptx', 3 * EXPORT_MAX_AGE_MS)
    bucket.failPrefix = 'decks/a/exports/'
    const result = await sweepExpiredExports({ s3: bucket, bucket: 'b', log, now: () => NOW })
    expect(result).toEqual({ decks: 2, components: 0, deleted: 1, failures: 1 })
    expect([...bucket.objects.keys()]).toEqual(['decks/a/exports/x/deck.pptx'])
  })

  it('never throws, even when the bucket cannot be listed', async () => {
    const bucket = new FakeBucket()
    bucket.failPrefix = 'decks/'
    await expect(
      sweepExpiredExports({ s3: bucket, bucket: 'b', log, now: () => NOW }),
    ).resolves.toEqual({ decks: 0, components: 0, deleted: 0, failures: 1 })
  })
})
