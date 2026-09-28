/**
 * media/finalizeUpload.ts
 *
 * The one place an uploaded image, video or font becomes a media asset.
 * Runs against an object that is already in the bucket, and is shared by
 * the tus upload (media/tus.ts `onUploadFinish`) and the server-side upload
 * agents use (services/media.ts), so both get exactly the same checks:
 *
 *   - fonts: the whole file is parsed with opentype.js; a file that does not
 *     parse is rejected;
 *   - videos: a `pending` row is written and a transcode job enqueued;
 *   - images (XSS-3 defence in depth): anything that sniffs as SVG — declared
 *     `image/svg+xml` or an SVG renamed `.png` — is sanitised with DOMPurify
 *     and rewritten in place (or rejected when nothing usable survives); a
 *     declared raster whose magic bytes disagree is rejected; dimensions are
 *     probed; a raster above imgproxy's source limits is downscaled in its own
 *     format under the same key.
 *
 * A rejected upload never produces a `media_assets` row, and rejected image
 * bytes are deleted from the bucket.
 */

import { createRequire } from 'node:module'
import type { Readable } from 'node:stream'
import type { S3Client } from '@aws-sdk/client-s3'
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import type { Database } from '../db/client.js'
import { createMediaAsset } from './assets.js'
import { sanitizeSvg, sniffIsSvg, magicBytesMatch, MAGIC_CHECKED_MIMES } from './svgSanitize.js'
import { enqueueVideoTranscode } from './enqueue.js'
import { parseFontMetadata } from './fontMetadata.js'
import {
  canDownscaleStoredImage,
  downscaleForStorage,
  exceedsStoredImageLimits,
} from './storedImageLimits.js'
import { classifyUpload, isFontUpload, maxUploadBytes, tooLargeMessage } from './uploadPolicy.js'
import { MEDIA_BUCKET } from './s3Client.js'
import { subsystemLogger } from '../observability/logger.js'

const defaultLog = subsystemLogger('tus')

// probe-image-size is CommonJS — import via createRequire so ESM build works
const require = createRequire(import.meta.url)
const probe: (
  stream: Readable,
) => Promise<{ width: number; height: number } | null> = require('probe-image-size')

/** An upload the pipeline refused; `status` is the HTTP status to answer with. */
export class UploadRejected extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'UploadRejected'
    this.status = status
  }
}

interface MinimalLog {
  info: (obj: Record<string, unknown>, msg?: string) => void
  warn: (obj: Record<string, unknown>, msg?: string) => void
  error: (obj: Record<string, unknown>, msg?: string) => void
}

export interface FinalizeUploadArgs {
  db: Database
  s3: S3Client
  /** Bucket key of the stored bytes (server-constructed, never user input). */
  storageKey: string
  assetId: string
  deckId: string
  userId: string
  mimeType: string
  filename?: string | undefined
  /** Size of the stored object in bytes. */
  sizeBytes: number
  log?: MinimalLog
  /**
   * An agent's upload (a token, an upload session, media.upload): the bytes
   * must PROVE their type — an image its signature or readable dimensions,
   * a video its container signature — so an agent talked into it by deck
   * content cannot park arbitrary data (a key file) in a shared deck under
   * a media type nobody checks. A browser upload stays as lenient as ever.
   */
  strictContent?: boolean
}

/**
 * Whether the first bytes are a video container Narrative's transcoder
 * reads: ISO BMFF (MP4 / MOV / M4V / 3GP: a box type at offset 4), Matroska /
 * WebM (EBML), AVI (RIFF … AVI), MPEG program / elementary streams, Ogg.
 */
export function videoContainerMatches(bytes: Buffer): boolean {
  if (bytes.length < 12) return false
  const box = bytes.toString('latin1', 4, 8)
  if (['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(box)) return true
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return true
  if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'AVI ')
    return true
  if (
    bytes[0] === 0 &&
    bytes[1] === 0 &&
    bytes[2] === 1 &&
    (bytes[3] === 0xba || bytes[3] === 0xb3)
  )
    return true
  return bytes.toString('latin1', 0, 4) === 'OggS'
}

export type FinalizedUpload =
  | {
      kind: 'font'
      assetId: string
      storageKey: string
      mimeType: string
      sizeBytes: number
      fontFamily: string
      fontWeight: number
      fontStyle: string
      fontPostscriptName: string | null
    }
  | {
      kind: 'video'
      assetId: string
      storageKey: string
      mimeType: string
      sizeBytes: number
      transcodeStatus: 'pending'
    }
  | {
      kind: 'image'
      assetId: string
      storageKey: string
      mimeType: string
      sizeBytes: number
      width: number | null
      height: number | null
    }

/**
 * Read an object (or a byte range of it) into memory, refusing past
 * `maxBytes`: a stored object is only as small as its upload path made it,
 * and the whole API shares one process.
 */
async function readAll(
  s3: S3Client,
  storageKey: string,
  maxBytes: number,
  range?: string,
): Promise<Buffer> {
  const obj = await s3.send(
    new GetObjectCommand({
      Bucket: MEDIA_BUCKET,
      Key: storageKey,
      ...(range !== undefined ? { Range: range } : {}),
    }),
  )
  if (!obj.Body) throw new Error(`S3 returned empty body for ${storageKey}`)
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of obj.Body as Readable) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer)
    total += buf.byteLength
    if (total > maxBytes) {
      ;(obj.Body as Readable).destroy?.()
      throw new UploadRejected(413, `The stored file is larger than ${maxBytes} bytes.`)
    }
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

async function deleteQuietly(s3: S3Client, storageKey: string, log: MinimalLog): Promise<void> {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: MEDIA_BUCKET, Key: storageKey }))
  } catch (err) {
    log.warn({ storageKey, err }, 'DeleteObject failed')
  }
}

/**
 * Reads the first 64 KB of the object and probes image dimensions.
 * Returns undefined if the probe fails (non-fatal — the row is inserted without dims).
 */
async function probeImageDimensions(
  s3: S3Client,
  storageKey: string,
  log: MinimalLog,
): Promise<{ width: number; height: number } | undefined> {
  try {
    const response = await s3.send(
      new GetObjectCommand({ Bucket: MEDIA_BUCKET, Key: storageKey, Range: 'bytes=0-65535' }),
    )
    if (!response.Body) return undefined
    const result = await probe(response.Body as Readable)
    if (!result) return undefined
    return { width: result.width, height: result.height }
  } catch (err) {
    log.warn({ storageKey, err }, 'image probe failed')
    return undefined
  }
}

