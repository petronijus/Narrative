/**
 * perf/glResidency.ts — what one WebGL context holds on the GPU, followed
 * from its calls (performance.md → E8): the textures created and not
 * deleted, and the bytes their levels were allocated with; the same for
 * renderbuffers (a render target's stencil, MSAA colour). The harness wraps
 * the WebGL prototypes and feeds each context's calls to its own tracker.
 *
 * Bytes are an estimate: 4 per pixel whatever the internal format (Pixi
 * allocates RGBA8 everywhere but its depth-stencil), a mip chain as the sum of
 * its levels, `generateMipmap` as the levels below the base. The driver may
 * pad or compress; growth across a repeated pass is what is read, and an
 * estimate that is the same on every pass shows it as well as the driver's
 * own number would.
 *
 * Pure: no WebGL, no DOM — any object stands for a texture or a buffer.
 */

const TEXTURE_2D = 0x0de1
const TEXTURE_CUBE_MAP = 0x8513
const TEXTURE_CUBE_MAP_POSITIVE_X = 0x8515
const TEXTURE_CUBE_MAP_NEGATIVE_Z = 0x851a
const TEXTURE0 = 0x84c0
const BYTES_PER_PIXEL = 4

interface TextureRecord {
  /** Bytes per level (and cube face: `level * 8 + face`). */
  levels: Map<number, number>
}

export interface GlResidencySnapshot {
  /** Textures created and not deleted. */
  textures: number
  /** Their allocated bytes (estimate, see the header). */
  textureBytes: number
  /** Renderbuffers created and not deleted. */
  renderbuffers: number
  renderbufferBytes: number
  /** Textures and renderbuffers the page dropped undeleted and the GC collected since. */
  collected: number
}

/** The pixel size of a texImage2D / texSubImage2D source argument (an image, canvas, video, ImageData, ImageBitmap). */
function sourceSize(src: unknown): { width: number; height: number } | null {
  if (typeof src !== 'object' || src === null) return null
  const o = src as {
    videoWidth?: number
    videoHeight?: number
    naturalWidth?: number
    naturalHeight?: number
    width?: number
    height?: number
  }
  const w = o.videoWidth || o.naturalWidth || o.width
  const h = o.videoHeight || o.naturalHeight || o.height
  return typeof w === 'number' && typeof h === 'number' ? { width: w, height: h } : null
}

/** A texture target as the binding it goes through: a cube face binds the cube map. */
function bindingOf(target: number): number {
  return target >= TEXTURE_CUBE_MAP_POSITIVE_X && target <= TEXTURE_CUBE_MAP_NEGATIVE_Z
    ? TEXTURE_CUBE_MAP
    : target
}

function faceOf(target: number): number {
  return target >= TEXTURE_CUBE_MAP_POSITIVE_X && target <= TEXTURE_CUBE_MAP_NEGATIVE_Z
    ? target - TEXTURE_CUBE_MAP_POSITIVE_X
    : 0
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
}

export class GlResidency {
  /**
   * Per texture, weakly: the tracker must not keep alive a texture the page
   * dropped without deleting it — the GPU memory a collected wrapper frees
   * would otherwise stay held by the probe. Such a texture is subtracted when
   * collected and counted in `collected`.
   */
  private readonly textures = new WeakMap<object, TextureRecord>()
  private readonly renderbuffers = new WeakMap<object, { bytes: number }>()
  private textureCount = 0
  private textureBytes = 0
  private renderbufferCount = 0
  private renderbufferBytes = 0
  private collectedCount = 0
  private unit = 0
  /** Bound texture per `unit * 0x10000 + binding` (the context holds them bound anyway). */
  private readonly bound = new Map<number, object | null>()
  private boundRenderbuffer: object | null = null
  private readonly onCollected = new FinalizationRegistry<{
    kind: 'texture' | 'renderbuffer'
    rec: TextureRecord | { bytes: number }
  }>((held) => {
    this.collectedCount++
    this.forget(held.kind, held.rec)
  })

  private forget(kind: 'texture' | 'renderbuffer', rec: TextureRecord | { bytes: number }): void {
    if (kind === 'texture') {
      this.textureCount--
      for (const b of (rec as TextureRecord).levels.values()) this.textureBytes -= b
    } else {
      this.renderbufferCount--
      this.renderbufferBytes -= (rec as { bytes: number }).bytes
    }
  }

  createTexture(tex: unknown): void {
    if (typeof tex !== 'object' || tex === null) return
    const rec: TextureRecord = { levels: new Map() }
    this.textures.set(tex, rec)
    this.textureCount++
    this.onCollected.register(tex, { kind: 'texture', rec }, tex)
  }

  deleteTexture(tex: unknown): void {
    if (typeof tex !== 'object' || tex === null) return
    const rec = this.textures.get(tex)
    if (rec === undefined) return
    this.textures.delete(tex)
    this.onCollected.unregister(tex)
    this.forget('texture', rec)
    for (const [k, v] of this.bound) if (v === tex) this.bound.set(k, null)
  }

