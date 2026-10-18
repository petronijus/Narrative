/**
 * pptx/zipEntry.ts — an entry's bytes, inflated by Node's zlib.
 *
 * JSZip inflates with pako, pure JavaScript on the main thread: for a deck's
 * media (hundreds of MB, nearly all of it DEFLATE-stored by PowerPoint) that
 * was seconds of blocked event loop per import, plus a copy per entry. The
 * archive JSZip loaded still holds each entry's compressed bytes — a view
 * into the uploaded buffer — and what they decode with, so this hands them to
 * `zlib.inflateRaw` instead: native, off the main thread on libuv's pool, and
 * several entries at once when the caller asks for them together.
 *
 * Same contract as `entry.async('nodebuffer')`: the declared uncompressed
 * size must match (JSZip throws on a mismatch too; here the inflate is also
 * capped at that size, so an entry lying about its size cannot expand past
 * it), and the CRC is not checked — JSZip does not either unless asked to,
 * and a deck PowerPoint opens should not start failing here. Anything else —
 * an entry JSZip built itself, a compression other than STORE / DEFLATE, a
 * future JSZip whose internals differ — goes through JSZip as before.
 *
 * A STORE entry comes back as a view into the archive's buffer (no copy):
 * callers read it, and copy before writing into it (`decodeFontBytes` does).
 */

import { constants, inflateRaw, inflateRawSync } from 'node:zlib'
import { promisify } from 'node:util'
import type JSZip from 'jszip'

const inflateRawAsync = promisify(inflateRaw)

const STORE = '\x00\x00'
const DEFLATE = '\x08\x00'

/** The part of JSZip's `CompressedObject` (lib/compressedObject.js) read here. */
interface CompressedEntry {
  compressedContent: Uint8Array
  uncompressedSize: number
  compression: { magic: string }
}

function compressedOf(entry: JSZip.JSZipObject): CompressedEntry | null {
  const data = (entry as unknown as { _data?: Partial<CompressedEntry> })._data
  if (
    data === undefined ||
    !(data.compressedContent instanceof Uint8Array) ||
    typeof data.uncompressedSize !== 'number' ||
    typeof data.compression?.magic !== 'string'
  ) {
    return null
  }
  return data as CompressedEntry
}

/** The entry's compressed bytes as a Buffer view, when we can decode them natively. */
function nativeOf(entry: JSZip.JSZipObject): { c: CompressedEntry; content: Buffer } | null {
  const c = compressedOf(entry)
  if (c === null || (c.compression.magic !== STORE && c.compression.magic !== DEFLATE)) return null
  const raw = c.compressedContent
  const content = Buffer.isBuffer(raw)
    ? raw
    : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
  return { c, content }
}

export async function readEntryBytes(entry: JSZip.JSZipObject): Promise<Buffer> {
  const native = nativeOf(entry)
  if (native === null) return entry.async('nodebuffer')
  const { c, content } = native
  const out =
    c.compression.magic === STORE
      ? content
      : await inflateRawAsync(content, { maxOutputLength: Math.max(1, c.uncompressedSize) })
  if (out.byteLength !== c.uncompressedSize) {
    throw new Error(
      `Corrupted zip: "${entry.name}" inflates to ${out.byteLength} bytes, ${c.uncompressedSize} declared`,
    )
  }
  return out
}

/**
 * At least the first `n` bytes of the entry (fewer only when it is shorter),
 * without inflating the rest: enough to sniff a file's type from its magic
 * header. A DEFLATE entry is inflated from a prefix of its compressed bytes
 * with a sync flush, which yields everything that prefix decodes to.
 */
export async function readEntryHead(entry: JSZip.JSZipObject, n: number): Promise<Buffer> {
  const native = nativeOf(entry)
  if (native !== null) {
    const { c, content } = native
    if (c.compression.magic === STORE) return content.subarray(0, n)
    // A deflate block's header is at most a few hundred bytes; one KiB of
    // input almost always decodes past `n`, and can expand to ~1 MiB at most.
    for (const prefix of [1024, 64 * 1024]) {
      if (prefix >= content.byteLength) break
      let head: Buffer
      try {
        head = inflateRawSync(content.subarray(0, prefix), { finishFlush: constants.Z_SYNC_FLUSH })
      } catch {
        break // corrupt data: the full read below reports it as JSZip would
      }
      if (head.byteLength >= n) return head.subarray(0, n)
    }
  }
  return (await readEntryBytes(entry)).subarray(0, n)
}

/** The entry's declared uncompressed size, without reading it (0 when unknown). */
export function entrySize(entry: JSZip.JSZipObject): number {
  return compressedOf(entry)?.uncompressedSize ?? 0
}

/** The entry as UTF-8 text (what `entry.async('string')` returns). */
export async function readEntryText(entry: JSZip.JSZipObject): Promise<string> {
  return (await readEntryBytes(entry)).toString('utf8')
}
