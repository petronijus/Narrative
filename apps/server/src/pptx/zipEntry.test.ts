/**
 * zipEntry — the head sniff is bounded however far an entry would expand.
 *
 * The fixtures are real archives built byte by byte (local header, data,
 * central directory, end record) so JSZip reads the declared sizes from the
 * central directory exactly as it does for an uploaded deck.
 */

import { constants, deflateRawSync, inflateRawSync } from 'node:zlib'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { readEntryBytes, readEntryHead } from './zipEntry.js'

/** A one-entry DEFLATE zip whose headers declare `declaredSize` (CRC left 0: not checked). */
function zipWithDeflatedEntry(name: string, data: Buffer, declaredSize: number): Buffer {
  const nameBytes = Buffer.from(name, 'utf8')
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4) // version needed
  local.writeUInt16LE(0, 6) // flags
  local.writeUInt16LE(8, 8) // DEFLATE
  local.writeUInt32LE(0, 14) // crc
  local.writeUInt32LE(data.byteLength, 18)
  local.writeUInt32LE(declaredSize, 22)
  local.writeUInt16LE(nameBytes.byteLength, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4) // version made by
  central.writeUInt16LE(20, 6) // version needed
  central.writeUInt16LE(8, 10) // DEFLATE
  central.writeUInt32LE(data.byteLength, 20)
  central.writeUInt32LE(declaredSize, 24)
  central.writeUInt16LE(nameBytes.byteLength, 28)
  central.writeUInt32LE(0, 42) // local header offset
  const localPart = Buffer.concat([local, nameBytes, data])
  const centralPart = Buffer.concat([central, nameBytes])
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(centralPart.byteLength, 12)
  end.writeUInt32LE(localPart.byteLength, 16)
  return Buffer.concat([localPart, centralPart, end])
}

/**
 * ~1 KiB of empty non-final stored blocks (header bits 000, aligned, LEN 0,
 * NLEN 0xFFFF — 5 bytes each, decoding to nothing), then a run-length bomb:
 * the 1 KiB prefix the sniff tries first decodes to nothing, the 64 KiB one to
 * tens of megabytes.
 */
function bombStream(): Buffer {
  const emptyStored = Buffer.from([0x00, 0x00, 0x00, 0xff, 0xff])
  const padding = Buffer.concat(Array.from({ length: 205 }, () => emptyStored))
  const bomb = deflateRawSync(Buffer.alloc(80 * 1024 * 1024), { level: 9 })
  return Buffer.concat([padding, bomb])
}

async function onlyEntry(zipBytes: Buffer): Promise<JSZip.JSZipObject> {
  const zip = await JSZip.loadAsync(zipBytes)
  const entry = zip.file('ppt/media/image1.png')
  if (entry === null) throw new Error('fixture has no entry')
  return entry
}

describe('readEntryHead', () => {
  const stream = bombStream()

  it('the fixture is a real bomb: its 64 KiB prefix inflates to tens of MB unbounded', () => {
    expect(stream.byteLength).toBeGreaterThan(64 * 1024)
    const unbounded = inflateRawSync(stream.subarray(0, 64 * 1024), {
      finishFlush: constants.Z_SYNC_FLUSH,
    })
    expect(unbounded.byteLength).toBeGreaterThan(32 * 1024 * 1024)
  })

  it('rejects an entry whose head outgrows its declared size, without inflating the bomb', async () => {
    const entry = await onlyEntry(zipWithDeflatedEntry('ppt/media/image1.png', stream, 12))
    const started = performance.now()
    await expect(readEntryHead(entry, 16)).rejects.toThrow(/inflates past its declared 12 bytes/)
    // Inflating the bomb takes hundreds of ms; the bounded head is one chunk.
    expect(performance.now() - started).toBeLessThan(250)
  })

  it('stops after n bytes when a large declared size is honest', async () => {
    const entry = await onlyEntry(
      zipWithDeflatedEntry('ppt/media/image1.png', stream, 80 * 1024 * 1024),
    )
    const started = performance.now()
    const head = await readEntryHead(entry, 16)
    expect(head.byteLength).toBe(16)
    expect(head.every((b) => b === 0)).toBe(true)
    expect(performance.now() - started).toBeLessThan(250)
  })

  it('returns the first n bytes of an ordinary deflated entry', async () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('x'.repeat(10_000)),
    ])
    const entry = await onlyEntry(
      zipWithDeflatedEntry('ppt/media/image1.png', deflateRawSync(png), png.byteLength),
    )
    expect(await readEntryHead(entry, 8)).toEqual(png.subarray(0, 8))
    expect(await readEntryBytes(entry)).toEqual(png)
  })

  it('returns a short entry whole, and the full read still enforces the declared size', async () => {
    const tiny = Buffer.from('hello')
    const honest = await onlyEntry(
      zipWithDeflatedEntry('ppt/media/image1.png', deflateRawSync(tiny), tiny.byteLength),
    )
    expect(await readEntryHead(honest, 16)).toEqual(tiny)
    const lying = await onlyEntry(
      zipWithDeflatedEntry('ppt/media/image1.png', deflateRawSync(Buffer.alloc(4096)), 12),
    )
    await expect(readEntryHead(lying, 16)).rejects.toThrow(/Corrupted zip/)
  })
})
