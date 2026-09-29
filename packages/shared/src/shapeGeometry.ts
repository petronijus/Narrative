/**
 * The outline a triangle or a regular polygon draws inside its box, in the
 * object's local coordinates (0..w × 0..h, y down, before rotation and
 * mirroring).
 *
 * One definition for every place that draws or traces these shapes — the
 * canvas renderer, the image shape-mask, the drawing preview, shape-to-path
 * and the PPTX writer — so they cannot drift apart.
 *
 * - A **triangle** fills its box the way PowerPoint's `triangle` preset does
 *   (isosceles, apex at the top centre, base along the bottom edge), so a
 *   triangle looks the same in Narrative and in PowerPoint and survives a
 *   round trip unchanged in size.
 * - A **polygon** (3–12 sides) is the regular n-gon inscribed in the box's
 *   ellipse, first vertex at the top, clockwise.
 */

export interface ShapePoint {
  x: number
  y: number
}

/** A polygon's side count as the renderers use it: rounded, clamped to [3, 12]. */
export function polygonSides(sides: number | undefined): number {
  return Math.max(3, Math.min(12, Math.round(sides ?? 5)))
}

/** The triangle's three corners, clockwise from the apex. */
export function triangleVertices(w: number, h: number): ShapePoint[] {
  return [
    { x: w / 2, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ]
}

/**
 * The regular polygon's corners, clockwise from the top vertex, inscribed in
 * the box's ellipse. `sides` is taken as given (callers clamp with
 * {@link polygonSides} where the renderer's clamp applies).
 */
export function regularPolygonVertices(sides: number, w: number, h: number): ShapePoint[] {
  const out: ShapePoint[] = []
  for (let i = 0; i < sides; i++) {
    const t = -Math.PI / 2 + (i * 2 * Math.PI) / sides
    out.push({ x: w / 2 + (w / 2) * Math.cos(t), y: h / 2 + (h / 2) * Math.sin(t) })
  }
  return out
}
