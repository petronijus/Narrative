import { describe, expect, it } from 'vitest'
import { videoContainerMatches } from './finalizeUpload.js'

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
