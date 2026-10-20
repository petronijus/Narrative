/**
 * pptx/zipWriter.ts — a ZIP package laid out in full before its first byte
 * is written, then streamed to wherever it goes (docs/plans/performance.md,
 * X3).
 *
 * The exporter used to build the package with JSZip: a JavaScript CRC-32 over
 * every byte of media (about a second per 200 MB on the event loop), and the
 * whole file in memory, twice at its peak, before the first byte left. Here
 * every entry's CRC-32 and sizes are known before anything is written — the
 * caller computes them (`zlib.crc32`, native) in a first pass over its
 * sources — so the archive is a plan with an exact byte length: an HTTP
 * response can carry `Content-Length`, an inline delivery can be refused for
 * its size before any work, and the bytes are produced in order with
 * backpressure from the destination, a stream at a time.
 *
 * What it writes is what JSZip wrote, which PowerPoint opens: local file
 * headers carrying CRC and sizes (no data descriptors — bit 3 is never set,
 * so a reader that walks local headers, or one that insists on sizes before
 * STORE data, reads it too), DOS timestamps from the UTC clock, no extra
 * fields, entries in the order given, the central directory, the end
 * record. "Version needed" is 2.0 (DEFLATE) where JSZip wrote 1.0. Names are
 * UTF-8 with bit 11 set when not ASCII.
 *
 * ZIP64 (APPNOTE 4.5.3) where a size, an offset or the entry count passes
 * what the classic fields hold: a package over 4 GiB is rare, but nothing
 * else stops a deck of long videos from becoming one, and JSZip silently
 * wrote a broken file then. `limits` lowers the thresholds for tests.
 *
 * A streamed entry is checked as it passes: its bytes must add up to the
 * size and CRC the plan announced (and a deflated one to its compressed
 * size), or the write fails — a truncated or changed source never produces a
 * package that lies about its contents.
 */

import { crc32, deflateRaw } from 'node:zlib'
import { promisify } from 'node:util'
import { pipeline } from 'node:stream/promises'
import type { Writable } from 'node:stream'

const deflateRawAsync = promisify(deflateRaw)

/** The DEFLATE level every deflated entry uses (JSZip's level 6 before). */
export const ZIP_DEFLATE_LEVEL = 6

/** The bytes of a streamed entry, produced again for the write. */
export type ZipSource = () => Promise<AsyncIterable<Uint8Array>>

export interface ZipEntry {
  name: string
  /** 0 = STORE, 8 = DEFLATE. */
  method: 0 | 8
  /** CRC-32 of the uncompressed bytes. */
  crc: number
  /** Uncompressed size. */
  size: number
  /** Size as written (equals `size` for STORE). */
  compressedSize: number
  /**
   * The bytes as written (compressed for DEFLATE), or a source producing
   * them — for DEFLATE already compressed, deterministically (the plan's
   * `compressedSize` is checked against what it produces).
   */
  data: Uint8Array | ZipSource
}

/** Thresholds above which ZIP64 fields are written (lowered by tests). */
export interface ZipLimits {
  /** Largest value a 32-bit size or offset field carries as itself. */
  u32: number
  /** Largest entry count the classic end record carries as itself. */
  u16: number
}

const CLASSIC_LIMITS: ZipLimits = { u32: 0xfffffffe, u16: 0xfffe }

/** An entry compressed here, in memory: an XML part, a small file. */
export async function deflatedEntry(
  name: string,
  content: string | Uint8Array,
  level = ZIP_DEFLATE_LEVEL,
): Promise<ZipEntry> {
  const raw = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
  const data = await deflateRawAsync(raw, { level })
  return {
    name,
    method: 8,
    crc: crc32(raw),
    size: raw.byteLength,
    compressedSize: data.byteLength,
    data,
  }
}

/** An entry stored as it is, from memory. */
export function storedEntry(name: string, bytes: Uint8Array): ZipEntry {
  return {
    name,
    method: 0,
    crc: crc32(bytes),
    size: bytes.byteLength,
    compressedSize: bytes.byteLength,
    data: bytes,
  }
}

/** Streamed entries opened ahead of the one being written, at most (default). */
export const ZIP_READ_AHEAD = 4
/** How near its data the write must be before a source is opened ahead (default). */
export const ZIP_READ_AHEAD_BYTES = 1024 * 1024

/** How far ahead of the write streamed sources are opened. */
export interface ReadAheadOptions {
  /** Sources open ahead of the current entry, at most (0: none). */
  readAhead?: number
  /** A source is opened once the write is within this many bytes of its data. */
  readAheadBytes?: number
}

/** A planned archive: its exact length, and its bytes on demand. */
export interface ZipPlan {
  readonly size: number
  readonly entries: readonly ZipEntry[]
  /** The archive's bytes, in order; streamed entries opened ahead as `ReadAheadOptions` say. */
  chunks(opts?: ReadAheadOptions): AsyncGenerator<Uint8Array>
  /** Write the archive into `destination` (ended when done; destroyed on failure). */
  writeTo(destination: Writable, opts?: { signal?: AbortSignal } & ReadAheadOptions): Promise<void>
}

interface Placed {
  entry: ZipEntry
  nameBytes: Buffer
  offset: number
  local: Buffer
}

/** The earliest and latest moments a DOS timestamp holds (1980-01-01 to 2107-12-31, UTC). */
const DOS_MIN = Date.UTC(1980, 0, 1)
const DOS_MAX = Date.UTC(2107, 11, 31, 23, 59, 58)

function dosDateTime(at: Date): { time: number; date: number } {
  // UTC fields, as JSZip wrote them; DOS time counts seconds in twos. A
  // moment outside what DOS can say is clamped to its range (JSZip wrapped
  // it into a nonsense date).
  const date = new Date(Math.min(DOS_MAX, Math.max(DOS_MIN, at.getTime())))
  const time =
    (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1)
  const day =
    ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate()
  return { time, date: day }
}

const ASCII = /^[\x20-\x7e]*$/

/**
 * Lay out `entries` (in this order) as one archive stamped `date`. Throws on
 * a duplicate name — a package with two parts of one name is not one.
 */
