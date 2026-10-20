/**
 * media/multipartUpload.test.ts — the streamed multipart upload against a
 * fake S3: parts cut where the buffer passes the part size and sent in order,
 * the last one smaller, an empty object as one empty part; and on any failure
 * — a part, the completion, or a destroy while the upload is still being
 * created — the upload is aborted, never completed.
 */

import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { describe, expect, it, vi } from 'vitest'
import { multipartUploadStream } from './multipartUpload.js'

type Sent = { name: string; input: Record<string, unknown> }

function fakeS3(over: Partial<Record<string, (input: Record<string, unknown>) => unknown>> = {}) {
  const sent: Sent[] = []
  const send = vi.fn(
    async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = cmd.constructor.name
      sent.push({ name, input: cmd.input })
      const handler = over[name]
      if (handler !== undefined) return handler(cmd.input)
      if (name === 'CreateMultipartUploadCommand') return { UploadId: 'up-1' }
      if (name === 'UploadPartCommand') return { ETag: `"etag-${String(cmd.input['PartNumber'])}"` }
      return {}
    },
  )
  return { s3: { send } as never, sent, names: () => sent.map((s) => s.name) }
}

const target = (s3: unknown, partBytes = 10) => ({
  s3: s3 as never,
  bucket: 'b',
  key: 'decks/d/exports/x/deck.pptx',
  contentType: 'application/zip',
  contentDisposition: 'attachment; filename="deck.pptx"',
  cacheControl: 'private, no-store',
  partBytes,
})

const chunks = (...sizes: number[]): Buffer[] => {
  let n = 0
  return sizes.map((size) => Buffer.from(Array.from({ length: size }, () => n++ % 256)))
}

describe('multipartUploadStream', () => {
  it('cuts parts past the part size, in order, the last one what is left', async () => {
    const { s3, sent, names } = fakeS3()
    const input = chunks(7, 7, 7, 4) // 7 → 14 (part 1) → 7 → 11 (part 2) → … 0 left
    await pipeline(Readable.from(input), multipartUploadStream(target(s3)))
    expect(names()).toEqual([
      'CreateMultipartUploadCommand',
      'UploadPartCommand',
      'UploadPartCommand',
      'CompleteMultipartUploadCommand',
    ])
    expect(sent[0]!.input).toMatchObject({
      Bucket: 'b',
      Key: 'decks/d/exports/x/deck.pptx',
      ContentType: 'application/zip',
      ContentDisposition: 'attachment; filename="deck.pptx"',
      CacheControl: 'private, no-store',
    })
    const parts = sent.filter((s) => s.name === 'UploadPartCommand').map((s) => s.input)
    expect(parts.map((p) => [p['PartNumber'], p['ContentLength']])).toEqual([
      [1, 14],
      [2, 11],
    ])
    expect(Buffer.concat(parts.map((p) => p['Body'] as Buffer))).toEqual(Buffer.concat(input))
    expect(sent.at(-1)!.input).toMatchObject({
      UploadId: 'up-1',
      MultipartUpload: {
        Parts: [
          { PartNumber: 1, ETag: '"etag-1"' },
          { PartNumber: 2, ETag: '"etag-2"' },
        ],
      },
    })
  })

  it('sends the last part when it is smaller than the part size', async () => {
    const { s3, sent } = fakeS3()
    await pipeline(Readable.from(chunks(10, 3)), multipartUploadStream(target(s3)))
    const parts = sent.filter((s) => s.name === 'UploadPartCommand').map((s) => s.input)
    expect(parts.map((p) => p['ContentLength'])).toEqual([10, 3])
    expect(sent.at(-1)!.name).toBe('CompleteMultipartUploadCommand')
  })

  it('stores an empty object as one empty part', async () => {
    const { s3, sent, names } = fakeS3()
    await pipeline(Readable.from([]), multipartUploadStream(target(s3)))
    expect(names()).toEqual([
      'CreateMultipartUploadCommand',
      'UploadPartCommand',
      'CompleteMultipartUploadCommand',
    ])
    expect(sent[1]!.input['ContentLength']).toBe(0)
  })

  it('aborts when a part fails, and never completes', async () => {
    let calls = 0
    const { s3, names, sent } = fakeS3({
      UploadPartCommand: () => {
        if (++calls === 2) throw new Error('part 2 refused')
        return { ETag: '"e"' }
      },
    })
    await expect(
      pipeline(Readable.from(chunks(10, 10, 10)), multipartUploadStream(target(s3))),
    ).rejects.toThrow('part 2 refused')
    expect(names()).not.toContain('CompleteMultipartUploadCommand')
    expect(names().at(-1)).toBe('AbortMultipartUploadCommand')
    expect(sent.at(-1)!.input).toMatchObject({
      UploadId: 'up-1',
      Key: 'decks/d/exports/x/deck.pptx',
    })
  })

  it('aborts when the completion fails', async () => {
    const { s3, names } = fakeS3({
      CompleteMultipartUploadCommand: () => {
        throw new Error('complete refused')
      },
    })
    await expect(
      pipeline(Readable.from(chunks(4)), multipartUploadStream(target(s3))),
    ).rejects.toThrow('complete refused')
    expect(names().at(-1)).toBe('AbortMultipartUploadCommand')
  })

  it('aborts an upload destroyed while it is still being created, once it exists', async () => {
    let created!: (v: { UploadId: string }) => void
    const { s3, names } = fakeS3({
      CreateMultipartUploadCommand: () => new Promise((resolve) => (created = resolve)),
    })
    const stream = multipartUploadStream(target(s3))
    stream.on('error', () => undefined)
    stream.write(Buffer.alloc(12)) // a full part: the upload is being created
    await vi.waitFor(() => expect(names()).toEqual(['CreateMultipartUploadCommand']))
    const closed = new Promise((resolve) => stream.on('close', resolve))
    stream.destroy(new Error('the export failed upstream'))
    created({ UploadId: 'up-late' })
    await closed
    // No part went after the destroy; the upload created meanwhile is aborted.
    expect(names()).toEqual(['CreateMultipartUploadCommand', 'AbortMultipartUploadCommand'])
  })

  it('waits for a part on its way before it aborts', async () => {
    let partSent!: (v: { ETag: string }) => void
    const { s3, names } = fakeS3({
      UploadPartCommand: () => new Promise((resolve) => (partSent = resolve)),
    })
    const stream = multipartUploadStream(target(s3))
    stream.on('error', () => undefined)
    stream.write(Buffer.alloc(12))
    await vi.waitFor(() => expect(names()).toContain('UploadPartCommand'))
    const closed = new Promise((resolve) => stream.on('close', resolve))
    stream.destroy(new Error('client gone'))
    await new Promise((resolve) => setImmediate(resolve))
    expect(names()).not.toContain('AbortMultipartUploadCommand')
    partSent({ ETag: '"e"' })
    await closed
    expect(names().at(-1)).toBe('AbortMultipartUploadCommand')
  })

  it('sends nothing when destroyed before the first part, and aborts nothing after success', async () => {
    const early = fakeS3()
    const stream = multipartUploadStream(target(early.s3))
    stream.on('error', () => undefined)
    stream.write(Buffer.alloc(3))
    const closed = new Promise((resolve) => stream.on('close', resolve))
    stream.destroy(new Error('gone'))
    await closed
    expect(early.names()).toEqual([])

    const ok = fakeS3()
    await pipeline(Readable.from(chunks(5)), multipartUploadStream(target(ok.s3)))
    await new Promise((resolve) => setImmediate(resolve))
    expect(ok.names()).not.toContain('AbortMultipartUploadCommand')
  })
})
