/**
 * renderer/experimental/textEngine/pixelDiff.ts — how two rasters of one text
 * differ (E7 spike, EXPERIMENTAL). Both are opaque RGBA (drawn over white);
 * "ink" is the darkness a pixel has over white, 0–255.
 */

export interface DiffStats {
  width: number
  height: number
  /** Pixels with ink > threshold in A / in B. */
  inkA: number
  inkB: number
  /** Pixels whose ink differs by more than the threshold. */
  differing: number
  /** `differing` / max(inkA, inkB) (0 when neither has ink). */
  ratio: number
  /** Mean |ink A − ink B| over all pixels. */
  meanAbs: number
  /** Largest |ink A − ink B|. */
  max: number
  /** Ink centroid of B minus A, px (where B's text sits relative to A's). */
  dx: number
  dy: number
}

/** Ink of an opaque RGBA pixel at `o`: 255 − luminance. */
function ink(px: ArrayLike<number>, o: number): number {
  return 255 - (0.2126 * px[o]! + 0.7152 * px[o + 1]! + 0.0722 * px[o + 2]!)
}

/** Compare A and B (same size, opaque RGBA rows). */
export function diffRasters(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  width: number,
  height: number,
  threshold = 32,
): DiffStats {
  let inkA = 0
  let inkB = 0
  let differing = 0
  let sumAbs = 0
  let max = 0
  let wa = 0
  let wb = 0
  let xa = 0
  let ya = 0
  let xb = 0
  let yb = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      const ia = ink(a, o)
      const ib = ink(b, o)
      if (ia > threshold) inkA++
      if (ib > threshold) inkB++
      const d = Math.abs(ia - ib)
      if (d > threshold) differing++
      sumAbs += d
      if (d > max) max = d
      wa += ia
      xa += ia * x
      ya += ia * y
      wb += ib
      xb += ib * x
      yb += ib * y
    }
  }
  const n = Math.max(1, width * height)
  const most = Math.max(inkA, inkB)
  return {
    width,
    height,
    inkA,
    inkB,
    differing,
    ratio: most === 0 ? 0 : differing / most,
    meanAbs: sumAbs / n,
    max: Math.round(max),
    dx: wa > 0 && wb > 0 ? xb / wb - xa / wa : 0,
    dy: wa > 0 && wb > 0 ? yb / wb - ya / wa : 0,
  }
}

/** A visual diff for a human: A in red, B in blue, agreement in grey (opaque RGBA). */
export function diffImage(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  width: number,
  height: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    const o = i * 4
    const ia = ink(a, o)
    const ib = ink(b, o)
    const both = Math.min(ia, ib)
    out[o] = 255 - both - Math.max(0, ib - ia)
    out[o + 1] = 255 - Math.max(ia, ib)
    out[o + 2] = 255 - both - Math.max(0, ia - ib)
    out[o + 3] = 255
  }
  return out
}