export function planZip(
  entries: readonly ZipEntry[],
  opts: { date: Date; limits?: ZipLimits },
): ZipPlan {
  const limits = opts.limits ?? CLASSIC_LIMITS
  const stamp = dosDateTime(opts.date)
  const seen = new Set<string>()
  const placed: Placed[] = []
  let offset = 0

  for (const entry of entries) {
    if (seen.has(entry.name)) throw new Error(`zip: duplicate entry ${entry.name}`)
    seen.add(entry.name)
    if (entry.method === 0 && entry.compressedSize !== entry.size)
      throw new Error(`zip: stored entry ${entry.name} has two sizes`)
    if (entry.data instanceof Uint8Array && entry.data.byteLength !== entry.compressedSize)
      throw new Error(`zip: entry ${entry.name} is not the size it says`)
    const nameBytes = Buffer.from(entry.name, 'utf8')
    const big = entry.size > limits.u32 || entry.compressedSize > limits.u32
    const local = Buffer.alloc(30 + nameBytes.byteLength + (big ? 20 : 0))
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(big ? 45 : 20, 4)
    local.writeUInt16LE(ASCII.test(entry.name) ? 0 : 0x0800, 6)
    local.writeUInt16LE(entry.method, 8)
    local.writeUInt16LE(stamp.time, 10)
    local.writeUInt16LE(stamp.date, 12)
    local.writeUInt32LE(entry.crc >>> 0, 14)
    local.writeUInt32LE(big ? 0xffffffff : entry.compressedSize, 18)
    local.writeUInt32LE(big ? 0xffffffff : entry.size, 22)
    local.writeUInt16LE(nameBytes.byteLength, 26)
    local.writeUInt16LE(big ? 20 : 0, 28)
    nameBytes.copy(local, 30)
    if (big) {
      // The ZIP64 extra of a local header carries both sizes (4.5.3).
      const at = 30 + nameBytes.byteLength
      local.writeUInt16LE(0x0001, at)
      local.writeUInt16LE(16, at + 2)
      local.writeBigUInt64LE(BigInt(entry.size), at + 4)
      local.writeBigUInt64LE(BigInt(entry.compressedSize), at + 12)
    }
    placed.push({ entry, nameBytes, offset, local })
    offset += local.byteLength + entry.compressedSize
  }

  const directory = placed.map((p) => centralRecord(p, stamp, limits))
  const cdOffset = offset
  const cdSize = directory.reduce((n, b) => n + b.byteLength, 0)
  const end = endRecords(placed.length, cdOffset, cdSize, limits)
  const size = cdOffset + cdSize + end.byteLength

  async function* chunks(chunkOpts: ReadAheadOptions = {}): AsyncGenerator<Uint8Array> {
    const readAhead = Math.max(0, chunkOpts.readAhead ?? ZIP_READ_AHEAD)
    const readAheadBytes = Math.max(0, chunkOpts.readAheadBytes ?? ZIP_READ_AHEAD_BYTES)
    // Sources opened ahead of the one being written: their first bytes are
    // on the way while the current entry streams (each held back by its own
    // backpressure, so only socket buffers wait in memory). Only near the end
    // of what is being written — within `readAheadBytes` of a source's data —
    // and at most `readAhead` of them: a slow destination (a download over a
    // poor link) never holds storage reads open and idle for long.
    const opened = new Map<number, Promise<AsyncIterable<Uint8Array>>>()
    let position = 0
    const openSource = (j: number): void => {
      const data = placed[j]!.entry.data
      if (opened.has(j) || data instanceof Uint8Array) return
      const p = data()
      // A source opened ahead may never be read (a failure before it):
      // its rejection is handled where it is awaited, or dropped below.
      p.catch(() => undefined)
      opened.set(j, p)
    }
    /** Open the sources after `i` whose data starts within reach of `position`. */
    const openAhead = (i: number): void => {
      for (let j = i + 1; j < placed.length && j <= i + readAhead; j++) {
        const dataAt = placed[j]!.offset + placed[j]!.local.byteLength
        if (dataAt - position > readAheadBytes) break
        openSource(j)
      }
    }
    try {
      for (let i = 0; i < placed.length; i++) {
        const { entry, local } = placed[i]!
        yield local
        position += local.byteLength
        if (entry.data instanceof Uint8Array) {
          if (entry.data.byteLength > 0) yield entry.data
          position += entry.data.byteLength
          openAhead(i)
          continue
        }
        openSource(i)
        openAhead(i)
        const source = await opened.get(i)!
        opened.delete(i)
        for await (const chunk of checked(entry, source)) {
          yield chunk
          position += chunk.byteLength
          openAhead(i)
        }
      }
      for (const record of directory) yield record
      yield end
    } finally {
      // Sources opened ahead and never read: let their streams go.
      for (const p of opened.values()) {
        void p.then(release, () => undefined)
      }
    }
  }

  return {
    size,
    entries,
    chunks,
    async writeTo(destination, writeOpts = {}) {
      const { signal, ...ahead } = writeOpts
      await pipeline(chunks(ahead), destination, signal !== undefined ? { signal } : {})
    },
  }
}

/** Destroy a stream that was opened and never read. */
function release(source: AsyncIterable<Uint8Array>): void {
  const destroy = (source as { destroy?: (err?: Error) => void }).destroy
  if (typeof destroy === 'function') destroy.call(source)
}

/**
 * A streamed entry's bytes, passed on as they come and checked against the
 * plan: its compressed size always; for STORE also its CRC (the bytes are
 * the content). A DEFLATE source checks its uncompressed bytes itself
 * (`deflatingSource` in the exporter), the only place they exist.
 */
