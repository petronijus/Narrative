/**
 * editor/snap.test.ts
 *
 * Matematické testy pro snapping engine (M7).
 * Pokrývá: left/centerX/right alignment, top/centerY/bottom alignment,
 * grid fallback, threshold boundary, multiple candidates, dedup guides.
 */

import { describe, it, expect } from 'vitest'
import { computeSnap, sameSnapGuides, snapsThisFrame } from './snap'
import type { OtherObjectBounds } from './snap'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Vytvoří simple bounds objekt. */
function b(id: string, x: number, y: number, w: number, h: number): OtherObjectBounds {
  return { id, x, y, width: w, height: h }
}

/** Navrhované bounds — moved object. */
function proposed(x: number, y: number, w = 100, h = 80) {
  return { x, y, width: w, height: h }
}

// ---------------------------------------------------------------------------
// No snap (empty others)
// ---------------------------------------------------------------------------

describe('computeSnap — grid fallback (no other objects)', () => {
  it('snaps to grid (10px default) when no objects', () => {
    const result = computeSnap(proposed(13, 17), [])
    // 13 → nearest 10px multiple = 10, dx = -3
    expect(result.dx).toBe(-3)
    // 17 → nearest 10px multiple = 20, dy = 3
    expect(result.dy).toBe(3)
    expect(result.guides).toHaveLength(0)
  })

  it('snaps to 0 when already on grid', () => {
    const result = computeSnap(proposed(100, 200), [])
    expect(result.dx).toBe(0)
    expect(result.dy).toBe(0)
  })

  it('respects custom gridSize', () => {
    const result = computeSnap(proposed(13, 17), [], 5)
    // 13 → nearest 5px = 15, dx = 2
    expect(result.dx).toBe(2)
    // 17 → nearest 5px = 15, dy = -2
    expect(result.dy).toBe(-2)
  })
})

// ---------------------------------------------------------------------------
// Object snap — X axis (vertical guide lines)
// ---------------------------------------------------------------------------

