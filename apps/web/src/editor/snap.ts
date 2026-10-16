/**
 * editor/snap.ts
 *
 * Snapping engine pro editor-ui (M7).
 *
 * Logika:
 * - Pro každý z 6 "strings" proposedBounds (left, centerX, right, top, centerY, bottom):
 *   najdi nejbližší match v otherObjects do threshold px.
 * - Grid fallback: pokud žádný object snap, zaokrouhli na gridSize násobky.
 * - Vrátí korekci (dx, dy) a SnapGuide[] pro vizualizaci.
 *
 * Bez externích závislostí, čistá matematika — snadno testovatelné.
 */

export interface SnapGuide {
  kind: 'vertical' | 'horizontal'
  /** Světová souřadnice — x pro vertical, y pro horizontal */
  position: number
  /** Segment pro vizualizaci */
  range: { start: number; end: number }
}

export interface SnapResult {
  dx: number
  dy: number
  guides: SnapGuide[]
}

export interface BoundsRect {
  x: number
  y: number
  width: number
  height: number
}

export interface OtherObjectBounds extends BoundsRect {
  id: string
}

/**
 * P11: extra snap target — a single deck-level alignment guide. Each
 * guide is a 1D constraint on either the X axis (vertical guide) or
 * the Y axis (horizontal guide). Shape mirrors `DeckGuide` from
 * @narrative/shared but kept local to avoid a cross-package coupling
 * for what's a tiny dataclass.
 */
export interface SnapGuideTarget {
  orientation: 'horizontal' | 'vertical'
  position: number
}

/**
 * Vypočítá snap korekci a guideline pro drag/resize operace.
 *
 * @param proposedBounds - Navrhované bounds po aktuálním dragu (před snap korekcí)
 * @param otherObjectBounds - Bounds ostatních objektů na slidu
 * @param gridSize - Velikost mřížky pro grid snap (default 10px)
 * @param threshold - Tolerance v px pro object snap (default 6px)
 */
