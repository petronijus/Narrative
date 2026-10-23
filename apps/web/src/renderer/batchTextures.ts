/**
 * renderer/batchTextures.ts — how many textures one batched draw may sample.
 *
 * Pixi's batch shader (sprites, graphics, text rasters — nearly every draw of
 * a slide) has one branch per texture slot, `limits.maxBatchableTextures`,
 * which Pixi sets from the GPU's `MAX_TEXTURE_IMAGE_UNITS` (16–32). On a GPU
 * that costs nothing. Under software WebGL — SwiftShader, which the render
 * worker always uses — every branch is compiled into the shader on the page's
 * first draw and evaluated for every pixel of every draw after it. Measured
 * on the render worker's image under VM 103's limits (performance.md, F5):
 * the first capture of a page 1.4–1.8 s → ~0.3 s, each later capture
 * ~0.45 s → ~0.2 s, with byte-identical pictures. Fewer slots only break a
 * scene with many pictures into more draw calls.
 *
 * Pixi reads the limit whenever it builds a batcher (BatcherPipe,
 * GraphicsContextSystem), so it must be lowered before the first draw.
 */

/** What `limitBatchTextures` needs of a Pixi renderer. */
export interface BatchTextureLimits {
  limits: { maxBatchableTextures: number }
}

/**
 * Lower the renderer's batch to at most `most` textures (at least one; never
 * above what the GPU allows). Returns the limit now in force.
 */
export function limitBatchTextures(renderer: BatchTextureLimits, most: number): number {
  const { limits } = renderer
  const wanted = Number.isFinite(most) ? Math.floor(most) : limits.maxBatchableTextures
  const limit = Math.max(1, Math.min(limits.maxBatchableTextures, wanted))
  limits.maxBatchableTextures = limit
  return limit
}