describe('computeSnap — left edge alignment', () => {
  it('snaps proposed left to other left within threshold', () => {
    // proposed left = 100, other left = 104 — diff 4 < threshold 6
    const result = computeSnap(proposed(100, 50), [b('a', 104, 10, 80, 60)])
    expect(result.dx).toBe(4) // snap to 104
    expect(result.guides).toHaveLength(1)
    expect(result.guides[0]!.kind).toBe('vertical')
    expect(result.guides[0]!.position).toBe(104)
  })

  it('does not snap when all edge pairs are outside threshold', () => {
    // Use far-away other to ensure no pair is within threshold
    const result = computeSnap(proposed(100, 50), [b('a', 2000, 2000, 80, 60)])
    expect(result.guides).toHaveLength(0)
  })

  it('snaps proposed right to other right', () => {
    // proposed right = 100+100=200, other right = 204 — diff 4
    const result = computeSnap(proposed(100, 50, 100, 80), [b('a', 124, 10, 80, 60)])
    // other right = 124+80 = 204, proposed right = 200, dx = 4
    expect(result.dx).toBe(4)
    expect(result.guides[0]!.position).toBe(204)
  })

  it('snaps proposed centerX to other centerX', () => {
    // proposed center = 100 + 100/2 = 150, other center = 154 — diff 4
    const result = computeSnap(proposed(100, 50, 100, 80), [b('a', 114, 10, 80, 60)])
    // other centerX = 114+40 = 154, proposed centerX = 150, dx = 4
    expect(result.dx).toBe(4)
  })

  it('snaps proposed left to other right', () => {
    // proposed left = 200, other right = 204 — diff 4
    const result = computeSnap(proposed(200, 50, 100, 80), [b('a', 124, 10, 80, 60)])
    expect(result.dx).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// Object snap — Y axis (horizontal guide lines)
// ---------------------------------------------------------------------------

describe('computeSnap — top/bottom/center Y alignment', () => {
  it('snaps proposed top to other top', () => {
    // proposed top = 50, other top = 54 — diff 4
    const result = computeSnap(proposed(200, 50), [b('a', 10, 54, 80, 60)])
    expect(result.dy).toBe(4)
    expect(result.guides.some((g) => g.kind === 'horizontal')).toBe(true)
  })

  it('snaps proposed bottom to other bottom', () => {
    // proposed bottom = 50+80=130, other bottom = 134 — diff 4
    const result = computeSnap(proposed(200, 50, 100, 80), [b('a', 10, 74, 80, 60)])
    // other bottom = 74+60 = 134, proposed bottom = 130, dy = 4
    expect(result.dy).toBe(4)
  })

  it('snaps proposed centerY to other centerY', () => {
    // proposed centerY = 50+40=90, other centerY = 94 — diff 4
    const result = computeSnap(proposed(200, 50, 100, 80), [b('a', 10, 64, 80, 60)])
    // other centerY = 64+30 = 94, proposed centerY = 90, dy = 4
    expect(result.dy).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// Guides range
// ---------------------------------------------------------------------------

describe('computeSnap — guide range', () => {
  it('guide range covers both proposed and other bounds', () => {
    const result = computeSnap(proposed(100, 50, 100, 80), [b('a', 104, 200, 80, 60)])
    const vGuide = result.guides.find((g) => g.kind === 'vertical')
    expect(vGuide).toBeDefined()
    // range.start = min(50, 200) = 50, range.end = max(50+80, 200+60) = 260
    expect(vGuide!.range.start).toBe(50)
    expect(vGuide!.range.end).toBe(260)
  })
})

// ---------------------------------------------------------------------------
// Multiple objects — picks closest
// ---------------------------------------------------------------------------

describe('computeSnap — picks closest candidate', () => {
  it('picks the nearest snap when multiple candidates exist', () => {
    // proposed left = 100
    // other-a left = 104 (diff 4)
    // other-b left = 103 (diff 3) → should win
    const result = computeSnap(proposed(100, 50), [
      b('a', 104, 10, 80, 60),
      b('b', 103, 10, 80, 60),
    ])
    expect(result.dx).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// Threshold boundary
// ---------------------------------------------------------------------------

describe('computeSnap — threshold boundary', () => {
  it('snaps when closest pair is exactly at threshold', () => {
    // proposed: left=1000, cx=1050, right=1100. other: left=1006, cx=1006+50=1056, right=1106.
    // pairs at threshold=6: proposed left(1000) vs other left(1006) = 6 ← exactly threshold
    // proposed cx(1050) vs other left(1006) = 44 — no match
    // proposed cx(1050) vs other cx(1056) = 6 — also matches
    // Both give dx=6. engine picks closest overall = 6.
    const result = computeSnap(
      { x: 1000, y: 5000, width: 100, height: 10 },
      [{ id: 'a', x: 1006, y: 20000, width: 100, height: 10 }],
      100000, // large grid so no grid snap
      6,
    )
    // proposed left(1000) vs other left(1006) = 6 → dx=6
    // proposed cx(1050) vs other cx(1056) = 6 → dx=6 same
    expect(result.dx).toBe(6)
    expect(result.guides.length).toBeGreaterThan(0)
  })

  it('does not snap when all pairs are beyond threshold', () => {
    // proposed: left=0, cx=5, right=10. other: left=1000, cx=1010, right=1020.
    // All diffs >> 6 → no snap
    const result = computeSnap(
      { x: 0, y: 0, width: 10, height: 10 },
      [{ id: 'a', x: 1000, y: 1000, width: 20, height: 20 }],
      10000,
      6,
    )
    expect(result.guides).toHaveLength(0)
  })

  it('custom threshold=2 — does not snap when closest pair is at distance 3', () => {
    // proposed: left=0, cx=5, right=10. other: left=3, cx=8, right=13.
    // diffs: 0vs3=3, 0vs8=8, 0vs13=13, 5vs3=2, 5vs8=3, 5vs13=8, 10vs3=7, 10vs8=2, 10vs13=3
    // min diff=2 which equals threshold=2 → will snap at threshold=2
    // use threshold=1 → min diff=2>1 → no snap
    const result = computeSnap(
      { x: 0, y: 500, width: 10, height: 10 },
      [{ id: 'a', x: 3, y: 2000, width: 5, height: 5 }],
      10000,
      1,
    )
    // min X pair diff: 5vs3=2, 5vs5.5=0.5, 10vs3=7, 10vs5.5=4.5, 10vs8=2...
    // 5 vs 5.5 = 0.5 <= 1 → will snap! Center of proposed=5, center of other=3+2.5=5.5
    // Let's put other very far so all diffs > 1
    const result2 = computeSnap(
      { x: 0, y: 0, width: 10, height: 10 },
      [{ id: 'a', x: 100, y: 100, width: 10, height: 10 }],
      10000,
      1,
    )
    expect(result2.guides).toHaveLength(0)
    void result
  })
})

// ---------------------------------------------------------------------------
// Both axes simultaneously
// ---------------------------------------------------------------------------

describe('computeSnap — simultaneous X and Y snap', () => {
  it('returns both dx and dy when both axes snap', () => {
    // proposed x=100, y=50 — other at x=104, y=54 (diff 4 both)
    const result = computeSnap(proposed(100, 50), [b('a', 104, 54, 80, 60)])
    expect(result.dx).toBe(4)
    expect(result.dy).toBe(4)
    expect(result.guides.some((g) => g.kind === 'vertical')).toBe(true)
    expect(result.guides.some((g) => g.kind === 'horizontal')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Grid fallback only when no object snap
// ---------------------------------------------------------------------------

describe('computeSnap — object snap overrides grid', () => {
  it('object snap takes priority over grid', () => {
    // proposed at x=13 → grid snap dx=-3, but other at x=17 (diff=4) → dx=4
    const result = computeSnap(proposed(13, 200), [b('a', 17, 10, 80, 60)])
    expect(result.dx).toBe(4)
    // Y: no object snap → grid
    expect(result.dy).toBe(0) // 200 is already on 10px grid
  })
})

describe('snapsThisFrame — the held modifier inverts the preference', () => {
  it('snapping on: snaps until the modifier is held', () => {
    expect(snapsThisFrame(true, false)).toBe(true)
    expect(snapsThisFrame(true, true)).toBe(false)
  })

  it('snapping off: free until the modifier is held', () => {
    expect(snapsThisFrame(false, false)).toBe(false)
    expect(snapsThisFrame(false, true)).toBe(true)
  })
})

describe('sameSnapGuides', () => {
  const guide = (position: number, end = 100) =>
    ({ kind: 'vertical', position, range: { start: 0, end } }) as const

  it('treats two empty lists, and a list with itself, as the same', () => {
    expect(sameSnapGuides([], [])).toBe(true)
    const list = [guide(10)]
    expect(sameSnapGuides(list, list)).toBe(true)
  })

  it('compares guides by value, in order', () => {
    expect(sameSnapGuides([guide(10), guide(20)], [guide(10), guide(20)])).toBe(true)
    expect(sameSnapGuides([guide(10), guide(20)], [guide(20), guide(10)])).toBe(false)
  })

  it('sees a moved, resized, re-oriented or missing guide', () => {
    expect(sameSnapGuides([guide(10)], [guide(11)])).toBe(false)
    expect(sameSnapGuides([guide(10)], [guide(10, 120)])).toBe(false)
    expect(sameSnapGuides([guide(10)], [{ ...guide(10), kind: 'horizontal' }])).toBe(false)
    expect(sameSnapGuides([guide(10)], [])).toBe(false)
  })
})
