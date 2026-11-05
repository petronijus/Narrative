/**
 * renderer/maxTextureSide.ts — the largest texture side a renderer's GPU
 * holds. A text raster past it is drawn as a black block (WebGL refuses the
 * upload); the run painter cuts or softens such a raster
 * (runText/runTextSystem.ts), Pixi's HTMLText raster is softened
 * (patchHTMLTextRace.ts → withinTexture).
 */

import type { Renderer } from 'pixi.js'

/** Each renderer's largest texture side (its GPU's limit). */
const maxSides = new WeakMap<object, number>()

export function maxTextureSide(renderer: Renderer): number {
  let side = maxSides.get(renderer)
  if (side === undefined) {
    const r = renderer as unknown as {
      gl?: WebGLRenderingContext
      gpu?: { device?: { limits?: { maxTextureDimension2D?: number } } }
    }
    const gl = r.gl
    const fromGl = gl === undefined ? undefined : (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number)
    side = fromGl ?? r.gpu?.device?.limits?.maxTextureDimension2D ?? 4096
    maxSides.set(renderer, side)
  }
  return side
}
