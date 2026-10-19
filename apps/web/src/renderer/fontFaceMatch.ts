/**
 * renderer/fontFaceMatch.ts — which `@font-face` of a family the browser
 * draws a request with: the font matching algorithm of CSS Fonts 4
 * (§5.2 "Matching font styles", step 4), for the descriptors our faces carry.
 *
 * HTMLText rasterises an SVG that sees only the faces embedded into it
 * (renderer/fontChanges.ts). Embedding just the faces a text's requests
 * match keeps what it draws identical: the browser runs this same algorithm
 * over the embedded subset, and the face it would pick from the whole family
 * is in the subset, so it is still the best — removing faces that lose a
 * comparison cannot change the winner. Synthetic bold and italic follow from
 * the chosen face and the request alone, so they are unchanged too.
 *
 * The steps narrow the family's faces by width (`font-stretch`), then slope
 * (`font-style`), then weight; each keeps the faces at the best value. A
 * descriptor may be a range (a variable face, "100 900"): a request inside it
 * is an exact match, one outside it is as far away as the nearer end.
 */

export type FaceSlope = 'normal' | 'italic' | 'oblique'

/** A face's descriptors, as its `@font-face` rule declares them. */
export interface MatchableFace {
  /** "400", or a variable face's range "100 900". */
  weight: string
  style: FaceSlope
  /** "100%", or a range "75% 125%". */
  stretch: string
}

/** What one element of the text asks for. */
export interface FaceRequest {
  /** 1–1000 (`normal` = 400, `bold` = 700). */
  weight: number
  style: 'normal' | 'italic'
  /** Percent; 100 = normal. */
  stretch: number
}

type Range = readonly [number, number]

function parseRange(value: string, unit = ''): Range {
  const parts = value
    .trim()
    .split(/\s+/)
    .map((p) => Number.parseFloat(unit === '' ? p : p.replace(unit, '')))
    .filter((n) => Number.isFinite(n))
  if (parts.length === 0) return [Number.NaN, Number.NaN]
  const a = parts[0]!
  const b = parts[1] ?? a
  return a <= b ? [a, b] : [b, a]
}

/**
 * Where a face's range stands for a desired value: `[tier, distance]`,
 * lower is better. Tier 0 contains the value; then the faces on the side
 * the specification checks first (`preferBelow`), then the other side.
 */
function rankRange(range: Range, desired: number, preferBelow: boolean): [number, number] {
  const [min, max] = range
  if (desired >= min && desired <= max) return [0, 0]
  const below = max < desired
  const distance = below ? desired - max : min - desired
  return [below === preferBelow ? 1 : 2, distance]
}

/** The faces of `faces` with the lowest rank (ties kept). */
function keepBest<T>(faces: readonly T[], rank: (face: T) => readonly number[]): T[] {
  let best: readonly number[] | null = null
  let kept: T[] = []
  for (const face of faces) {
    const r = rank(face)
    const cmp = best === null ? -1 : compare(r, best)
    if (cmp < 0) {
      best = r
      kept = [face]
    } else if (cmp === 0) {
      kept.push(face)
    }
  }
  return kept
}

function compare(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** Width: at or below normal, narrower faces first (nearest first); above it, wider ones. */
function stretchRank(face: MatchableFace, desired: number): readonly number[] {
  const range = parseRange(face.stretch, '%')
  if (Number.isNaN(range[0])) return rankRange([100, 100], desired, desired <= 100)
  return rankRange(range, desired, desired <= 100)
}

/**
 * Slope: italic → oblique → normal for an italic request; normal → oblique →
 * italic otherwise — the specification's order, where an `oblique` face
 * without an angle leans 14deg and an italic one is a class of its own.
 * Chromium and WebKit (2026-10, `e2e/htmltext-face-subset.spec.ts`) give an
 * angle-less `oblique` face the italic slope instead, 20deg: the two tie and
 * the weight decides between them. Both models are run (`matchFaces`).
 */
function styleRank(
  face: MatchableFace,
  desired: FaceRequest['style'],
  obliqueIsItalic: boolean,
): readonly number[] {
  const slope = obliqueIsItalic && face.style === 'oblique' ? 'italic' : face.style
  const order: readonly FaceSlope[] =
    desired === 'italic' ? ['italic', 'oblique', 'normal'] : ['normal', 'oblique', 'italic']
  return [order.indexOf(slope)]
}

/**
 * Weight: a request in 400–500 takes the weights above it up to 500 (nearest
 * first), then those below it (nearest first), then those above 500; below
 * 400 the lighter weights come first, above 500 the heavier ones.
 */
function weightRank(face: MatchableFace, desired: number): readonly number[] {
  const range = parseRange(face.weight)
  const [min, max] = Number.isNaN(range[0]) ? ([400, 400] as const) : range
  if (desired >= min && desired <= max) return [0, 0]
  if (desired >= 400 && desired <= 500) {
    if (min > desired && min <= 500) return [1, min - desired]
    if (max < desired) return [2, desired - max]
    return [3, min - desired]
  }
  return rankRange([min, max], desired, desired < 400)
}

function matchOne<T extends MatchableFace>(
  faces: readonly T[],
  request: FaceRequest,
  obliqueIsItalic: boolean,
): T[] {
  const byStretch = keepBest(faces, (f) => stretchRank(f, request.stretch))
  const byStyle = keepBest(byStretch, (f) => styleRank(f, request.style, obliqueIsItalic))
  return keepBest(byStyle, (f) => weightRank(f, request.weight))
}

/**
 * The faces the browser draws `request` with: one, or several declared
 * with the same descriptors (they form one composite face) — and, where the
 * specification and the engines disagree (an `oblique` face next to an
 * italic one), the pick of each, so every engine finds its own winner in the
 * subset. In `faces`' order; empty only when `faces` is.
 */
export function matchFaces<T extends MatchableFace>(
  faces: readonly T[],
  request: FaceRequest,
): T[] {
  const picked = new Set([...matchOne(faces, request, true), ...matchOne(faces, request, false)])
  return faces.filter((f) => picked.has(f))
}
