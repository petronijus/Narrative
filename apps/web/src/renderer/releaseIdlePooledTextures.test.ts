// @vitest-environment node
/**
 * releaseIdlePooledTextures.test.ts — what a landed zoom staging frees from
 * Pixi's TexturePool. Against the real pixi.js pool (the render-target
 * system's map is a double: building one needs a WebGL context):
 *   - an idle render target (a filter's) is destroyed and leaves the pool:
 *     Pixi releases the framebuffer it built for it only on the source's
 *     `destroy`. Unloaded and handed out again, a filter drew into a
 *     framebuffer whose GL texture was gone — drop shadows vanished after a
 *     zoom (2026-11-01);
 *   - an idle raster (HTMLText's) is unloaded and stays a whole texture: Pixi
 *     returns it while the text still draws it, and a destroyed one made the
 *     next batch throw (2026-11-01).
 */

import { afterEach, describe, expect, it } from 'vitest'
import { TexturePool, type TextureSource } from 'pixi.js'
import { releaseIdlePooledTextures } from './ResourceManager.js'

/** A renderer double: its uid, and the render targets it built (by texture source). */
function rendererWith(targets: TextureSource[]) {
  return {
    uid: 7,
    renderTarget: { _renderSurfaceToRenderTargetHash: new Map(targets.map((s) => [s, {}])) },
  }
}

/** A pooled texture the renderer drew with (its GPU data, as Pixi keeps it per renderer). */
function pooled(width: number, height: number) {
  const texture = TexturePool.getOptimalTexture({ width, height })
  ;(texture.source as unknown as { _gpuData: Record<number, unknown> })._gpuData = { 7: {} }
  return texture
}

afterEach(() => TexturePool.clear(true))

describe('releaseIdlePooledTextures', () => {
  it('destroys an idle render target — its framebuffer goes with it — and the pool makes a new one', () => {
    const target = pooled(256, 128)
    const source = target.source
    let destroyEvents = 0
    source.once('destroy', () => destroyEvents++)
    TexturePool.returnTexture(target)

    const px = releaseIdlePooledTextures(rendererWith([source]))

    expect(px).toBe(256 * 128)
    expect(source.destroyed).toBe(true)
    // The render-target system listens for this to free the framebuffer.
    expect(destroyEvents).toBe(1)
    const again = TexturePool.getOptimalTexture({ width: 256, height: 128 })
    expect(again).not.toBe(target)
    expect(again.source.destroyed).toBe(false)
  })

  it('unloads an idle raster and keeps it whole: a text may still draw it', () => {
    const raster = pooled(128, 64)
    const source = raster.source
    let unloads = 0
    source.on('unload', () => unloads++)
    TexturePool.returnTexture(raster)

    expect(releaseIdlePooledTextures(rendererWith([]))).toBe(128 * 64)

    expect(unloads).toBe(1)
    expect(source.destroyed).toBe(false)
    expect(raster.source).toBe(source)
    // Still the pool's: handed out again as it is.
    expect(TexturePool.getOptimalTexture({ width: 128, height: 64 })).toBe(raster)
  })

  it('leaves what holds nothing for this renderer, and a texture still handed out', () => {
    const other = TexturePool.getOptimalTexture({ width: 32, height: 32 })
    const inUse = pooled(64, 64)
    TexturePool.returnTexture(other)
    expect(releaseIdlePooledTextures(rendererWith([inUse.source, other.source]))).toBe(0)
    expect(other.source.destroyed).toBe(false)
    expect(inUse.source.destroyed).toBe(false)
  })
})
