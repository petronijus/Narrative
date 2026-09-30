import { describe, expect, it, vi } from 'vitest'
import type { S3Client } from '@aws-sdk/client-s3'
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
