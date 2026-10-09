/**
 * services/binarySource.ts
 *
 * Turn a `BinarySource` (a URL, inline base64, or bytes a route received)
 * into a file the caller can read, never reading more than the caller's
 * limit. The returned `mimeType` is a hint (declared by the caller or the
 * remote server) — callers validate the bytes themselves, exactly as they
 * validate a browser upload.
 *
 * Limits come in two tiers:
 *   - `maxBytes` applies to bytes a route has ALREADY received through its
 *     own upload path (the synchronous .pptx import route, the multipart
 *     font route). Those limits are the product's upload limits (up to 2 GB
 *     for a .pptx).
 *   - `maxRemoteBytes` applies to what the server fetches or decodes on a
 *     caller's behalf: a URL, or inline base64. It is much lower (200 MB for
 *     a .pptx or a video, 25 MB for an image), because every such byte is
 *     the server's cost, not a resumable upload the client pays for; files
 *     larger than that go through the tus upload.
 *
 * How each source is held:
 *   - URL: streamed through the SSRF guard (net/ssrfGuard.ts) into a file in
 *     a private temporary directory (`os.tmpdir()`), which is removed when
 *     the caller's callback settles — a large download never sits in the
 *     heap, and callers that can stream (S3 uploads) never load it at all.
 *     Each user has at most two URL downloads in flight
 *     (services/downloadSlots.ts); a third is refused with `conflict`.
 *   - base64: validated strictly and its decoded size checked BEFORE
 *     decoding; the string is already in memory as part of the request, so
 *     the decoded bytes stay in memory too (bounded by the command schema's
 *     64 MiB base64 limit and by `maxRemoteBytes`).
 *   - bytes: used as they are.
 */

