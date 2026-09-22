/**
 * Upper bound on the rasters we store, and the downscale that enforces it.
 *
 * Every image the editor shows goes through imgproxy, and imgproxy refuses a
 * source above `IMGPROXY_MAX_SRC_RESOLUTION` (50 MP, infra/docker-compose.yml)
 * with a 422 — "Source image resolution is too big". The limit is not arbitrary:
 * decoding is roughly 4 bytes per pixel, so a 147 MP PNG costs ~600 MB per
 * request on a 4 GB VM. An image above it therefore never renders at all; the
 * editor shows its broken-image placeholder. The Proseware deck's slide
 * background (a 9903×14853 photo shown in a 1294 px frame) was exactly this.
 *
 * So an oversize raster is brought under the limit once, when it is stored —
 * by the PowerPoint importer and by the tus upload finaliser alike — rather
 * than raising imgproxy's guard. Nothing visible is lost: imgproxy's largest
 * display variant is 2560 px on the long side, and 40 MP is still far above
 * what any slide frame, or a PowerPoint export (which itself defaults to
 * 220 ppi), can use.
 *
 * The format is kept (a PNG stays a PNG, so transparency and the storage key's
 * extension stay valid). Formats that cannot be re-encoded faithfully — an
 * animated GIF, SVG (vector, no pixel limit), HEIC, BMP — are left untouched.
 */

import sharp, { type Metadata, type Sharp } from 'sharp'

/** Pixel budget for a stored raster: a margin below imgproxy's 50 MP. */
export const MAX_STORED_IMAGE_PIXELS = 40_000_000
/** Longest side we store; also the common WebGL MAX_TEXTURE_SIZE. */
export const MAX_STORED_IMAGE_SIDE = 16_384

/** Formats we can decode and write back in the same format. */
const REENCODABLE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/avif',
  'image/tiff',
])

export function exceedsStoredImageLimits(width: number, height: number): boolean {
  return (
    width * height > MAX_STORED_IMAGE_PIXELS ||
    width > MAX_STORED_IMAGE_SIDE ||
    height > MAX_STORED_IMAGE_SIDE
  )
}

/** The largest size with the same aspect ratio that fits both limits. */
export function fitWithinStoredImageLimits(
  width: number,
  height: number,
): { width: number; height: number } {
  const scale = Math.min(
    1,
    Math.sqrt(MAX_STORED_IMAGE_PIXELS / (width * height)),
    MAX_STORED_IMAGE_SIDE / width,
    MAX_STORED_IMAGE_SIDE / height,
  )
  // Floor, not round: rounding up either side can tip the product back over.
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  }
}

export function canDownscaleStoredImage(mimeType: string): boolean {
  return REENCODABLE_MIME.has(mimeType.toLowerCase())
}

export interface DownscaledImage {
  bytes: Buffer
  width: number
  height: number
}

/**
 * Re-encode `input` in its own format so it fits the stored-image limits.
 * Returns null when it already fits or its format is not re-encodable — the
 * caller then stores the original unchanged.
 *
 * EXIF orientation is applied to the pixels (the output carries none), so
 * the returned width/height are the image as displayed. The ICC profile is
 * kept so colour does not shift.
 */
export async function downscaleForStorage(
  input: Buffer,
  mimeType: string,
): Promise<DownscaledImage | null> {
  const mime = mimeType.toLowerCase()
  if (!REENCODABLE_MIME.has(mime)) return null
  // `limitInputPixels: false` — the whole point is to accept a source larger
  // than we would ever serve. `sequentialRead` lets libvips stream the decode
  // through the resize instead of materialising the full-size bitmap.
  const image = sharp(input, { limitInputPixels: false, sequentialRead: true })
  const { width, height } = orientedSize(await image.metadata())
  if (width === undefined || height === undefined) return null
  if (!exceedsStoredImageLimits(width, height)) return null
  return encode(image, mime, fitWithinStoredImageLimits(width, height))
}

function orientedSize(meta: Metadata): { width?: number; height?: number } {
  // EXIF orientations 5–8 swap the axes of what the viewer sees.
  const swapped = meta.orientation !== undefined && meta.orientation >= 5
  return swapped
    ? { width: meta.height, height: meta.width }
    : { width: meta.width, height: meta.height }
}

async function encode(
  pipeline: Sharp,
  mime: string,
  target: { width: number; height: number },
): Promise<DownscaledImage> {
  let out = pipeline
    .autoOrient()
    // `fill` hits the computed size exactly. It already carries the aspect
    // ratio to within a pixel; `inside` would re-derive one side from the
    // other's floored value and shave a few more pixels off.
    .resize(target.width, target.height, { fit: 'fill' })
    .keepIccProfile()
  switch (mime) {
    case 'image/png':
      out = out.png({ compressionLevel: 9, adaptiveFiltering: true })
      break
    case 'image/jpeg':
    case 'image/jpg':
      out = out.jpeg({ quality: 90, mozjpeg: true, chromaSubsampling: '4:4:4' })
      break
    case 'image/webp':
      out = out.webp({ quality: 90 })
      break
    case 'image/avif':
      out = out.avif({ quality: 70 })
      break
    case 'image/tiff':
      out = out.tiff({ compression: 'lzw' })
      break
  }
  const { data, info } = await out.toBuffer({ resolveWithObject: true })
  return { bytes: data, width: info.width, height: info.height }
}