async function* checked(
  entry: ZipEntry,
  source: AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  let written = 0
  let crc = 0
  for await (const chunk of source) {
    written += chunk.byteLength
    if (written > entry.compressedSize) break
    if (entry.method === 0) crc = crc32(chunk, crc)
    yield chunk
  }
  if (written !== entry.compressedSize || (entry.method === 0 && crc >>> 0 !== entry.crc >>> 0)) {
    release(source)
    throw new Error(`zip: ${entry.name} changed while the package was written`)
  }
}

function centralRecord(
  p: Placed,
  stamp: { time: number; date: number },
  limits: ZipLimits,
): Buffer {
  const { entry, nameBytes, offset } = p
  const fields: bigint[] = []
  if (entry.size > limits.u32) fields.push(BigInt(entry.size))
  if (entry.compressedSize > limits.u32) fields.push(BigInt(entry.compressedSize))
  if (offset > limits.u32) fields.push(BigInt(offset))
  const extraLength = fields.length > 0 ? 4 + 8 * fields.length : 0
  const big = fields.length > 0
  const record = Buffer.alloc(46 + nameBytes.byteLength + extraLength)
  record.writeUInt32LE(0x02014b50, 0)
  // Made by: MS-DOS, the spec version needed (JSZip: DOS, 2.0).
  record.writeUInt16LE(big ? 45 : 20, 4)
  record.writeUInt16LE(big ? 45 : 20, 6)
  record.writeUInt16LE(ASCII.test(entry.name) ? 0 : 0x0800, 8)
  record.writeUInt16LE(entry.method, 10)
  record.writeUInt16LE(stamp.time, 12)
  record.writeUInt16LE(stamp.date, 14)
  record.writeUInt32LE(entry.crc >>> 0, 16)
  record.writeUInt32LE(entry.compressedSize > limits.u32 ? 0xffffffff : entry.compressedSize, 20)
  record.writeUInt32LE(entry.size > limits.u32 ? 0xffffffff : entry.size, 24)
  record.writeUInt16LE(nameBytes.byteLength, 28)
  record.writeUInt16LE(extraLength, 30)
  // Comment length, disk number start, internal attributes, external attributes: 0.
  record.writeUInt32LE(offset > limits.u32 ? 0xffffffff : offset, 42)
  nameBytes.copy(record, 46)
  if (big) {
    const at = 46 + nameBytes.byteLength
    record.writeUInt16LE(0x0001, at)
    record.writeUInt16LE(8 * fields.length, at + 2)
    fields.forEach((v, i) => record.writeBigUInt64LE(v, at + 4 + 8 * i))
  }
  return record
}

/** The end of central directory record, with the ZIP64 record and locator before it when needed. */
function endRecords(count: number, cdOffset: number, cdSize: number, limits: ZipLimits): Buffer {
  const big = count > limits.u16 || cdOffset > limits.u32 || cdSize > limits.u32
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  // This disk, the directory's disk: 0.
  eocd.writeUInt16LE(count > limits.u16 ? 0xffff : count, 8)
  eocd.writeUInt16LE(count > limits.u16 ? 0xffff : count, 10)
  eocd.writeUInt32LE(cdSize > limits.u32 ? 0xffffffff : cdSize, 12)
  eocd.writeUInt32LE(cdOffset > limits.u32 ? 0xffffffff : cdOffset, 16)
  // No comment.
  if (!big) return eocd
  const record = Buffer.alloc(56)
  record.writeUInt32LE(0x06064b50, 0)
  record.writeBigUInt64LE(44n, 4)
  record.writeUInt16LE(45, 12)
  record.writeUInt16LE(45, 14)
  // Disk numbers 0.
  record.writeBigUInt64LE(BigInt(count), 24)
  record.writeBigUInt64LE(BigInt(count), 32)
  record.writeBigUInt64LE(BigInt(cdSize), 40)
  record.writeBigUInt64LE(BigInt(cdOffset), 48)
  const locator = Buffer.alloc(20)
  locator.writeUInt32LE(0x07064b50, 0)
  locator.writeBigUInt64LE(BigInt(cdOffset + cdSize), 8)
  locator.writeUInt32LE(1, 16)
  return Buffer.concat([record, locator, eocd])
}
