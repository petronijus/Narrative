import { describe, expect, it } from 'vitest'
import { limitBatchTextures } from './batchTextures.js'

const renderer = (maxBatchableTextures: number) => ({ limits: { maxBatchableTextures } })

describe('limitBatchTextures', () => {
  it('lowers the batch to the asked number of textures', () => {
    const r = renderer(32)
    expect(limitBatchTextures(r, 4)).toBe(4)
    expect(r.limits.maxBatchableTextures).toBe(4)
  })

  it('never raises it above what the GPU allows', () => {
    const r = renderer(8)
    expect(limitBatchTextures(r, 16)).toBe(8)
    expect(r.limits.maxBatchableTextures).toBe(8)
  })

  it('keeps at least one texture, whole numbers only, and ignores a non-number', () => {
    expect(limitBatchTextures(renderer(16), 0)).toBe(1)
    expect(limitBatchTextures(renderer(16), 2.7)).toBe(2)
    expect(limitBatchTextures(renderer(16), Number.NaN)).toBe(16)
  })
})
