/**
 * renderer/experimental/textEngine/sdfText.ts — candidate (b) of the E7
 * spike: signed-distance-field glyph atlases drawn by Pixi's BitmapText and
 * its SDF shader (EXPERIMENTAL).
 *
 * The glyphs are made at runtime from the same fonts the page uses
 * (`@mapbox/tiny-sdf`: Canvas2D raster at a base size + a Euclidean
 * distance transform, in the text worker), so embedded faces work without
 * an offline atlas step. Placement comes from a `TextRunLayout` (the
 * browser's line boxes, `domRuns.ts`); within a run Pixi advances glyph by
 * glyph (advance + pair kerning measured with Canvas2D, no other shaping —
 * no ligatures, no contextual forms, no GPOS beyond pair kerning).
 *
 * One atlas per face (style × weight × family), zoom-independent: a zoom
 * re-rasterises nothing. Single-channel SDF rounds sharp corners as glyphs
 * get large on screen; MSDF needs glyph outlines (a font parser and
 * msdfgen) and is not built here.
 */

import {
  BitmapFont,
  BitmapText,
  BufferImageSource,
  Cache,
  Container,
  Texture,
  type BitmapFontData,
} from 'pixi.js'
import type { TextRasterPool } from './rasterClient.js'
import type { SdfGlyph } from './protocol.js'
import type { GlyphRun, TextRunLayout } from './runs.js'

export interface SdfOptions {
  /** Base size of the atlas glyphs, px. */
  size: number
  buffer: number
  radius: number
}

export const DEFAULT_SDF: SdfOptions = { size: 48, buffer: 4, radius: 8 }

interface Face {
  style: string
  weight: string
  family: string
}

const FONT = /^(\S+(?: -?[\d.]+deg)?) (\d+(?:\.\d+)?) ([\d.]+)px (.+)$/

/** The face of a run's `font` shorthand (as `domRuns` / `blockModel` write it). */
export function faceOf(run: Pick<GlyphRun, 'font'>): Face | null {
  const m = FONT.exec(run.font)
  if (m === null) return null
  return { style: m[1]!, weight: m[2]!, family: m[4]! }
}

function faceKey(f: Face): string {
  return `${f.style}|${f.weight}|${f.family}`
}

interface Atlas {
  name: string
  glyphs: Map<string, SdfGlyph>
  kerning: Record<string, number>
  ascent: number
  texture: Texture | null
  kpx: number
}

/** Pack glyphs into one RGBA page (shelf packing); returns the page and each glyph's spot. */
function pack(glyphs: SdfGlyph[]): {
  data: Uint8ClampedArray
  width: number
  height: number
  spots: Map<string, { x: number; y: number }>
} {
  const width = 1024
  let x = 0
  let y = 0
  let row = 0
  const spots = new Map<string, { x: number; y: number }>()
  for (const g of glyphs) {
    if (x + g.width > width) {
      x = 0
      y += row
      row = 0
    }
    spots.set(g.char, { x, y })
    x += g.width
    row = Math.max(row, g.height)
  }
  let height = 1
  while (height < y + row) height *= 2
  const data = new Uint8ClampedArray(width * height * 4)
  for (const g of glyphs) {
    const s = spots.get(g.char)!
    for (let gy = 0; gy < g.height; gy++) {
      for (let gx = 0; gx < g.width; gx++) {
        const o = ((s.y + gy) * width + s.x + gx) * 4
        data[o] = 255
        data[o + 1] = 255
        data[o + 2] = 255
        data[o + 3] = g.data[gy * g.width + gx]!
      }
    }
  }
  return { data, width, height, spots }
}

export interface SdfPrepareStats {
  /** Worker time making glyphs, summed. */
  glyphMs: number
  /** Main-thread time packing and uploading atlases. */
  packMs: number
  faces: number
  glyphs: number
  /** Atlas texture pixels (thousands). */
  atlasKpx: number
}

export class SdfTextCache {
  private readonly atlases = new Map<string, Atlas>()
  private version = 0

  constructor(
    private readonly pool: TextRasterPool,
    private readonly options: SdfOptions = DEFAULT_SDF,
  ) {}

