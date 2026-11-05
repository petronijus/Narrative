/**
 * renderer/runText/inkCentres.ts — where two rasters of one text put their
 * lines and words, independent of how dark either draws them (ADR 0018 →
 * Fidelity: WebKit's HTML text is heavier than its canvas text, in the same
 * place).
 *
 * Ink is coverage (alpha, or darkness over a known background), 0–255. Lines
 * are the bands of rows with ink in the first raster; per line, the
 * ink-weighted centre of each raster within the band; per word (runs of
 * columns with ink in either raster, split at gaps of a sixth of the line's
 * height), the same horizontally. Centres move by less than a pixel when a
 * glyph is a shade heavier on both sides, and by the shift when it moved.
 */

/** Ink coverage, row-major, `width × height`, 0–255. */
export interface InkMap {
  width: number
  height: number
  ink: Uint8Array | Float32Array | number[]
}

export interface InkPlacement {
  /** Lines (ink bands) in the first raster and in the second. */
  lines: number
  linesOther: number
  /**
   * The largest line-centre difference, x and y, in raster px. A line's x
   * centre also moves when its words merely draw heavier (by their widths'
   * proportions): gate on `wordDx` along x, `lineDy` along y.
   */
  lineDx: number
  lineDy: number
  /** The largest word-centre difference along x, in raster px. */
  wordDx: number
  /** The second raster's total ink over the first's. */
  coverage: number
}

/** Coverage from RGBA: alpha (`over: null`), or darkness over an opaque background colour. */
export function inkOf(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  over: [number, number, number] | null = null,
): InkMap {
  const ink = new Float32Array(width * height)
  for (let p = 0, i = 0; p < ink.length; p++, i += 4) {
    if (over === null) {
      ink[p] = rgba[i + 3]!
      continue
    }
    // How far the pixel is from the background, scaled so full ink reads 255.
    let d = 0
    for (let c = 0; c < 3; c++) {
      const bg = over[c]!
      const span = Math.max(bg, 255 - bg, 1)
      d = Math.max(d, (Math.abs(rgba[i + c]! - bg) * 255) / span)
    }
    ink[p] = d
  }
  return { width, height, ink }
}

function centre(
  m: InkMap,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
): { x: number; y: number; ink: number } | null {
  let sum = 0
  let sx = 0
  let sy = 0
  for (let y = Math.max(0, y0); y < Math.min(m.height, y1); y++)
    for (let x = Math.max(0, x0); x < Math.min(m.width, x1); x++) {
      const v = m.ink[y * m.width + x]!
      if (v === 0) continue
      sum += v
      sx += v * x
      sy += v * y
    }
  return sum === 0 ? null : { x: sx / sum, y: sy / sum, ink: sum }
}

/** Runs of indices whose value is over `threshold`, merged across gaps of up to `gap`. */
export function bands(
  profile: ArrayLike<number>,
  threshold: number,
  gap: number,
): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (let i = 0; i < profile.length; i++) {
    if (profile[i]! <= threshold) continue
    const last = out[out.length - 1]
    if (last !== undefined && i - last[1] <= gap) last[1] = i + 1
    else out.push([i, i + 1])
  }
  return out
}

function rowProfile(m: InkMap, w: number, h: number): Float32Array {
  const out = new Float32Array(h)
  for (let y = 0; y < h; y++) {
    let s = 0
    for (let x = 0; x < w; x++) s += m.ink[y * m.width + x]!
    out[y] = s
  }
  return out
}

/** Where `b` puts the lines and words of `a` (same text, same raster geometry). */
export function compareInkPlacement(a: InkMap, b: InkMap): InkPlacement {
  const w = Math.min(a.width, b.width)
  const h = Math.min(a.height, b.height)
  const all = [centre(a, 0, w, 0, h), centre(b, 0, w, 0, h)] as const
  const coverage =
    all[0] === null || all[1] === null ? (all[0] === all[1] ? 1 : 0) : all[1].ink / all[0].ink
  const rowsA = rowProfile(a, w, h)
  const rowsB = rowProfile(b, w, h)
  const max = (p: Float32Array): number => p.reduce((m, v) => Math.max(m, v), 0)
  const linesA = bands(rowsA, max(rowsA) * 0.02, 1)
  const linesB = bands(rowsB, max(rowsB) * 0.02, 1)
  let lineDx = 0
  let lineDy = 0
  let wordDx = 0
  for (const [r0, r1] of linesA) {
    const y0 = r0 - 2
    const y1 = r1 + 2
    const ca = centre(a, 0, w, y0, y1)
    const cb = centre(b, 0, w, y0, y1)
    if (ca === null || cb === null) {
      lineDx = lineDy = Infinity
      continue
    }
    lineDx = Math.max(lineDx, Math.abs(ca.x - cb.x))
    lineDy = Math.max(lineDy, Math.abs(ca.y - cb.y))
    const cols = new Float32Array(w)
    for (let y = Math.max(0, y0); y < Math.min(h, y1); y++)
      for (let x = 0; x < w; x++) cols[x]! += a.ink[y * a.width + x]! + b.ink[y * b.width + x]!
    const gap = Math.max(2, Math.round((r1 - r0) / 6))
    for (const [c0, c1] of bands(cols, 0, gap)) {
      const wa = centre(a, c0 - 1, c1 + 1, y0, y1)
      const wb = centre(b, c0 - 1, c1 + 1, y0, y1)
      if (wa === null || wb === null) continue
      wordDx = Math.max(wordDx, Math.abs(wa.x - wb.x))
    }
  }
  return { lines: linesA.length, linesOther: linesB.length, lineDx, lineDy, wordDx, coverage }
}