export async function finalizeMediaUpload(args: FinalizeUploadArgs): Promise<FinalizedUpload> {
  const { db, s3, storageKey, assetId, deckId, userId, mimeType, filename } = args
  const log = args.log ?? defaultLog
  let sizeBytes = args.sizeBytes

  // The per-kind size cap, on the size the store reports — whatever the
  // upload path checked before (a deferred length, say), nothing larger is
  // parsed, sanitised or kept.
  const kind = classifyUpload(mimeType, filename)
  if (kind === null) {
    await deleteQuietly(s3, storageKey, log)
    throw new UploadRejected(415, `Unsupported media type: ${mimeType}.`)
  }
  const cap = maxUploadBytes(kind)
  if (sizeBytes > cap) {
    await deleteQuietly(s3, storageKey, log)
    throw new UploadRejected(413, tooLargeMessage(kind))
  }

  if (isFontUpload(mimeType, filename)) {
    // Font branch: fetch the bytes, parse OpenType metadata, insert row.
    // We READ the full file (TTF/OTF are typically <2 MB; the size cap is
    // 8 MB) so opentype.js can walk the tables. If parsing fails the upload
    // is rejected and the object stays orphaned for the M29 GC sweep.
    let metadata
    try {
      const buf = await readAll(s3, storageKey, cap)
      // Pass an ArrayBuffer slice so opentype gets exactly the byte range
      // it expects (Buffer's underlying ArrayBuffer may be larger).
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
      metadata = parseFontMetadata(ab as ArrayBuffer)
    } catch (err) {
      log.error({ err }, 'parseFontMetadata failed')
      throw new UploadRejected(400, `Failed to parse font file. Make sure it's a valid TTF or OTF.`)
    }

    try {
      await createMediaAsset(db, {
        id: assetId,
        deckId,
        uploaderUserId: userId,
        mimeType,
        sizeBytes,
        storageKey,
        ...(filename !== undefined ? { originalFilename: filename } : {}),
        kind: 'font',
        fontFamily: metadata.family,
        fontWeight: metadata.weight,
        fontStyle: metadata.style,
        fontPostscriptName: metadata.postscriptName,
      })
    } catch (err) {
      log.error({ err }, 'createMediaAsset (font) failed')
      throw new UploadRejected(500, 'Failed to persist font asset metadata')
    }

    return {
      kind: 'font',
      assetId,
      storageKey,
      mimeType,
      sizeBytes,
      fontFamily: metadata.family,
      fontWeight: metadata.weight,
      fontStyle: metadata.style,
      fontPostscriptName: metadata.postscriptName,
    }
  }

  if (mimeType.startsWith('video/')) {
    if (args.strictContent === true) {
      let head: Buffer
      try {
        head = await readAll(s3, storageKey, 65_536, 'bytes=0-65535')
      } catch (err) {
        log.error({ err }, 'video content read failed')
        await deleteQuietly(s3, storageKey, log)
        throw new UploadRejected(400, 'Failed to read the uploaded video for validation.')
      }
      if (!videoContainerMatches(head)) {
        await deleteQuietly(s3, storageKey, log)
        throw new UploadRejected(415, `Upload rejected: the file is not a ${mimeType} video.`)
      }
    }
    // Video branch: create asset row with pending transcode status, enqueue job.
    try {
      await createMediaAsset(db, {
        id: assetId,
        deckId,
        uploaderUserId: userId,
        mimeType,
        sizeBytes,
        storageKey,
        ...(filename !== undefined ? { originalFilename: filename } : {}),
        // width/height left null — worker fills them after ffprobe
        kind: 'video',
        transcodeStatus: 'pending',
      })
    } catch (err) {
      log.error({ err }, 'createMediaAsset (video) failed')
      throw new UploadRejected(500, 'Failed to persist video asset metadata')
    }

    try {
      await enqueueVideoTranscode({ assetId, deckId, storageKey, uploaderUserId: userId, mimeType })
    } catch (err) {
      log.error({ err }, 'enqueueVideoTranscode failed')
      // Asset row already exists — log the failure but don't rollback.
      // Operator can re-enqueue manually. Do not fail the upload response.
    }

    return { kind: 'video', assetId, storageKey, mimeType, sizeBytes, transcodeStatus: 'pending' }
  }

  // Image branch: validate content, then probe dimensions + insert row.
  // This runs BEFORE the media_assets row is created, so a rejected upload
  // never produces a DB record (and the stored object is deleted).
  {
    let headBytes: Buffer
    try {
      // First ~64 KB is enough to sniff SVG/XML and any raster signature.
      headBytes = await readAll(s3, storageKey, 65_536, 'bytes=0-65535')
    } catch (err) {
      log.error({ err }, 'image content read failed')
      await deleteQuietly(s3, storageKey, log)
      throw new UploadRejected(400, 'Failed to read uploaded image for validation.')
    }

    const declaredMime = mimeType.toLowerCase()
    const looksSvg = declaredMime === 'image/svg+xml' || sniffIsSvg(headBytes)

    if (looksSvg) {
      // Sanitize the FULL object (not just the 64 KB head) so we never
      // truncate a large legitimate SVG. Re-read in full.
      let fullBytes: Buffer
      try {
        fullBytes = await readAll(s3, storageKey, cap)
      } catch (err) {
        log.error({ err }, 'SVG full read failed')
        await deleteQuietly(s3, storageKey, log)
        throw new UploadRejected(400, 'Failed to read uploaded SVG for sanitization.')
      }

      const cleaned = sanitizeSvg(fullBytes)
      if (!cleaned) {
        await deleteQuietly(s3, storageKey, log)
        throw new UploadRejected(400, 'SVG rejected: no valid graphic content after sanitization.')
      }

      // Only rewrite when sanitization actually changed the bytes.
      if (!cleaned.equals(fullBytes)) {
        try {
          await s3.send(
            new PutObjectCommand({
              Bucket: MEDIA_BUCKET,
              Key: storageKey,
              Body: cleaned,
              ContentType: 'image/svg+xml',
            }),
          )
          sizeBytes = cleaned.byteLength
        } catch (err) {
          log.error({ err }, 'sanitized SVG PutObject failed')
          await deleteQuietly(s3, storageKey, log)
          throw new UploadRejected(500, 'Failed to store sanitized SVG.')
        }
      }
    } else if (MAGIC_CHECKED_MIMES.has(declaredMime) && !magicBytesMatch(declaredMime, headBytes)) {
      // Declared a raster type whose actual signature disagrees — reject.
      await deleteQuietly(s3, storageKey, log)
      throw new UploadRejected(
        400,
        `Upload rejected: file content does not match declared type ${mimeType}.`,
      )
    }
  }

  // Probe image dimensions (non-fatal if probe fails)
  let dims = await probeImageDimensions(s3, storageKey, log)
  if (!dims) {
    log.warn({ storageKey }, 'probe-image-size returned no result')
    // Non-fatal for a browser upload: SVGs and some exotic formats may not
    // probe; insert row without dims. An agent's raster must prove it is an
    // image: a checked signature (above) or readable dimensions.
    const declared = mimeType.toLowerCase()
    const provenRaster = MAGIC_CHECKED_MIMES.has(declared)
    if (args.strictContent === true && declared !== 'image/svg+xml' && !provenRaster) {
      await deleteQuietly(s3, storageKey, log)
      throw new UploadRejected(
        415,
        `Upload rejected: the file could not be read as a ${mimeType} image.`,
      )
    }
  }

  // A raster above imgproxy's source limit would never render (imgproxy
  // answers 422), so it is brought under the limit now, in its own
  // format, under the same key — see storedImageLimits.ts. The head probe
  // above decides; only an oversize image pays for the full read. A
  // failed downscale keeps the original rather than losing the upload.
  if (
    dims !== undefined &&
    exceedsStoredImageLimits(dims.width, dims.height) &&
    canDownscaleStoredImage(mimeType)
  ) {
    try {
      const downscaled = await downscaleForStorage(await readAll(s3, storageKey, cap), mimeType)
      if (downscaled !== null) {
        await s3.send(
          new PutObjectCommand({
            Bucket: MEDIA_BUCKET,
            Key: storageKey,
            Body: downscaled.bytes,
            ContentType: mimeType,
          }),
        )
        log.info(
          {
            storageKey,
            fromBytes: sizeBytes,
            toBytes: downscaled.bytes.byteLength,
            from: dims,
            to: { width: downscaled.width, height: downscaled.height },
          },
          'downscaled oversize image to the stored-image limits',
        )
        sizeBytes = downscaled.bytes.byteLength
        dims = { width: downscaled.width, height: downscaled.height }
      }
    } catch (err) {
      log.error({ err, storageKey }, 'downscaling an oversize image failed, keeping original')
    }
  }

  try {
    await createMediaAsset(db, {
      id: assetId,
      deckId,
      uploaderUserId: userId,
      mimeType,
      sizeBytes,
      storageKey,
      ...(filename !== undefined ? { originalFilename: filename } : {}),
      ...(dims !== undefined ? { width: dims.width, height: dims.height } : {}),
      kind: 'image',
    })
  } catch (err) {
    log.error({ err }, 'createMediaAsset failed')
    throw new UploadRejected(500, 'Failed to persist media asset metadata')
  }

  return {
    kind: 'image',
    assetId,
    storageKey,
    mimeType,
    sizeBytes,
    width: dims?.width ?? null,
    height: dims?.height ?? null,
  }
}
