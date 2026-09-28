/**
 * media/uploadPolicy.ts
 *
 * What a media upload may be: the accepted kinds, their size limits, and
 * how a MIME type / filename maps to a kind and a storage extension. ONE
 * definition for every way bytes enter the media library — the tus upload
 * (media/tus.ts) and the server-side upload agents use (services/media.ts)
 * — so an agent can never upload something a browser could not.
 */

/** Max size for font uploads. */
export const MAX_FONT_UPLOAD_SIZE = Number(process.env['MAX_FONT_UPLOAD_SIZE'] ?? 8_000_000)
/** Max size for image uploads. */
export const MAX_IMAGE_UPLOAD_SIZE = Number(process.env['MAX_UPLOAD_SIZE'] ?? 25_000_000)
/** Max size for video uploads. */
export const MAX_VIDEO_UPLOAD_SIZE = Number(process.env['MAX_VIDEO_UPLOAD_SIZE'] ?? 500_000_000)
/**
 * Max size for `.pptx` imports. Default 2 GB (kept high by product
 * requirement — large decks must import). The pptx path doesn't create a
 * `media_assets` row; instead the `onUploadFinish` hook runs the full
 * deck-import pipeline against the freshly-uploaded blob. DoS protection
 * comes from the parser's decompression-bomb guard (`assertNotZipBomb`),
 * which rejects pathological archives without limiting legitimate large
 * files — not from this on-the-wire cap.
 */
export const MAX_PPTX_UPLOAD_SIZE = Number(
  process.env['MAX_PPTX_UPLOAD_SIZE'] ?? 2 * 1024 * 1024 * 1024,
)

export const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

/**
 * P15: classifies an upload as a font from its MIME or filename
 * extension. Browsers send wildly inconsistent MIME for fonts —
 * `font/ttf`, `font/otf`, `font/sfnt` (modern, RFC 8081), the legacy
 * `application/x-font-*` family, and `application/octet-stream` when
 * they don't know better. We accept all of them, but require a
 * .ttf / .otf filename extension as a sanity gate when the MIME is
 * generic.
 */
export const FONT_MIME_TYPES = new Set([
  'font/ttf',
  'font/otf',
  'font/sfnt',
  'font/collection',
  'application/font-ttf',
  'application/font-otf',
  'application/font-sfnt',
  'application/x-font-ttf',
  'application/x-font-otf',
  'application/x-font-opentype',
  'application/x-font-truetype',
  'application/vnd.ms-opentype',
])

export function isFontUpload(mime: string, filename?: string): boolean {
  const m = mime.toLowerCase()
  if (FONT_MIME_TYPES.has(m)) return true
  // Browsers on Windows commonly report file.type as '' for .ttf/.otf
  // because the OS lacks a MIME registry entry. Accept empty / generic
  // MIME when the filename has a font extension.
  const isGenericMime = m === '' || m === 'application/octet-stream'
  if (isGenericMime && filename) {
    const lower = filename.toLowerCase()
    return lower.endsWith('.ttf') || lower.endsWith('.otf')
  }
  return false
}

export type UploadKind = 'image' | 'video' | 'font'

/** The media kind an upload is, or null when it is not accepted at all. */
export function classifyUpload(mime: string, filename?: string): UploadKind | null {
  const m = mime.toLowerCase()
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('video/')) return 'video'
  if (isFontUpload(m, filename)) return 'font'
  return null
}

/** The size limit of an upload kind, in bytes. */
export function maxUploadBytes(kind: UploadKind): number {
  if (kind === 'image') return MAX_IMAGE_UPLOAD_SIZE
  if (kind === 'video') return MAX_VIDEO_UPLOAD_SIZE
  return MAX_FONT_UPLOAD_SIZE
}

/** The limit named in the rejection message of an oversize upload. */
export function tooLargeMessage(kind: UploadKind): string {
  const label = kind === 'image' ? 'Image' : kind === 'video' ? 'Video' : 'Font'
  return `${label} upload exceeds maximum size of ${maxUploadBytes(kind)} bytes.`
}

/**
 * What a storage-key extension may look like. The extension ends up in S3
 * keys (`decks/<id>/uploads/<asset>/original.<ext>`), in imgproxy source
 * URLs and in `Content-Disposition`-less downloads, so a client-chosen
 * filename must not be able to put slashes, dots, `%`, spaces, control
 * characters or anything long in there.
 */
