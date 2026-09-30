/**
 * video-queue.ts
 *
 * Shared BullMQ queue name and job data types for the video transcode pipeline.
 * Imported by both apps/server (enqueue) and apps/video-worker (consume).
 *
 * Kept in @narrative/shared so neither app depends on the other directly.
 */

export const VIDEO_TRANSCODE_QUEUE = 'video-transcode'

export interface VideoTranscodeJobData {
  /** media_assets row id (nanoid 16) */
  assetId: string
  /**
   * The deck the video belongs to. Absent for a component master's video
   * (A2.12b): the worker derives where its outputs go from `storageKey`
   * (`videoOutputPrefix`), and uses this only as the fallback of a key that
   * names no owner.
   */
  deckId?: string | undefined
  /**
   * Original upload key in MinIO. Either a plain path
   * (`decks/<deckId>/uploads/<assetId>/original.mp4`,
   * `components/<componentId>/uploads/<assetId>/original.mp4`) or — for a
   * tus upload — the compound upload id `<assetId>:<deckId|unknown>:<base64url(path)>`
   * that @tus/s3-store keys the object by.
   */
  storageKey: string
  uploaderUserId: string
  mimeType: string
}

export interface VideoTranscodeResult {
  assetId: string
  /** <owner prefix>/videos/<assetId>/poster.jpg */
  posterKey: string
  /** <owner prefix>/videos/<assetId>/thumb.jpg */
  thumbnailKey: string
  /** <owner prefix>/videos/<assetId>/playback.mp4 (progressive faststart MP4) */
  playbackKey: string
  durationSec: number
  width: number
  height: number
}

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/**
 * Decodes a base64url string holding ASCII (a storage path), or null when it
 * is not valid base64url. Hand-rolled because this package targets plain
 * ES2022 (no `Buffer`, no `atob` in its lib) and is shared with the browser.
 */
function decodeBase64UrlAscii(input: string): string | null {
  if (input === '' || input.length % 4 === 1) return null
  let bits = 0
  let bitCount = 0
  let out = ''
  for (const ch of input) {
    const value = BASE64URL_ALPHABET.indexOf(ch)
    if (value === -1) return null
    bits = (bits << 6) | value
    bitCount += 6
    if (bitCount >= 8) {
      bitCount -= 8
      const code = (bits >> bitCount) & 0xff
      // Storage paths are server-built ASCII; anything else is not one.
      if (code < 0x20 || code > 0x7e) return null
      out += String.fromCharCode(code)
    }
  }
  return out
}

/** The owner prefix (`decks/<id>` / `components/<id>`) a plain storage path starts with, else null. */
function ownerPrefixOfPath(path: string): string | null {
  const [root, id] = path.split('/')
  if (
    (root === 'decks' || root === 'components') &&
    id !== undefined &&
    id !== '' &&
    id !== '.' &&
    id !== '..'
  ) {
    return `${root}/${id}`
  }
  return null
}

/**
 * Where the transcoder writes a video's outputs: `<owner prefix>/videos/<assetId>`,
 * the owner prefix being the first two segments of the upload's storage path
 * (`decks/<deckId>` or `components/<componentId>`). A tus upload's key is the
 * compound upload id, whose third field is the base64url of that path. A key
 * that names no owner falls back to `decks/<deckId>`; with no deckId either
 * there is nowhere sound to write, and this throws.
 */
export function videoOutputPrefix(
  job: Pick<VideoTranscodeJobData, 'assetId' | 'deckId' | 'storageKey'>,
): string {
  const { assetId, deckId, storageKey } = job
  let owner = ownerPrefixOfPath(storageKey)
  if (owner === null) {
    const parts = storageKey.split(':')
    if (parts.length === 3 && parts[2] !== undefined) {
      const path = decodeBase64UrlAscii(parts[2])
      if (path !== null) owner = ownerPrefixOfPath(path)
    }
  }
  if (owner === null && deckId !== undefined && deckId !== '') owner = `decks/${deckId}`
  if (owner === null) {
    throw new Error(
      `Cannot tell where the outputs of video ${assetId} go: its storage key names no deck or component and the job has no deckId`,
    )
  }
  return `${owner}/videos/${assetId}`
}
