/**
 * media/imgproxyUrl.ts
 *
 * Signs imgproxy URLs using the HMAC-SHA256 algorithm documented at:
 * https://docs.imgproxy.net/signing_the_url
 *
 * Signature = base64url(HMAC-SHA256(hex(salt) || path, hex(key)))
 * where path = "/" + processing + "/plain/" + sourceUrl + "@" + extension
 *
 * Both IMGPROXY_KEY and IMGPROXY_SALT are hex-encoded strings decoded to Buffer
 * before the HMAC computation.
 *
 * Source URL format: s3://{bucket}/{storageKey}
 * imgproxy understands this when IMGPROXY_USE_S3=true.
 *
 * Variant → processing mapping:
 *   thumb   → rs:fill:400:225:0/g:ce  (400×225 cover crop, center gravity)
 *   preview → rs:fit:600:600:0        (fit inside 600×600, preserve aspect)
 *   display → rs:fit:2560:2560:0      (fit inside 2560×2560, preserve aspect)
 *   original → (no resize directive)
 *
 * The trailing `0` on every `rs:fit` is imgproxy's `enlarge` flag = OFF:
 * these dimensions are a CEILING, never a target. A source smaller than
 * the cap is served at its native size — imgproxy never upscales, so a
 * 800 px logo stays 800 px (no wasted bytes, no fake detail).
 *
 * `display` is capped at 2560 px (not the slide's native 1920) so a
 * full-bleed image stays crisp on HiDPI / retina screens and under
 * editor zoom, where the canvas rasterises at devicePixelRatio × zoom.
 *
 * Output format defaults to AVIF (see `extension` below) — ~30-50%
 * smaller than WebP at equal quality, and universally supported by the
 * current-Chrome target. The 2560 cap costs ~2.5× the pixels of the old
 * 1600 cap, but AVIF claws most of that back, so a cold transfer is only
 * modestly heavier than before while looking far sharper.
 *
 * `thumb` exists for the deck-grid + component-master tiles where the
 * tile geometry is uniform 16:9 and the source has already been
 * rendered to that aspect — there the center-crop is the right call.
 *
 * `preview` is for per-object thumbnails inside the slides panel:
 * arbitrary-aspect source images that must mirror the editor view,
 * just at a smaller resolution. Aspect-preserving + 600 px on the
 * long side covers the 200 CSS-px slide-panel default plus comfortable
 * headroom for 2-3× DPR and user-resized panels, while staying
 * comparable in bandwidth to `thumb`. Source textures above ~600 px
 * are wasted pixels — Pixi downscales them into ~50-200 px regions
 * of the 200×113 thumbnail PNG.
 */

import { createHmac } from 'node:crypto'

export type ImgproxyVariant = 'thumb' | 'preview' | 'display' | 'original'

export interface SignImgproxyUrlArgs {
  /** S3 key relative to the bucket (no leading slash). */
  storageKey: string
  /** Which variant preset to use. Default: 'display'. */
  variant?: ImgproxyVariant
  /** Absolute imgproxy base URL, no trailing slash. Default: env IMGPROXY_ENDPOINT. */
  baseUrl?: string
  /** Output format extension. Default: 'avif'. */
  extension?: 'avif' | 'webp' | 'jpg' | 'png'
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Decodes a hex string to a Buffer.
 * Throws if the string contains non-hex characters.
 */
function hexToBuffer(hex: string): Buffer {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error(`[imgproxy] Invalid hex string (length=${hex.length})`)
  }
  return Buffer.from(hex, 'hex')
}

/** Maps variant name to imgproxy processing directive segment. */
function processingForVariant(variant: ImgproxyVariant): string {
  switch (variant) {
    case 'thumb':
      return 'rs:fill:400:225:0/g:ce'
    case 'preview':
      return 'rs:fit:600:600:0'
    case 'display':
      return 'rs:fit:2560:2560:0'
    case 'original':
      return ''
    default: {
      // exhaustive check
      const _never: never = variant
      throw new Error(`[imgproxy] Unknown variant: ${String(_never)}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns a signed imgproxy URL for the given storageKey + variant.
 *
 * URL structure (imgproxy docs):
 *   {baseUrl}/{signature}/{processing}/plain/{sourceUrl}@{extension}
 *
 * The `processing` segment is omitted entirely for the 'original' variant
 * to avoid an empty path component.
 */
export function signImgproxyUrl(args: SignImgproxyUrlArgs): string {
  const { storageKey, variant = 'display', extension = 'avif' } = args

  const baseUrl = args.baseUrl ?? process.env['IMGPROXY_ENDPOINT'] ?? 'http://localhost:8080'

  const keyHex = process.env['IMGPROXY_KEY'] ?? ''
  const saltHex = process.env['IMGPROXY_SALT'] ?? ''

  const key = hexToBuffer(keyHex)
  const salt = hexToBuffer(saltHex)

  const bucket = process.env['MEDIA_BUCKET'] ?? 'narrative-media'
  const sourceUrl = `s3://${bucket}/${storageKey}`

  const processing = processingForVariant(variant)

  // Path that gets signed — imgproxy requires this exact format.
  // For 'original' there is no processing directive; path is /plain/...
  const path =
    processing.length > 0
      ? `/${processing}/plain/${sourceUrl}@${extension}`
      : `/plain/${sourceUrl}@${extension}`

  // Signature: HMAC-SHA256(salt || path, key), URL-safe base64 without padding
  const saltBuffer = Buffer.from(salt)
  const pathBuffer = Buffer.from(path, 'utf8')
  const data = Buffer.concat([saltBuffer, pathBuffer])

  const signature = createHmac('sha256', key).update(data).digest('base64url') // Node.js built-in: URL-safe base64 without padding

  return `${baseUrl}/${signature}${path}`
}