const SAFE_EXTENSION_RE = /^[a-z0-9]{1,8}$/

/** MIME types of the media extensions an upload may carry, by lower-case extension. */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  bmp: 'image/bmp',
  heic: 'image/heic',
  heif: 'image/heif',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  '3gp': 'video/3gpp',
  ogv: 'video/ogg',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
}

/** The MIME type a media filename's extension names, or null for an unknown extension. */
export function mimeFromFilename(filename: string): string | null {
  const dot = filename.lastIndexOf('.')
  if (dot === -1) return null
  return MIME_BY_EXTENSION[filename.slice(dot + 1).toLowerCase()] ?? null
}

/**
 * Derives a file extension from a MIME type or filename. Always returns a
 * value matching SAFE_EXTENSION_RE: the MIME map's own values do, and a
 * filename-derived extension that does not becomes `bin`.
 */
export function extensionFromMimeOrFilename(mime: string, filename?: string): string {
  const mimeMap: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/avif': 'avif',
    'image/svg+xml': 'svg',
    'image/tiff': 'tiff',
    'image/bmp': 'bmp',
    'image/heic': 'heic',
    'image/heif': 'heif',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
    'video/x-msvideo': 'avi',
    'video/x-matroska': 'mkv',
    'video/mpeg': 'mpg',
    'video/3gpp': '3gp',
    'video/ogg': 'ogv',
    // P15 fonts — preserve the filename extension when possible so
    // browsers don't choke on a generic .bin extension via @font-face.
    'font/ttf': 'ttf',
    'font/otf': 'otf',
    'font/sfnt': 'ttf',
    'application/font-ttf': 'ttf',
    'application/font-otf': 'otf',
    'application/x-font-ttf': 'ttf',
    'application/x-font-otf': 'otf',
    'application/x-font-opentype': 'otf',
    'application/x-font-truetype': 'ttf',
    'application/vnd.ms-opentype': 'otf',
    [PPTX_MIME]: 'pptx',
  }

  const fromMime = mimeMap[mime.toLowerCase()]
  if (fromMime) return fromMime

  if (filename) {
    const lastDot = filename.lastIndexOf('.')
    if (lastDot !== -1) {
      const ext = filename.slice(lastDot + 1).toLowerCase()
      if (SAFE_EXTENSION_RE.test(ext)) return ext
    }
  }

  return 'bin'
}

/**
 * What the bytes say they are, from their signature — independent of any
 * declared MIME type. Covers the kinds Narrative accepts; null when the
 * signature is not one of them (the declared type then decides, and the
 * finalize step still magic-checks declared rasters).
 */
export function sniffMime(bytes: Uint8Array): string | null {
  const b = bytes
  const at = (i: number): number => b[i] ?? -1
  const ascii = (from: number, len: number): string =>
    String.fromCharCode(...Array.from(b.subarray(from, from + len)))
  if (at(0) === 0x89 && ascii(1, 3) === 'PNG') return 'image/png'
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg'
  if (ascii(0, 4) === 'GIF8') return 'image/gif'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp'
  if (ascii(4, 4) === 'ftyp') {
    const brand = ascii(8, 4)
    if (brand === 'avif' || brand === 'avis') return 'image/avif'
    if (brand === 'heic' || brand === 'heix' || brand === 'mif1') return 'image/heic'
    if (brand === 'qt  ') return 'video/quicktime'
    return 'video/mp4'
  }
  if (at(0) === 0x1a && at(1) === 0x45 && at(2) === 0xdf && at(3) === 0xa3) return 'video/webm'
  if (at(0) === 0x00 && at(1) === 0x01 && at(2) === 0x00 && at(3) === 0x00) return 'font/ttf'
  if (ascii(0, 4) === 'OTTO') return 'font/otf'
  if (ascii(0, 4) === 'true') return 'font/ttf'
  if (ascii(0, 4) === 'ttcf') return 'font/collection'
  if (ascii(0, 4) === 'wOFF') return 'font/woff'
  if (ascii(0, 4) === 'wOF2') return 'font/woff2'
  // SVG: an XML / <svg prolog in the first bytes (media/svgSanitize sniffs precisely).
  const head = ascii(0, Math.min(b.length, 512)).trimStart().toLowerCase()
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) {
    return 'image/svg+xml'
  }
  return null
}