export function computeSnap(
  proposedBounds: BoundsRect,
  otherObjectBounds: OtherObjectBounds[],
  gridSize: number = 10,
  threshold: number = 6,
  extraGuides: ReadonlyArray<SnapGuideTarget> = [],
): SnapResult {
  const { x, y, width, height } = proposedBounds

  // 6 "edge strings" navrhovaných bounds
  const proposedLeft = x
  const proposedCenterX = x + width / 2
  const proposedRight = x + width
  const proposedTop = y
  const proposedCenterY = y + height / 2
  const proposedBottom = y + height

  let bestDx: number | null = null
  let bestDy: number | null = null
  let bestDxDist = threshold + 1
  let bestDyDist = threshold + 1

  const guides: SnapGuide[] = []

  // Kandidáti pro snap guides — hromadíme a vybereme nejbližší
  const verticalCandidates: Array<{
    dx: number
    dist: number
    position: number
    rangeStart: number
    rangeEnd: number
  }> = []
  const horizontalCandidates: Array<{
    dy: number
    dist: number
    position: number
    rangeStart: number
    rangeEnd: number
  }> = []

  for (const other of otherObjectBounds) {
    const otherLeft = other.x
    const otherCenterX = other.x + other.width / 2
    const otherRight = other.x + other.width
    const otherTop = other.y
    const otherCenterY = other.y + other.height / 2
    const otherBottom = other.y + other.height

    // Vertical snap candidates (X axis alignment)
    const xPairs: Array<[number, number]> = [
      [proposedLeft, otherLeft],
      [proposedLeft, otherCenterX],
      [proposedLeft, otherRight],
      [proposedCenterX, otherLeft],
      [proposedCenterX, otherCenterX],
      [proposedCenterX, otherRight],
      [proposedRight, otherLeft],
      [proposedRight, otherCenterX],
      [proposedRight, otherRight],
    ]

    for (const [proposedEdge, otherEdge] of xPairs) {
      const dist = Math.abs(proposedEdge - otherEdge)
      if (dist <= threshold) {
        const delta = otherEdge - proposedEdge
        // Range: min/max Y pro vizualizaci guide line
        const rangeStart = Math.min(y, other.y)
        const rangeEnd = Math.max(y + height, other.y + other.height)
        verticalCandidates.push({
          dx: delta,
          dist,
          position: otherEdge,
          rangeStart,
          rangeEnd,
        })
      }
    }

    // Horizontal snap candidates (Y axis alignment)
    const yPairs: Array<[number, number]> = [
      [proposedTop, otherTop],
      [proposedTop, otherCenterY],
      [proposedTop, otherBottom],
      [proposedCenterY, otherTop],
      [proposedCenterY, otherCenterY],
      [proposedCenterY, otherBottom],
      [proposedBottom, otherTop],
      [proposedBottom, otherCenterY],
      [proposedBottom, otherBottom],
    ]

    for (const [proposedEdge, otherEdge] of yPairs) {
      const dist = Math.abs(proposedEdge - otherEdge)
      if (dist <= threshold) {
        const delta = otherEdge - proposedEdge
        const rangeStart = Math.min(x, other.x)
        const rangeEnd = Math.max(x + width, other.x + other.width)
        horizontalCandidates.push({
          dy: delta,
          dist,
          position: otherEdge,
          rangeStart,
          rangeEnd,
        })
      }
    }
  }

  // P11: deck-level alignment guides act like a free-floating "edge" at
  // a fixed slide-px coord. Match against all three proposed-X edges
  // (left, centerX, right) for vertical guides; same for Y on horizontal
  // guides. Range spans the full slide so the snap line draws across
  // the artboard at the guide's position.
  for (const g of extraGuides) {
    if (g.orientation === 'vertical') {
      const proposedXs: Array<number> = [proposedLeft, proposedCenterX, proposedRight]
      for (const proposedEdge of proposedXs) {
        const dist = Math.abs(proposedEdge - g.position)
        if (dist <= threshold) {
          verticalCandidates.push({
            dx: g.position - proposedEdge,
            dist,
            position: g.position,
            rangeStart: y,
            rangeEnd: y + height,
          })
        }
      }
    } else {
      const proposedYs: Array<number> = [proposedTop, proposedCenterY, proposedBottom]
      for (const proposedEdge of proposedYs) {
        const dist = Math.abs(proposedEdge - g.position)
        if (dist <= threshold) {
          horizontalCandidates.push({
            dy: g.position - proposedEdge,
            dist,
            position: g.position,
            rangeStart: x,
            rangeEnd: x + width,
          })
        }
      }
    }
  }

  // Vyber nejbližší vertical candidate
  for (const c of verticalCandidates) {
    if (c.dist < bestDxDist) {
      bestDxDist = c.dist
      bestDx = c.dx
    }
  }

  // Vyber nejbližší horizontal candidate
  for (const c of horizontalCandidates) {
    if (c.dist < bestDyDist) {
      bestDyDist = c.dist
      bestDy = c.dy
    }
  }

  // Emit guides jen pro nejbližší dx/dy
  if (bestDx !== null) {
    // Najdi všechny candidates se stejným dx (může být víc snap lines se stejnou korekcí)
    for (const c of verticalCandidates) {
      if (c.dx === bestDx) {
        guides.push({
          kind: 'vertical',
          position: c.position,
          range: { start: c.rangeStart, end: c.rangeEnd },
        })
      }
    }
  }

  if (bestDy !== null) {
    for (const c of horizontalCandidates) {
      if (c.dy === bestDy) {
        guides.push({
          kind: 'horizontal',
          position: c.position,
          range: { start: c.rangeStart, end: c.rangeEnd },
        })
      }
    }
  }

  // Grid fallback: pokud žádný object snap, zaokrouhli na gridSize násobky
  const finalDx =
    bestDx !== null ? bestDx : Math.round(proposedLeft / gridSize) * gridSize - proposedLeft

  const finalDy =
    bestDy !== null ? bestDy : Math.round(proposedTop / gridSize) * gridSize - proposedTop

  return {
    dx: finalDx,
    dy: finalDy,
    guides,
  }
}

/**
 * Whether a drag or resize frame snaps (to objects, deck guides and the
 * grid fallback). The editor's snapping preference, inverted for as long
 * as the platform modifier (⌘ on macOS, Ctrl elsewhere) is held — the
 * same "hold to override" as Keynote's ⌘ and Figma's Ctrl. With snapping
 * on, the modifier frees the drag; with it off, the modifier snaps.
 */
export function snapsThisFrame(snappingEnabled: boolean, modifierHeld: boolean): boolean {
  return snappingEnabled !== modifierHeld
}

/**
 * Whether two guide lists draw the same lines. Every pointer move of a drag
 * computes a fresh list, mostly an empty one or the same guide as the move
 * before; setting state to an equal-but-new array re-rendered the whole
 * editor for nothing.
 */
export function sameSnapGuides(a: readonly SnapGuide[], b: readonly SnapGuide[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((g, i) => {
    const o = b[i]!
    return (
      g.kind === o.kind &&
      g.position === o.position &&
      g.range.start === o.range.start &&
      g.range.end === o.range.end
    )
  })
}
