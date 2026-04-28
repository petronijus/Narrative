/**
 * renderer/strokeDashed.ts
 *
 * P5b: Pixi v8's Graphics.stroke() has no dash option, so we trace dashed
 * strokes manually. The idea: given an ordered list of points along the
 * outline, walk the polyline at alternating dash / gap intervals and emit
 * moveTo+lineTo for every dashed subsegment. One trailing stroke() call
 * paints them all with the target colour + width.
 *
 * Curves (ellipse, rounded-rect corners, bezier paths) are sampled to
 * polylines at a resolution fine enough that dashes follow the curve
 * visually even at high zoom.
 */

import type { Graphics } from 'pixi.js'

export interface DashedStrokeOptions {
  color: number
  width: number
  /** Stroke alpha 0..1. Default 1. */
  alpha?: number
  /** Dash length (on) in slide-px. */
  dashLen?: number
  /** Gap length (off) in slide-px. */
  gapLen?: number
}

/**
 * Draw a dashed polyline. `points` describes the ordered vertices. When
 * `closed` is true, a segment from the last point back to the first is
 * appended before walking.
 */
export function strokeDashedPolyline(
  g: Graphics,
  points: Array<{ x: number; y: number }>,
  closed: boolean,
  opts: DashedStrokeOptions,
): void {
  if (points.length < 2) return
  const dashLen = opts.dashLen ?? Math.max(4, opts.width * 3)
  const gapLen = opts.gapLen ?? Math.max(4, opts.width * 2)

  // Helper to walk a single segment, continuing the on/off phase so the
  // dashes flow smoothly across vertex joins.
  let phase: 'on' | 'off' = 'on'
  let remaining = dashLen

  const emit = (fromX: number, fromY: number, toX: number, toY: number, on: boolean): void => {
    if (!on) return
    g.moveTo(fromX, fromY)
    g.lineTo(toX, toY)
  }

  const walkSegment = (ax: number, ay: number, bx: number, by: number): void => {
    const dx = bx - ax
    const dy = by - ay
    const len = Math.hypot(dx, dy)
    if (len === 0) return
    const ux = dx / len
    const uy = dy / len

    let consumed = 0
    let curX = ax
    let curY = ay
    while (consumed < len) {
      const step = Math.min(remaining, len - consumed)
      const nx = curX + ux * step
      const ny = curY + uy * step
      emit(curX, curY, nx, ny, phase === 'on')
      curX = nx
      curY = ny
      consumed += step
      remaining -= step
      if (remaining <= 0) {
        phase = phase === 'on' ? 'off' : 'on'
        remaining = phase === 'on' ? dashLen : gapLen
      }
    }
  }

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!
    const b = points[i + 1]!
    walkSegment(a.x, a.y, b.x, b.y)
  }
  if (closed && points.length > 1) {
    const last = points[points.length - 1]!
    const first = points[0]!
    walkSegment(last.x, last.y, first.x, first.y)
  }

  g.stroke({ color: opts.color, alpha: opts.alpha ?? 1, width: opts.width, alignment: 0.5 })
}

// ---------------------------------------------------------------------------
// Sampling helpers — turn parametric shapes into polylines for dashing.
// ---------------------------------------------------------------------------

/** Sample an ellipse centred at (cx,cy) with radii (rx, ry) as a polyline. */
export function sampleEllipse(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  steps = 64,
): Array<{ x: number; y: number }> {
  const pts: Array<{ x: number; y: number }> = []
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2
    pts.push({ x: cx + Math.cos(t) * rx, y: cy + Math.sin(t) * ry })
  }
  return pts
}

/**
 * Sample a rounded rectangle outline as a polyline. Handles per-corner
 * radii. Corners are sampled at `cornerSteps` segments each.
 */
export function sampleRoundedRect(
  w: number,
  h: number,
  r: { tl: number; tr: number; br: number; bl: number },
  cornerSteps = 8,
): Array<{ x: number; y: number }> {
  const maxR = Math.min(w, h) / 2
  const tl = Math.max(0, Math.min(r.tl, maxR))
  const tr = Math.max(0, Math.min(r.tr, maxR))
  const br = Math.max(0, Math.min(r.br, maxR))
  const bl = Math.max(0, Math.min(r.bl, maxR))
  const pts: Array<{ x: number; y: number }> = []
  const arc = (
    cx: number,
    cy: number,
    radius: number,
    startAngle: number,
    endAngle: number,
  ): void => {
    if (radius <= 0) {
      pts.push({ x: cx + Math.cos(startAngle) * 0, y: cy + Math.sin(startAngle) * 0 })
      return
    }
    for (let i = 0; i <= cornerSteps; i++) {
      const t = startAngle + ((endAngle - startAngle) * i) / cornerSteps
      pts.push({ x: cx + Math.cos(t) * radius, y: cy + Math.sin(t) * radius })
    }
  }
  // Trace clockwise from top-left corner.
  pts.push({ x: tl, y: 0 })
  pts.push({ x: w - tr, y: 0 })
  arc(w - tr, tr, tr, -Math.PI / 2, 0)
  pts.push({ x: w, y: h - br })
  arc(w - br, h - br, br, 0, Math.PI / 2)
  pts.push({ x: bl, y: h })
  arc(bl, h - bl, bl, Math.PI / 2, Math.PI)
  pts.push({ x: 0, y: tl })
  arc(tl, tl, tl, Math.PI, (3 * Math.PI) / 2)
  return pts
}