import { createReadStream } from 'node:fs'
import { mkdtempDisposable, open, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { BinarySource } from '@narrative/commands'
import { FetchFailedError, UnsafeUrlError, guardedDownloadToFile } from '../net/ssrfGuard.js'
import { ServiceError, badRequest, tooLarge } from './errors.js'
import { acquireDownloadSlot } from './downloadSlots.js'

/** Deadline for a URL download that may be large (a .pptx or a video, up to 200 MB). */
export const LARGE_DOWNLOAD_TIMEOUT_MS = 120_000
/** Deadline for other URL downloads (images, fonts). */
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30_000

/** Prefix of the temporary directories URL downloads land in (under `os.tmpdir()`). */
export const DOWNLOAD_TMP_PREFIX = 'narrative-download-'

/** A resolved source, readable in the ways its consumers need. */
export interface BinaryFile {
  sizeBytes: number
  /** Declared type (lower-cased, no parameters), or '' when nobody declared one. */
  mimeType: string
  filename: string | undefined
  /** At most the first `n` bytes (for signature sniffing). */
  head(n: number): Promise<Buffer>
  /** The whole file in memory — for consumers that need a Buffer (zip parsing, font parsing). */
  readAll(): Promise<Buffer>
  /** A fresh stream of the whole file — for consumers that can stream (S3 uploads). */
  stream(): Readable
}

export interface ResolvedBinary {
  bytes: Buffer
  /** Declared type (lower-cased, no parameters), or '' when nobody declared one. */
  mimeType: string
  filename: string | undefined
}

export interface BinarySourceOptions {
  /** Whose request this is: URL downloads are limited per user. */
  userId: string
  /** Limit for bytes a route already received (`kind: 'bytes'`). */
  maxBytes: number
  /** Limit for URL and base64 sources. Defaults to `maxBytes`. */
  maxRemoteBytes?: number
  what?: string
  /** The 413 message for received bytes of a known size (defaults to a generic one). */
  tooLargeMessage?: (sizeBytes: number) => string
  /** Deadline of a URL download. Default `DEFAULT_DOWNLOAD_TIMEOUT_MS`. */
  timeoutMs?: number
}

const BASE64_BODY = /^[A-Za-z0-9+/]*={0,2}$/
const BASE64URL_BODY = /^[A-Za-z0-9_-]*={0,2}$/

function normaliseMime(mime: string | null | undefined): string {
  return (mime ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
}

/** Decoded length of a base64 body without decoding it. */
function decodedLength(body: string): number {
  const padding = body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0
  return Math.floor((body.length * 3) / 4) - padding
}

function decodeBase64(
  data: string,
  maxBytes: number,
  what: string,
): { bytes: Buffer; mime: string } {
  let body = data.trim()
  let mime = ''
  const dataUrl = /^data:([^;,]*)(;[^,]*)?,/i.exec(body)
  if (dataUrl !== null) {
    if (!(dataUrl[2] ?? '').toLowerCase().includes(';base64')) {
      throw badRequest(`${what}: a data: URL must be base64-encoded`)
    }
    mime = normaliseMime(dataUrl[1])
    body = body.slice(dataUrl[0].length)
  }
  body = body.replace(/\s+/g, '')
  const standard = BASE64_BODY.test(body)
  if (!standard && !BASE64URL_BODY.test(body)) {
    throw badRequest(`${what}: not valid base64`)
  }
  if (decodedLength(body) > maxBytes) {
    throw tooLarge(
      `${what} is larger than the limit of ${maxBytes} bytes for inline base64; ` +
        'upload larger files with the tus upload instead',
    )
  }
  const bytes = Buffer.from(body, standard ? 'base64' : 'base64url')
  if (bytes.byteLength === 0) throw badRequest(`${what} is empty`)
  return { bytes, mime }
}

function memoryFile(bytes: Buffer, mimeType: string, filename: string | undefined): BinaryFile {
  return {
    sizeBytes: bytes.byteLength,
    mimeType,
    filename,
    head: async (n) => bytes.subarray(0, Math.max(0, n)),
    readAll: async () => bytes,
    stream: () => Readable.from([bytes]),
  }
}

function diskFile(
  filePath: string,
  sizeBytes: number,
  mimeType: string,
  filename: string | undefined,
): BinaryFile {
  return {
    sizeBytes,
    mimeType,
    filename,
    async head(n) {
      await using handle = await open(filePath, 'r')
      const buf = Buffer.alloc(Math.max(0, Math.min(n, sizeBytes)))
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
      return buf.subarray(0, bytesRead)
    },
    readAll: () => readFile(filePath),
    stream: () => createReadStream(filePath),
  }
}

/** A download failure as the service answers it. */
function downloadError(err: unknown, what: string): unknown {
  if (err instanceof ServiceError) return err
  if (err instanceof UnsafeUrlError) return badRequest(`URL not allowed: ${err.message}`)
  if (err instanceof FetchFailedError) {
    if (err.tooLarge) {
      return tooLarge(
        `${what}: ${err.message} for a URL download; upload larger files with the tus upload instead`,
      )
    }
    return new ServiceError('failed', 502, `Could not download the URL: ${err.message}`)
  }
  return err
}

/**
 * Resolve `source` and hand it to `fn`. A URL is downloaded into a private
 * temporary directory that is removed, and the user's download slot freed,
 * when `fn` settles — so `fn` must finish reading the file before it
 * returns. Throws `ServiceError`: 400 for a malformed source or a URL the
 * guard refuses, 409 when the user already has two URL downloads in flight,
 * 413 when too large, 502 when the download fails.
 */
export async function withBinarySource<T>(
  source: BinarySource,
  opts: BinarySourceOptions,
  fn: (file: BinaryFile) => Promise<T>,
): Promise<T> {
  const what = opts.what ?? 'the file'
  const maxRemoteBytes = opts.maxRemoteBytes ?? opts.maxBytes

  if (source.kind === 'bytes') {
    const bytes = Buffer.from(source.bytes.buffer, source.bytes.byteOffset, source.bytes.byteLength)
    if (bytes.byteLength === 0) throw badRequest(`${what} is empty`)
    if (bytes.byteLength > opts.maxBytes) {
      throw tooLarge(
        opts.tooLargeMessage?.(bytes.byteLength) ??
          `${what} is ${bytes.byteLength} bytes; the limit is ${opts.maxBytes}`,
      )
    }
    return fn(memoryFile(bytes, normaliseMime(source.mimeType), source.filename))
  }

  if (source.kind === 'base64') {
    const { bytes, mime } = decodeBase64(source.data, maxRemoteBytes, what)
    return fn(memoryFile(bytes, normaliseMime(source.mimeType) || mime, source.filename))
  }

  // Both are disposed when `fn` settles or anything before it throws, in
  // reverse order: the directory — runtime scratch this function created
  // itself, removed outright, never kept — then the slot, which is freed
  // also when removing the directory fails.
  using _slot = acquireDownloadSlot(opts.userId)
  await using dir = await mkdtempDisposable(path.join(os.tmpdir(), DOWNLOAD_TMP_PREFIX))
  const target = path.join(dir.path, 'download')
  let file: BinaryFile
  try {
    const fetched = await guardedDownloadToFile(source.url, target, {
      maxBytes: maxRemoteBytes,
      timeoutMs: opts.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS,
    })
    if (fetched.sizeBytes === 0) throw badRequest(`${what} at the URL is empty`)
    file = diskFile(
      target,
      fetched.sizeBytes,
      normaliseMime(source.mimeType) || normaliseMime(fetched.contentType),
      source.filename ?? fetched.filename ?? undefined,
    )
  } catch (err) {
    throw downloadError(err, what)
  }
  // `await` keeps the scope open until `fn` has finished reading the file.
  return await fn(file)
}

/**
 * Resolve a source to at most the applicable limit of bytes, in memory. For
 * consumers that need a Buffer anyway (zip and font parsing); a URL still
 * streams to a temporary file first, so the download itself holds no
 * growing chunk list, and the file is read back in one allocation.
 */
export async function resolveBinarySource(
  source: BinarySource,
  opts: BinarySourceOptions,
): Promise<ResolvedBinary> {
  return withBinarySource(source, opts, async (file) => ({
    bytes: await file.readAll(),
    mimeType: file.mimeType,
    filename: file.filename,
  }))
}