  /** Make sure every glyph and pair of `layouts` is in an atlas. */
  async prepare(layouts: readonly TextRunLayout[]): Promise<SdfPrepareStats> {
    const want = new Map<string, { face: Face; chars: Set<string>; pairs: Set<string> }>()
    for (const layout of layouts) {
      for (const run of layout.runs) {
        const face = faceOf(run)
        if (face === null) continue
        const key = faceKey(face)
        let w = want.get(key)
        if (w === undefined) {
          w = { face, chars: new Set(), pairs: new Set() }
          want.set(key, w)
        }
        const chars = [...run.text]
        chars.forEach((c, i) => {
          w.chars.add(c)
          if (i > 0) w.pairs.add(chars[i - 1]! + c)
        })
      }
    }
    const stats: SdfPrepareStats = { glyphMs: 0, packMs: 0, faces: 0, glyphs: 0, atlasKpx: 0 }
    await Promise.all(
      [...want.entries()].map(async ([key, w]) => {
        const atlas = this.atlases.get(key)
        const missing = [...w.chars].filter((c) => atlas?.glyphs.has(c) !== true)
        const missingPairs = [...w.pairs].filter(
          (p) => atlas === undefined || !(p in atlas.kerning),
        )
        if (missing.length === 0 && missingPairs.length === 0) return
        const res = await this.pool.sdf({
          type: 'sdf',
          family: w.face.family,
          weight: w.face.weight,
          style: w.face.style,
          size: this.options.size,
          buffer: this.options.buffer,
          radius: this.options.radius,
          chars: missing,
          pairs: missingPairs,
        })
        stats.glyphMs += res.ms
        const next: Atlas = atlas ?? {
          name: '',
          glyphs: new Map(),
          kerning: {},
          ascent: res.ascent,
          texture: null,
          kpx: 0,
        }
        for (const g of res.glyphs) next.glyphs.set(g.char, g)
        // Pairs measured with no kerning are remembered too (as 0).
        for (const p of missingPairs) next.kerning[p] = res.kerning[p] ?? 0
        const t0 = performance.now()
        this.install(next)
        stats.packMs += performance.now() - t0
        this.atlases.set(key, next)
      }),
    )
    for (const a of this.atlases.values()) {
      stats.faces++
      stats.glyphs += a.glyphs.size
      stats.atlasKpx += a.kpx
    }
    return stats
  }

  /** (Re)build an atlas's page and its BitmapFont under a fresh name (Pixi caches layouts by name). */
  private install(atlas: Atlas): void {
    const glyphs = [...atlas.glyphs.values()]
    const { data, width, height, spots } = pack(glyphs)
    const name = `sdf-${++this.version}`
    if (atlas.name !== '') {
      const old = Cache.get<BitmapFont>(`${atlas.name}-bitmap`)
      Cache.remove(`${atlas.name}-bitmap`)
      old?.destroy()
    }
    const texture = new Texture({
      source: new BufferImageSource({ resource: data, width, height, format: 'rgba8unorm' }),
    })
    const { size, buffer } = this.options
    const chars: BitmapFontData['chars'] = {}
    for (const g of glyphs) {
      const s = spots.get(g.char)!
      const kerning: Record<string, number> = {}
      for (const [pair, k] of Object.entries(atlas.kerning)) {
        const [a, b] = [...pair]
        if (b === g.char && a !== undefined && k !== 0) kerning[a] = k
      }
      chars[g.char] = {
        id: g.char.codePointAt(0)!,
        letter: g.char,
        page: 0,
        x: s.x,
        y: s.y,
        width: g.width,
        height: g.height,
        xOffset: g.glyphLeft - buffer,
        yOffset: atlas.ascent - g.glyphTop - buffer,
        xAdvance: g.glyphAdvance,
        kerning,
      }
    }
    const font = new BitmapFont({
      textures: [texture],
      data: {
        pages: [{ id: 0, file: '' }],
        chars,
        fontSize: size,
        lineHeight: size,
        baseLineOffset: 0,
        fontFamily: name,
        distanceField: { type: 'sdf', range: this.options.radius },
      },
    })
    Cache.set(`${name}-bitmap`, font)
    atlas.name = name
    atlas.texture = texture
    atlas.kpx = (width * height) / 1000
  }

  /** A container drawing `layout` in the texture's coordinates (padding included). */
  build(layout: TextRunLayout): Container {
    const c = new Container()
    for (const run of layout.runs) {
      const face = faceOf(run)
      if (face === null) continue
      const atlas = this.atlases.get(faceKey(face))
      if (atlas === undefined) continue
      // Underlines and strokes are not drawn by this candidate (counted as differences).
      for (const part of run.parts ?? [{ text: run.text, dx: 0 }]) {
        const t = new BitmapText({
          text: part.text,
          style: {
            fontFamily: atlas.name,
            fontSize: run.size,
            fill: run.color,
            letterSpacing: run.letterSpacing,
            wordWrap: false,
            whiteSpace: 'pre',
          },
        })
        t.x = run.x + part.dx
        t.y = run.y - atlas.ascent * (run.size / this.options.size)
        c.addChild(t)
      }
    }
    return c
  }

  /** Atlas pixels in thousands. */
  get atlasKpx(): number {
    let k = 0
    for (const a of this.atlases.values()) k += a.kpx
    return k
  }

  destroy(): void {
    for (const a of this.atlases.values()) {
      const f = Cache.get<BitmapFont>(`${a.name}-bitmap`)
      Cache.remove(`${a.name}-bitmap`)
      f?.destroy()
    }
    this.atlases.clear()
  }
}
