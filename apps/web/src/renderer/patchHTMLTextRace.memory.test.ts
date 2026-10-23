/**
 * patchHTMLTextRace.memory.test.ts — what the HTMLText patches must not keep
 * alive (performance.md → E8): a destroyed renderer's texture system
 * subscribed to Pixi's page-wide textures, and the SVG a pooled raster
 * image drew last.
 */

import { describe, expect, it } from 'vitest'
import { BigPool, EventEmitter, HTMLTextRenderData } from 'pixi.js'
import {
  followRenderDataPool,
  rebindSourceListeners,
  releasePooledRaster,
} from './patchHTMLTextRace.js'

class FakeTextureSystem {
  _managedTextures: { items: Record<string, unknown> } = { items: {} }
  onSourceUpdate(_source: unknown): void {}
  /** Pixi's GlTextureSystem.onSourceUnload: removal by the instance's current method. */
  unload(source: EventEmitter): void {
    source.off('update', this.onSourceUpdate, this)
    source.off('resize', this.onSourceUpdate, this)
  }
}

describe('rebindSourceListeners', () => {
  it('moves the listeners a source had before the patch, so unloading removes them', () => {
    const system = new FakeTextureSystem()
    const other = new FakeTextureSystem()
    const empty = new EventEmitter()
    const original = system.onSourceUpdate
    // Bound when the context arrived, with the method itself.
    for (const s of [system, other]) {
      empty.on('update', s.onSourceUpdate, s)
      empty.on('resize', s.onSourceUpdate, s)
    }
    system._managedTextures.items['1'] = empty
    const patched = (_source: unknown): void => {}
    system.onSourceUpdate = patched
    rebindSourceListeners(system, original, patched)
    system.unload(empty)
    // Only the other renderer's listeners are left.
    expect(empty.listenerCount('update')).toBe(1)
    expect(empty.listenerCount('resize')).toBe(1)
  })

  it('adds nothing to a source the system did not listen to', () => {
    const system = new FakeTextureSystem()
    const source = new EventEmitter()
    system._managedTextures.items['2'] = source
    system._managedTextures.items['3'] = null
    rebindSourceListeners(system, system.onSourceUpdate, () => undefined)
    expect(source.listenerCount('update')).toBe(0)
  })
})

describe('releasePooledRaster', () => {
  followRenderDataPool()

  it('empties a pooled raster image and its DOM, but not one a raster took again', () => {
    const data = BigPool.get(HTMLTextRenderData)
    // In a page Pixi's DOM adapter makes an <img>.
    const image = data.image as unknown as HTMLImageElement
    image.src = 'data:image/svg+xml;charset=utf8,%3Csvg%2F%3E'
    data.domElement.innerHTML = '<div>text</div>'
    BigPool.return(data)
    releasePooledRaster(image)
    expect(image.hasAttribute('src')).toBe(false)
    expect(data.domElement.childNodes.length).toBe(0)

    const again = BigPool.get(HTMLTextRenderData)
    expect(again).toBe(data)
    image.src = 'data:image/svg+xml;charset=utf8,%3Csvg%2F%3E'
    // Taken by another raster: its SVG is that raster's.
    releasePooledRaster(image)
    expect(image.hasAttribute('src')).toBe(true)
    BigPool.return(again)
  })
})
