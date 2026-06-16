/**
 * objectRenderers/tableRenderer.test.ts
 *
 * PERF-4 — behavioural lock for the per-cell typing hot path.
 *
 * A single cell change reaches the renderer as a whole-`rows` patch
 * (`rows` is in STRUCTURAL_KEYS), so `reconcileCells` walks EVERY cell.
 * Before PERF-4 each visit ran `new HTMLTextStyle(...)` + `buildHtml` +
 * `applyVerticalAlign` (a DOM/Pixi measure) for all N cells. These tests
 * assert the fix: after a one-cell change only the changed cell's HTMLText
 * node is re-styled (new `.style` instance); every other cell keeps its
 * exact same `.style` reference.
 *
 * NOTE on the typing path: a Y.Text *content* edit moves the per-cell
 * fingerprint via its `html` part — but `buildHtml` returns empty under the
 * jsdom pixi mock (no real text rasterisation), so a content edit can't be
 * reproduced in a unit test. We exercise the per-cell granularity through a
 * per-cell *style* override instead (same fingerprint, mockable input); the
 * content/typing path is covered by the sampled-thumbnail e2e.
 *
 * We assert behaviour (which node got re-styled), NOT mock-call shapes,
 * per the repo's renderer-test policy.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as Y from 'yjs'
import { pixiMock } from '../../test/pixiMock'

vi.mock('pixi.js', () => pixiMock())

import { Container, HTMLText } from 'pixi.js'
import { tableRenderer } from './tableRenderer.js'
import type { TableObject, TableCell } from '@narrative/shared'

/** Build a Y.Text-backed cell with the given initial content. */
function cell(initial: string): TableCell {
  const t = new Y.Text()
  if (initial.length > 0) t.insert(0, initial)
  return { text: t }
}

/** A 2×2 table where every cell is a distinct Y.Text. */
function makeTable(cells: TableCell[][]): TableObject {
  return {
    id: 'tbl1',
    type: 'table',
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    rotation: 0,
    opacity: 1,
    colWidths: [100, 100],
    rowHeights: [50, 50],
    rows: cells,
    defaults: {
      fontSize: 14,
      fontWeight: 'normal',
      color: 0x111111,
      align: 'left',
      vAlign: 'top',
      padding: { top: 4, right: 4, bottom: 4, left: 4 },
    },
  }
}

/**
 * Collect the distinct HTMLText leaf nodes mounted under the table
 * container. Each cell mounts a clip Container holding [mask Graphics,
 * HTMLText]; HTMLText is the only child carrying `.anchor`.
 *
 * Dedupe by node identity: the test pixi mock's `addChild` plain-pushes,
 * whereas real Pixi's addChild MOVES an already-parented child (dedupes).
 * reconcileCells re-attaches each cell's clip on every patch, so under the
 * mock a clip's HTMLText can appear twice in `children`. We count distinct
 * nodes — exactly what the real scene graph holds.
 */
function collectCellTexts(container: Container): HTMLText[] {
  const seen = new Set<HTMLText>()
  const walk = (c: Container): void => {
    for (const child of c.children) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((child as any).anchor !== undefined && child instanceof HTMLText) {
        seen.add(child)
      }
      if (child instanceof Container) walk(child)
    }
  }
  walk(container)
  return [...seen]
}

function countRestyled(after: HTMLText[], styleBefore: Map<HTMLText, unknown>): number {
  let restyled = 0
  for (const t of after) {
    const prevStyle = styleBefore.get(t)
    // A node that was re-styled has a brand-new HTMLTextStyle instance.
    if (prevStyle !== undefined && t.style !== prevStyle) restyled++
  }
  return restyled
}

describe('tableRenderer — PERF-4 per-cell typing hot path', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('restyles ONLY the cell whose resolved style changed on a whole-rows patch', () => {
    const c00 = cell('A')
    const c01 = cell('B')
    const c10 = cell('C')
    const c11 = cell('D')
    const table = makeTable([
      [c00, c01],
      [c10, c11],
    ])

    const container = tableRenderer.mount(table)

    const before = collectCellTexts(container)
    expect(before).toHaveLength(4)
    // Snapshot each cell's current style instance keyed by HTMLText node.
    const styleBefore = new Map<HTMLText, unknown>(before.map((t) => [t, t.style]))

    // Change ONE cell's per-cell style override, then apply the whole-`rows`
    // patch that state-sync emits. Only cell (1,0)'s resolved style — hence
    // its fingerprint — moves. (A content edit would move only its fingerprint
    // too, but buildHtml is empty under the mock — see the file header.)
    c10.fontSize = 28
    tableRenderer.applyPatch!(container, { rows: table.rows })

    const after = collectCellTexts(container)
    // Cells are keyed by Y.Text identity, so the same four HTMLText nodes
    // survive the rebuild.
    expect(after).toHaveLength(4)
    // Exactly one cell — the changed one — got a fresh style instance.
    expect(countRestyled(after, styleBefore)).toBe(1)
  })

  it('restyles ALL cells when a real style default changes (no false skip)', () => {
    const table = makeTable([
      [cell('A'), cell('B')],
      [cell('C'), cell('D')],
    ])
    const container = tableRenderer.mount(table)

    const before = collectCellTexts(container)
    const styleBefore = new Map<HTMLText, unknown>(before.map((t) => [t, t.style]))

    // Bump the table-wide default font size — every cell's resolved style
    // changes, so the fingerprint moves for all of them.
    const next: TableObject = {
      ...table,
      defaults: { ...table.defaults, fontSize: 28 },
    }
    tableRenderer.applyPatch!(container, { defaults: next.defaults, rows: next.rows })

    const after = collectCellTexts(container)
    expect(after.length).toBe(4)
    expect(countRestyled(after, styleBefore)).toBe(after.length)
  })

  it('restyles NO cells when an identical rows patch is replayed', () => {
    const table = makeTable([
      [cell('A'), cell('B')],
      [cell('C'), cell('D')],
    ])
    const container = tableRenderer.mount(table)

    const before = collectCellTexts(container)
    const styleBefore = new Map<HTMLText, unknown>(before.map((t) => [t, t.style]))

    // No content / style change — replay the same rows. Every cell's
    // fingerprint matches, so updateCellNode short-circuits.
    tableRenderer.applyPatch!(container, { rows: table.rows })

    const after = collectCellTexts(container)
    expect(countRestyled(after, styleBefore)).toBe(0)
  })
})
