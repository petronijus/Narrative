import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { S3Client } from '@aws-sdk/client-s3'

// The sanitizer is real except where a test makes it throw (its first call
// loads jsdom; a failed load must not leave the raw SVG in the bucket).
const sanitizeFailure = vi.hoisted(() => ({ error: null as Error | null }))
vi.mock('./svgSanitize.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./svgSanitize.js')>()
  return {
    ...actual,
    sanitizeSvg: (bytes: Buffer) => {
      if (sanitizeFailure.error !== null) throw sanitizeFailure.error
      return actual.sanitizeSvg(bytes)
    },
  }
})
import type { Database } from '../db/client.js'
import { finalizeMediaUpload, UploadRejected, videoContainerMatches } from './finalizeUpload.js'

const pad = (b: Buffer): Buffer => Buffer.concat([b, Buffer.alloc(16)])

describe('videoContainerMatches', () => {
  it.each([
    [
      'MP4 / MOV (ftyp)',
      pad(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypqt  ')])),
    ],
    ['old MOV (moov)', pad(Buffer.concat([Buffer.from([0, 0, 0, 8]), Buffer.from('moov')]))],
    ['WebM / MKV (EBML)', pad(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))],
    ['AVI', pad(Buffer.from('RIFF\u0000\u0000\u0000\u0000AVI ', 'latin1'))],
    ['MPEG-PS', pad(Buffer.from([0, 0, 1, 0xba]))],
    ['Ogg', pad(Buffer.from('OggS'))],
  ])('recognises %s', (_name, bytes) => {
    expect(videoContainerMatches(bytes)).toBe(true)
  })

  it('refuses anything else', () => {
    expect(videoContainerMatches(pad(Buffer.from('-----BEGIN OPENSSH PRIVATE KEY-----')))).toBe(
      false,
    )
    expect(videoContainerMatches(Buffer.from('ftyp'))).toBe(false)
  })
})

describe('finalizeMediaUpload: a component master owns pictures and videos only', () => {
  it('rejects a font for a component (415), deletes the object and writes no row', async () => {
    const send = vi.fn().mockResolvedValue({})
    const insert = vi.fn()
    const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const attempt = finalizeMediaUpload({
      db: { insert } as unknown as Database,
      s3: { send } as unknown as S3Client,
      storageKey: 'components/c1/uploads/a1/original.ttf',
      assetId: 'a1',
      owner: { componentId: 'c1' },
      userId: 'u1',
      mimeType: 'font/ttf',
      filename: 'brand.ttf',
      sizeBytes: 1000,
      log: quiet,
    })
    await expect(attempt).rejects.toBeInstanceOf(UploadRejected)
    await expect(attempt).rejects.toMatchObject({ status: 415 })
    expect(insert).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![0].input).toMatchObject({
      Key: 'components/c1/uploads/a1/original.ttf',
    })
  })
})

describe('finalizeMediaUpload: an SVG the sanitizer cannot process', () => {
  it('deletes the stored original and answers 500 when the sanitizer throws', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    )
    const send = vi.fn(async (command: { constructor: { name: string } }) =>
      command.constructor.name === 'GetObjectCommand' ? { Body: Readable.from([svg]) } : {},
    )
    const insert = vi.fn()
    const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    sanitizeFailure.error = new Error("Cannot find module 'jsdom'")
    try {
      const attempt = finalizeMediaUpload({
        db: { insert } as unknown as Database,
        s3: { send } as unknown as S3Client,
        storageKey: 'decks/d1/uploads/a1/original.svg',
        assetId: 'a1',
        owner: { deckId: 'd1' },
        userId: 'u1',
        mimeType: 'image/svg+xml',
        filename: 'logo.svg',
        sizeBytes: svg.byteLength,
        log: quiet,
      })
      await expect(attempt).rejects.toBeInstanceOf(UploadRejected)
      await expect(attempt).rejects.toMatchObject({ status: 500 })
    } finally {
      sanitizeFailure.error = null
    }
    const names = send.mock.calls.map(([c]) => c.constructor.name)
    expect(names).toContain('DeleteObjectCommand')
    expect(names).not.toContain('PutObjectCommand')
    expect(insert).not.toHaveBeenCalled()
    expect(quiet.error).toHaveBeenCalledWith(expect.anything(), 'SVG sanitizer failed')
  })
})