  activeTexture(unit: unknown): void {
    const u = num(unit)
    if (u !== null) this.unit = u - TEXTURE0
  }

  bindTexture(target: unknown, tex: unknown): void {
    const t = num(target)
    if (t === null) return
    this.bound.set(this.unit * 0x10000 + t, typeof tex === 'object' ? tex : null)
  }

  private boundRecord(target: number): TextureRecord | null {
    const tex = this.bound.get(this.unit * 0x10000 + bindingOf(target)) ?? null
    return tex === null ? null : (this.textures.get(tex) ?? null)
  }

  private setLevel(rec: TextureRecord, key: number, bytes: number): void {
    this.textureBytes += bytes - (rec.levels.get(key) ?? 0)
    rec.levels.set(key, bytes)
  }

  /** texImage2D in either signature: 9 arguments (sizes, data or null) or 6 (a source element). */
  texImage2D(args: readonly unknown[]): void {
    const target = num(args[0])
    const level = num(args[1])
    if (target === null || level === null) return
    let w: number | null = null
    let h: number | null = null
    if (args.length >= 9) {
      w = num(args[3])
      h = num(args[4])
    } else if (args.length === 6) {
      const size = sourceSize(args[5])
      if (size !== null) ({ width: w, height: h } = size)
    }
    if (w === null || h === null) return
    const rec = this.boundRecord(target)
    if (rec !== null) this.setLevel(rec, level * 8 + faceOf(target), w * h * BYTES_PER_PIXEL)
  }

  /** texStorage2D(target, levels, internalformat, width, height): the whole chain at once. */
  texStorage2D(args: readonly unknown[]): void {
    const target = num(args[0])
    const levels = num(args[1])
    const w = num(args[3])
    const h = num(args[4])
    if (target === null || levels === null || w === null || h === null) return
    const rec = this.boundRecord(target)
    if (rec === null) return
    for (const b of rec.levels.values()) this.textureBytes -= b
    rec.levels.clear()
    const faces = bindingOf(target) === TEXTURE_CUBE_MAP ? 6 : 1
    for (let l = 0; l < levels; l++)
      for (let f = 0; f < faces; f++)
        this.setLevel(rec, l * 8 + f, Math.max(1, w >> l) * Math.max(1, h >> l) * BYTES_PER_PIXEL)
  }

  /** generateMipmap(target): every level below the base, from the base's size. */
  generateMipmap(target: unknown): void {
    const t = num(target)
    if (t === null) return
    const rec = this.boundRecord(t)
    if (rec === null) return
    const faces = t === TEXTURE_CUBE_MAP ? 6 : 1
    for (let f = 0; f < faces; f++) {
      let bytes = rec.levels.get(f) ?? 0
      for (let l = 1; bytes > BYTES_PER_PIXEL; l++) {
        bytes = Math.max(BYTES_PER_PIXEL, Math.floor(bytes / 4))
        this.setLevel(rec, l * 8 + f, bytes)
      }
    }
  }

  createRenderbuffer(rb: unknown): void {
    if (typeof rb !== 'object' || rb === null) return
    const rec = { bytes: 0 }
    this.renderbuffers.set(rb, rec)
    this.renderbufferCount++
    this.onCollected.register(rb, { kind: 'renderbuffer', rec }, rb)
  }

  deleteRenderbuffer(rb: unknown): void {
    if (typeof rb !== 'object' || rb === null) return
    const rec = this.renderbuffers.get(rb)
    if (rec === undefined) return
    this.renderbuffers.delete(rb)
    this.onCollected.unregister(rb)
    this.forget('renderbuffer', rec)
    if (this.boundRenderbuffer === rb) this.boundRenderbuffer = null
  }

  bindRenderbuffer(rb: unknown): void {
    this.boundRenderbuffer = typeof rb === 'object' ? rb : null
  }

  /** renderbufferStorage(target, fmt, w, h) or …Multisample(target, samples, fmt, w, h). */
  renderbufferStorage(args: readonly unknown[], multisample: boolean): void {
    const rb = this.boundRenderbuffer
    const rec = rb === null ? undefined : this.renderbuffers.get(rb)
    if (rec === undefined) return
    const samples = multisample ? Math.max(1, num(args[1]) ?? 1) : 1
    const w = num(args[multisample ? 3 : 2])
    const h = num(args[multisample ? 4 : 3])
    if (w === null || h === null) return
    const bytes = w * h * BYTES_PER_PIXEL * samples
    this.renderbufferBytes += bytes - rec.bytes
    rec.bytes = bytes
  }

  snapshot(): GlResidencySnapshot {
    return {
      textures: this.textureCount,
      textureBytes: this.textureBytes,
      renderbuffers: this.renderbufferCount,
      renderbufferBytes: this.renderbufferBytes,
      collected: this.collectedCount,
    }
  }
}

/** The enum values the tests (and the harness's wrap) feed the tracker. */
export const GL = { TEXTURE_2D, TEXTURE0, TEXTURE_CUBE_MAP, TEXTURE_CUBE_MAP_POSITIVE_X } as const
