/**
 * tests/agent-eval/scenarios/helpersGeometry.ts — where an object's local
 * points are drawn on the slide, for grading point-drawn objects (paths,
 * lines) by what the audience sees rather than by their stored frame.
 */

import type { ObjectView } from '../lib/checks.js'

export interface Pt {
  x: number
  y: number
}

/** A local point of `o` (relative to its box) as drawn: rotated about the box centre, mirrored. */
export function drawnAt(o: ObjectView, p: Pt): Pt {
  const w = o.width as number
  const h = o.height as number
  const lx = (p.x - w / 2) * (o.flipH === true ? -1 : 1)
  const ly = (p.y - h / 2) * (o.flipV === true ? -1 : 1)
  const r = (o.rotation as number | undefined) ?? 0
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  return {
    x: (o.x as number) + w / 2 + cos * lx - sin * ly,
    y: (o.y as number) + h / 2 + sin * lx + cos * ly,
  }
}

/** Within `tol` slide px on both axes. */
export const near = (a: Pt, b: Pt, tol = 1): boolean =>
  Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol
