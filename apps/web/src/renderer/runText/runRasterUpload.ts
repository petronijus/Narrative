/**
 * renderer/runText/runRasterUpload.ts — the upload of a run raster where the
 * engine uploads an ImageBitmap's colours straight (runTextSystem.ts →
 * premultipliesBitmaps: WebKit).
 *
 * The bitmap is drawn into a scratch canvas of its size, which uploads
 * premultiplied, and that canvas is handed to Pixi's own image upload. The
 * bitmap stays the texture's resource (a re-upload — the texture GC, a lost
 * context — goes through here again), and a scratch canvas serves every
 * raster of its size: a canvas per raster, kept as the resource, cost a
 * fixed 0.25–0.6 ms each (its creation and context; WebKit microbench
 * 2026-10-30: 256 × 64 0.81 → 0.44 ms per raster, 2048² 11.4 → 9.0 ms;
 * ADR 0018 → Cost).
 *
 * Registered with Pixi as a `TextureUploaderWebGL` extension in Pixi's own
 * shape — the uploader object itself carries `extension`, `id` and `upload`
 * (as `glUploadHTMLResource` does). `extensions.add` takes any object with an
 * `extension` key for the extension and registers that object: a wrapper
 * `{ extension, ref: uploader }` registered the wrapper, which has no
 * `upload`, and every run raster in WebKit threw in `onSourceUpdate` and
 * stayed an empty texture — no canvas text at all (2026-10-31;
 * runRasterUpload.test.ts checks the registration against Pixi itself).
 */

import { ExtensionType, extensions, glUploadImageResource } from 'pixi.js'
import type { GlRenderingContext, GlTexture, TextureSource } from 'pixi.js'

/** The `uploadMethodId` of a run raster's source that needs this upload. */
export const RUN_RASTER_UPLOAD = 'narrative-run-raster'

/** Scratch canvases by size, the least recently used first. */
const scratchCanvases = new Map<string, CanvasRenderingContext2D>()
/** Kept at most: canvases, and their pixels together (4 bytes each). */
const SCRATCH_MAX = 8
const SCRATCH_MAX_PX = 8_000_000

function scratchFor(width: number, height: number): CanvasRenderingContext2D | null {
  const key = `${width}x${height}`
  const kept = scratchCanvases.get(key)
  if (kept !== undefined) {
    scratchCanvases.delete(key)
    scratchCanvases.set(key, kept)
    return kept
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (ctx === null) return null
  // The bitmap covers the canvas whole: every pixel replaced, nothing cleared first.
  ctx.globalCompositeOperation = 'copy'
  scratchCanvases.set(key, ctx)
  let px = 0
  for (const c of scratchCanvases.values()) px += c.canvas.width * c.canvas.height
  for (const [k, c] of scratchCanvases) {
    if (scratchCanvases.size <= SCRATCH_MAX && px <= SCRATCH_MAX_PX) break
    if (k === key) continue
    px -= c.canvas.width * c.canvas.height
    c.canvas.width = c.canvas.height = 0
    scratchCanvases.delete(k)
  }
  return ctx
}

/** The uploader, in the shape Pixi's `TextureUploaderWebGL` extensions have. */
export const runRasterUploader = {
  extension: { type: ExtensionType.TextureUploaderWebGL, name: RUN_RASTER_UPLOAD },
  id: RUN_RASTER_UPLOAD,
  upload(
    source: TextureSource,
    glTexture: GlTexture,
    gl: GlRenderingContext,
    webGLVersion: number,
  ): void {
    const bitmap = source.resource as ImageBitmap
    const ctx = typeof document === 'undefined' ? null : scratchFor(bitmap.width, bitmap.height)
    if (ctx === null) {
      glUploadImageResource.upload(source, glTexture, gl, webGLVersion)
      return
    }
    ctx.drawImage(bitmap, 0, 0)
    // Pixi's image upload reads these of the source: the canvas in the bitmap's place.
    const asCanvas = {
      pixelWidth: source.pixelWidth,
      pixelHeight: source.pixelHeight,
      resourceWidth: bitmap.width,
      resourceHeight: bitmap.height,
      resource: ctx.canvas,
    } as unknown as TextureSource
    glUploadImageResource.upload(asCanvas, glTexture, gl, webGLVersion)
  },
}

extensions.add(runRasterUploader)
