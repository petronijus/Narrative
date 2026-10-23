// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { GL, GlResidency } from './glResidency.js'

const { TEXTURE_2D, TEXTURE0, TEXTURE_CUBE_MAP, TEXTURE_CUBE_MAP_POSITIVE_X } = GL

describe('GlResidency', () => {
  it('follows textures through their binding: allocation, re-allocation, deletion', () => {
    const gl = new GlResidency()
    const a = {}
    const b = {}
    gl.createTexture(a)
    gl.createTexture(b)
    gl.activeTexture(TEXTURE0 + 1)
    gl.bindTexture(TEXTURE_2D, a)
    // A render texture: sizes, no data.
    gl.texImage2D([TEXTURE_2D, 0, 0x1908, 100, 50, 0, 0x1908, 0x1401, null])
    expect(gl.snapshot()).toMatchObject({ textures: 2, textureBytes: 100 * 50 * 4 })
    // Re-allocated at another size: replaces the level, does not add.
    gl.texImage2D([TEXTURE_2D, 0, 0x1908, 10, 10, 0, 0x1908, 0x1401, null])
    expect(gl.snapshot().textureBytes).toBe(400)
    // An upload from a source element (6 arguments) on another unit and texture.
    gl.activeTexture(TEXTURE0)
    gl.bindTexture(TEXTURE_2D, b)
    gl.texImage2D([TEXTURE_2D, 0, 0x1908, 0x1908, 0x1401, { width: 20, height: 5 }])
    expect(gl.snapshot().textureBytes).toBe(400 + 400)
    gl.deleteTexture(a)
    expect(gl.snapshot()).toMatchObject({ textures: 1, textureBytes: 400 })
    gl.deleteTexture(a)
    expect(gl.snapshot().textures).toBe(1)
  })

  it('counts a mip chain from generateMipmap and texStorage2D', () => {
    const gl = new GlResidency()
    const t = {}
    gl.createTexture(t)
    gl.bindTexture(TEXTURE_2D, t)
    gl.texImage2D([TEXTURE_2D, 0, 0x1908, 0x1908, 0x1401, { videoWidth: 4, videoHeight: 4 }])
    gl.generateMipmap(TEXTURE_2D)
    // 4×4, 2×2, 1×1.
    expect(gl.snapshot().textureBytes).toBe((16 + 4 + 1) * 4)
    gl.texStorage2D([TEXTURE_2D, 2, 0x8058, 8, 8])
    expect(gl.snapshot().textureBytes).toBe((64 + 16) * 4)
  })

  it('counts each cube face', () => {
    const gl = new GlResidency()
    const t = {}
    gl.createTexture(t)
    gl.bindTexture(TEXTURE_CUBE_MAP, t)
    for (let f = 0; f < 6; f++)
      gl.texImage2D([TEXTURE_CUBE_MAP_POSITIVE_X + f, 0, 0x1908, 2, 2, 0, 0x1908, 0x1401, null])
    expect(gl.snapshot().textureBytes).toBe(6 * 16)
  })

  it('ignores an upload with nothing bound or to a texture it never saw created', () => {
    const gl = new GlResidency()
    gl.texImage2D([TEXTURE_2D, 0, 0x1908, 10, 10, 0, 0x1908, 0x1401, null])
    gl.bindTexture(TEXTURE_2D, {})
    gl.texImage2D([TEXTURE_2D, 0, 0x1908, 10, 10, 0, 0x1908, 0x1401, null])
    expect(gl.snapshot()).toMatchObject({ textures: 0, textureBytes: 0 })
  })

  it('follows renderbuffers, multisampled ones by their samples', () => {
    const gl = new GlResidency()
    const rb = {}
    gl.createRenderbuffer(rb)
    gl.bindRenderbuffer(rb)
    gl.renderbufferStorage([0x8d41, 4, 0x8058, 10, 10], true)
    expect(gl.snapshot()).toMatchObject({ renderbuffers: 1, renderbufferBytes: 10 * 10 * 4 * 4 })
    gl.renderbufferStorage([0x8d41, 0x88f0, 10, 10], false)
    expect(gl.snapshot().renderbufferBytes).toBe(400)
    gl.deleteRenderbuffer(rb)
    expect(gl.snapshot()).toMatchObject({ renderbuffers: 0, renderbufferBytes: 0 })
  })
})
