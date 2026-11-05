// @vitest-environment node
/**
 * runRasterUpload.test.ts — the run-raster uploader reaches Pixi's texture
 * system the way Pixi looks it up. Against the real pixi.js, not the mock: the
 * mock's `extensions.add` accepted a wrapper Pixi itself registers wrongly,
 * and every run raster in WebKit stayed an empty texture (2026-10-31).
 */

import { describe, expect, it } from 'vitest'
import { GlTextureSystem } from 'pixi.js'
import { RUN_RASTER_UPLOAD, runRasterUploader } from './runRasterUpload.js'

describe('runRasterUploader', () => {
  it('is registered with Pixi under its id, with an upload Pixi can call', () => {
    const registered = (
      GlTextureSystem as unknown as { uploadExtensions: Record<string, { upload?: unknown }> }
    ).uploadExtensions[RUN_RASTER_UPLOAD]
    expect(registered).toBe(runRasterUploader)
    expect(typeof registered?.upload).toBe('function')
  })

  it("is in a new texture system's uploads, where onSourceUpdate looks a source's uploadMethodId up", () => {
    // GlTextureSystem copies the registered uploaders in its constructor.
    const system = new GlTextureSystem({
      gc: { addResourceHash: () => {}, addCollection: () => {}, addResource: () => {} },
    } as unknown as ConstructorParameters<typeof GlTextureSystem>[0])
    const uploads = (system as unknown as { _uploads: Record<string, { upload?: unknown }> })
      ._uploads
    expect(typeof uploads[RUN_RASTER_UPLOAD]?.upload).toBe('function')
    expect(uploads[RUN_RASTER_UPLOAD]).toBe(runRasterUploader)
  })
})
