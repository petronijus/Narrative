/**
 * tableInvariants.testUtil.ts
 *
 * Test-only checker for the structural invariants of a TableObject
 * snapshot (as read through `yMapToPlainObject`). Shared by the unit
 * tests and the property test so both assert exactly the same rules:
 *
 *   1. Grid shape: `rows.length === rowHeights.length`, every row has
 *      `colWidths.length` cells.
 *   2. Size: `sum(colWidths) === width`, `sum(rowHeights) === height`
 *      (within floating-point tolerance).
 *   3. Merges: every origin (gridSpan/rowSpan > 1) carries no pointer and
 *      its span stays inside the table; every other cell of its area
 *      points back at it; every pointer targets a real origin whose span
 *      covers the pointing cell. Areas therefore never overlap.
 *   4. Border segment keys address lines that exist:
 *      `h:<r>:<c>` with r ∈ [0, rows], c ∈ [0, cols);
 *      `v:<r>:<c>` with r ∈ [0, rows), c ∈ [0, cols].
 *
 * Returns human-readable violations (empty array = valid) so a failing
 * assertion prints what broke instead of a bare `false`.
 */

import type { TableObject } from '@narrative/shared'

const EPS = 1e-6

function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= EPS * Math.max(1, Math.abs(a), Math.abs(b))
}

export function collectTableInvariantViolations(t: TableObject): string[] {
  const out: string[] = []
  const rowCount = t.rows.length
  const colCount = t.colWidths.length

  if (t.rowHeights.length !== rowCount) {
    out.push(`rowHeights.length ${t.rowHeights.length} !== rows ${rowCount}`)
  }
  t.rows.forEach((row, r) => {
    if (row.length !== colCount) out.push(`row ${r} has ${row.length} cells, expected ${colCount}`)
  })

  const colSum = t.colWidths.reduce((a, b) => a + b, 0)
  const rowSum = t.rowHeights.reduce((a, b) => a + b, 0)
  if (!near(colSum, t.width)) out.push(`sum(colWidths) ${colSum} !== width ${t.width}`)
  if (!near(rowSum, t.height)) out.push(`sum(rowHeights) ${rowSum} !== height ${t.height}`)

  for (let r = 0; r < rowCount; r++) {
    for (let c = 0; c < colCount; c++) {
      const cell = t.rows[r]?.[c]
      if (cell === undefined) continue
      const hasPtr = cell.mergeOriginR !== undefined || cell.mergeOriginC !== undefined
      const rs = cell.rowSpan ?? 1
      const cs = cell.gridSpan ?? 1
      if (hasPtr) {
        if (cell.gridSpan !== undefined || cell.rowSpan !== undefined) {
          out.push(`(${r},${c}) is covered but carries a span`)
        }
        const or = cell.mergeOriginR
        const oc = cell.mergeOriginC
        if (typeof or !== 'number' || typeof oc !== 'number') {
          out.push(`(${r},${c}) has a half pointer`)
          continue
        }
        const origin = t.rows[or]?.[oc]
        if (origin === undefined) {
          out.push(`(${r},${c}) points at missing cell (${or},${oc})`)
          continue
        }
        if (origin.mergeOriginR !== undefined || origin.mergeOriginC !== undefined) {
          out.push(`(${r},${c}) points at (${or},${oc}) which is itself covered`)
          continue
        }
        const ors = origin.rowSpan ?? 1
        const ocs = origin.gridSpan ?? 1
        if (!(r >= or && r < or + ors && c >= oc && c < oc + ocs) || (r === or && c === oc)) {
          out.push(`(${r},${c}) points at (${or},${oc}) whose ${ors}x${ocs} span does not cover it`)
        }
        continue
      }
      if (!Number.isInteger(rs) || !Number.isInteger(cs) || rs < 1 || cs < 1) {
        out.push(`(${r},${c}) has invalid span ${rs}x${cs}`)
        continue
      }
      if (rs === 1 && cs === 1) continue
      if (r + rs > rowCount || c + cs > colCount) {
        out.push(`(${r},${c}) span ${rs}x${cs} leaves the ${rowCount}x${colCount} table`)
        continue
      }
      for (let rr = r; rr < r + rs; rr++) {
        for (let cc = c; cc < c + cs; cc++) {
          if (rr === r && cc === c) continue
          const covered = t.rows[rr]?.[cc]
          if (covered?.mergeOriginR !== r || covered.mergeOriginC !== c) {
            out.push(`(${rr},${cc}) inside the span of (${r},${c}) does not point at it`)
          }
        }
      }
    }
  }

  for (const key of Object.keys(t.borderSegments ?? {})) {
    const m = /^(h|v):(\d+):(\d+)$/.exec(key)
    if (m === null) {
      out.push(`malformed border segment key ${key}`)
      continue
    }
    const row = Number(m[2])
    const col = Number(m[3])
    const ok = m[1] === 'h' ? row <= rowCount && col < colCount : row < rowCount && col <= colCount
    if (!ok) out.push(`border segment ${key} is outside the ${rowCount}x${colCount} grid`)
  }

  return out
}
