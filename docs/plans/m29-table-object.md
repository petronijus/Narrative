# M29 — First-class `TableObject` in Narrative

Add a native table object type to the slide-model + editor, then migrate
the M28 PPTX import / export paths to use it. Today tables exist only as
exploded grids of `RectangleObject` + `TextObject` shapes with a shared
`groupId` — works for "imported from PowerPoint, looks right, round-trips"
but the user can't insert a table from scratch, can't add a row, can't
resize columns independently.

> Current state lives in `apps/server/src/pptx/parser.ts` (`parseTable`)
> and `apps/server/src/pptx/export.ts` (`emitGroupedTables`). Both
> continue to work during the migration; we'll retire them in Phase 4.

## Goals

1. Users can insert a table from the toolbar and edit it inline (cell
   text + add/remove rows + columns + resize).
2. Tables survive collaboration — every mutation is a granular Yjs op
   so two peers editing different cells don't conflict.
3. PPTX import emits a `TableObject` directly instead of exploding to
   shapes. PPTX export emits `<a:tbl>` from a `TableObject` directly
   (skip the heuristic grid-detection step).
4. Backwards compat: decks already imported as exploded-cell groups
   keep rendering; an opt-in "convert grouped shapes to a table" action
   migrates them on user request.

## Non-goals

- Charts / SmartArt / OLE.
- Table styling presets like Office's built-in styles ("Medium Style 2 — Accent 1"). The
  PPTX importer keeps emitting concrete fills via the `<a:tblPr>` accent1 heuristic.
- Pivot / sort / formula functionality. Tables are visual layouts, not spreadsheets.
- Nested tables (a table cell whose content IS another table). PPTX
  supports it but the editing UX would be a nightmare.

## Data model

### `TableObject` in `@narrative/shared/slide.ts`

```ts
export interface TableObject extends BaseSlideObject {
  type: 'table'

  /** Total table dimensions are inherited from `x`/`y`/`width`/`height`
   *  on BaseSlideObject. Cell positions derive from these + col/row arrays. */

  /** Column widths in slide-local px. Sum must equal `width`. */
  colWidths: number[]
  /** Row heights in slide-local px. Sum must equal `height`. */
  rowHeights: number[]

  /** rows[r][c] = TableCell. The 2-D array shape mirrors PPTX
   *  `<a:tr>/<a:tc>`. Merged cells point to the originating (r, c) via
   *  `cell.mergeOriginR/C`; the originating cell carries `gridSpan`/
   *  `rowSpan` numbers. */
  rows: TableCell[][]

  /** Default cell styling applied when a cell doesn't override. */
  defaults: {
    fontFamily?: string
    fontSize: number
    fontWeight: FontWeight
    color: number | TokenRef
    align: 'left' | 'center' | 'right'
    vAlign: 'top' | 'middle' | 'bottom'
    fill?: number | TokenRef
    /** Per-edge stroke. Falls back to a 1px `#CCCCCC` grid when missing. */
    border?: TableBorderStyle
    /** Cell padding in px — gap between the cell edge and text. */
    padding: { top: number; right: number; bottom: number; left: number }
  }

  /** P11 stuff: hyperlink etc. inherited from BaseSlideObject. */
}

export interface TableCell {
  /** Y.Text-backed body — same rich-text pipeline as TextObject. */
  text: string | Y.Text
  /** Per-cell overrides; missing fields inherit from `table.defaults`. */
  fontSize?: number
  fontWeight?: FontWeight
  color?: number | TokenRef
  align?: 'left' | 'center' | 'right'
  vAlign?: 'top' | 'middle' | 'bottom'
  fill?: number | TokenRef
  fillAlpha?: number
  /** Per-edge border. Each edge is independently controllable — fixes the
   *  M28-era "Narrative has one stroke per shape" limitation. */
  border?: {
    top?: TableBorderStyle
    right?: TableBorderStyle
    bottom?: TableBorderStyle
    left?: TableBorderStyle
  }
  padding?: { top: number; right: number; bottom: number; left: number }
  /** Cell merge — gridSpan/rowSpan on the ORIGIN cell only; non-origin
   *  cells in the spanned range carry `mergeOriginR`/`mergeOriginC`
   *  pointing back. Origin cell renders the full merged area; pointer
   *  cells skip rendering. */
  gridSpan?: number
  rowSpan?: number
  mergeOriginR?: number
  mergeOriginC?: number
}

export interface TableBorderStyle {
  color: number | TokenRef
  width: number
  /** Stroke style. PPTX has many; we ship a sensible subset for v1. */
  dash?: 'solid' | 'dash' | 'dot'
  alpha?: number
}
```

Add `TableObject` to the `SlideObject` union + the `SlideObjectType`
enum.

### Yjs storage

A `TableObject` Y.Map looks like:

```
Y.Map {
  id, type='table', x, y, width, height, rotation, opacity, ...base...
  colWidths:  Y.Array<number>
  rowHeights: Y.Array<number>
  rows:       Y.Array<Y.Array<Y.Map>>   ← cells
  defaults:   Y.Map
}
```

Cell text is `Y.Text` for collaborative typing per cell. Cell-level
attributes (fill, border) live as flat keys on the cell Y.Map.

**Granularity decision**: storing each cell as a Y.Map means an awareness
update on cell (r, c) is a single Yjs op, no whole-table thrash. The cost
is heavier nested structure, but cheap on edit cost which is what
matters.

## Editing semantics

### Selection

- Click a table → table-selected mode. Bbox handles for outer resize.
- Click a cell → cell-selected mode (single cell). Outline that cell.
- Drag from one cell to another → multi-cell selection (range).
- Double-click a cell → cell-edit mode (in-place text editor).
- Esc → step out one level (cell-edit → cell-selected → table-selected → deselected).

### Keyboard

| Key        | Cell-edit      | Cell-selected   |
| ---------- | -------------- | --------------- |
| Tab        | next cell      | next cell       |
| Shift+Tab  | prev cell      | prev cell       |
| Enter      | next row       | enter cell-edit |
| Esc        | exit cell-edit | select table    |
| Cmd+Right  | end of line    | next col        |
| Arrow keys | move caret     | move selection  |

`Tab` past the last cell of the last row → adds a new row, jumps into
its first cell. Same convention as Apple Numbers + Google Docs.

### Mouse handles

- Outer bbox handles → resize whole table proportionally.
- Inner column dividers → drag to redistribute width between adjacent
  cols; total table width stays constant.
- Inner row dividers → drag to redistribute height.
- Hover near a column divider → "insert column" + button. Same for rows.
- Right-click cell → contextual menu (insert above/below/left/right,
  delete row/col, merge cells, split cells, clear formatting).

### Merge / split

- Multi-cell selection + "Merge cells" sets `gridSpan` × `rowSpan` on
  the top-left origin cell + `mergeOriginR/C` pointers on the others.
- "Split cells" reverses it.
- The renderer skips drawing cells whose `mergeOrigin*` is set.

## Renderer

`apps/web/src/renderer/objects/TableRenderer.ts` (new file):

- One Pixi `Container` per table.
- Children: one `Graphics` for the cell fill + border grid; one `HTMLText`
  per cell for the text (same Pixi.HTMLText pipeline TextObject uses, so
  rich-text formatting works for free).
- Diff against previous snapshot at the cell level — only repaint cells
  whose content / styling changed.
- HTMLText is expensive; cache the rendered bitmap per cell content +
  style hash. Same trick the existing TextObject renderer uses.

## Mutations API in `@narrative/slide-model`

New file `tableMutations.ts`:

```ts
addTable(ctx, slide, { rows, cols, defaults })             // toolbar action
addTableRow(ctx, tableId, atIndex, height?)                // insert row
addTableColumn(ctx, tableId, atIndex, width?)              // insert column
removeTableRow(ctx, tableId, index)
removeTableColumn(ctx, tableId, index)
resizeTableRow(ctx, tableId, index, newHeight)
resizeTableColumn(ctx, tableId, index, newWidth)
setTableCellText(ctx, tableId, r, c, text | YTextPatch)
setTableCellStyle(ctx, tableId, r, c, partialStyle)
mergeTableCells(ctx, tableId, r1, c1, r2, c2)
splitTableCell(ctx, tableId, r, c)
```

All mutations go through `doc.transact(fn, LOCAL_ORIGIN)` like every
other slide-model mutation, so UndoManager captures them.

## Toolbar + Inspector

Toolbar — new entry between "Text" and "Pen" tools:

- Icon: `Table2` from lucide-react.
- Shortcut: `K` (T is taken by Text; B used elsewhere; K is mnemonic-free
  and currently unbound).
- Click-and-drag to size, OR click to place a default 3×3 table at the
  cursor.

Inspector panels (`apps/web/src/ui/Inspector/`):

- **Table panel** (table-selected): rows, cols, total bbox, default
  cell padding, default font / fill / border, "Apply default to all
  cells" button.
- **Cell panel** (cell-selected): override font / fill / per-edge border /
  vAlign / padding. "Reset to table default" button.
- **Multi-cell panel** (range-selected): bulk-apply any of the above.

## PPTX import / export migration

**Phase 4 of the milestone** — switch the import path to produce
`TableObject` directly:

### Import side

In `apps/server/src/pptx/parser.ts`'s `parseTable`:

- Instead of exploding to `RectangleObject` + `TextObject` shapes with a
  shared `groupId`, build a `ParsedTableObject` carrying the full
  cell grid + per-cell fill / border / text-style / merge info that
  already gets captured today.
- The writer (`writer.ts`) lays the ParsedTableObject as a `TableObject`
  in the Y.Doc via the new `addTable` + `setTableCellStyle` mutations.

### Export side

In `apps/server/src/pptx/export.ts`:

- Add `case 'table'` to `emitObject`. Build a pptxgenjs `addTable(rows,
opts)` call directly from the `TableObject` — no heuristic
  grid-detection needed.
- Delete `emitGroupedTables` once Phase 4 ships (or keep it for legacy
  decks that still have grouped-shape "tables" from pre-M29 imports).

### Migration for pre-M29 decks

Decks that were imported before M29 ships still have exploded grouped
shapes. Three options:

1. **Lazy migrate** — when the editor opens a deck with a grouped-shape
   table, offer "Convert this group to a real table" in a banner.
2. **On-demand action** — right-click a group → "Convert to table"
   menu item. Same detection logic as `emitGroupedTables` (uniform grid).
3. **Automatic** — server-side migration job that scans decks for
   table-shaped groups and rewrites them. Risk: false positives on
   non-table groups.

Recommend option 2: on-demand, user-driven, zero risk of regression.

## Phased delivery

Aim for ~2 days of work total. Each phase ships independently behind
the toolbar feature flag (`VITE_FEATURE_TABLES=1`) until Phase 5.

### Phase 1 — Foundation (~4h)

- `TableObject` + `TableCell` types in `@narrative/shared`.
- Yjs schema + plain-snapshot binding in `@narrative/slide-model`.
- `addTable` mutation.
- `TableRenderer` — draws cells + borders + plain text. No editing yet.
- Toolbar entry; click places a 3×3 table at cursor.

Result: user can drop a table on a slide, it renders, persists across
reloads, collaborates between two peers.

### Phase 2 — Cell editing (~4h)

- Click → cell-selected. Double-click → cell-edit.
- Text input + Y.Text per cell, reusing TextObject's rich-text plumbing.
- Tab / Shift+Tab / Enter navigation between cells.
- Add row / column on Tab-past-last.
- Per-cell font / fill / border via inspector.
- Right-click context menu (insert / delete row / col).

Result: full hand-authoring works.

### Phase 3 — Merge + multi-cell (~3h)

- Drag selection across cells → range selection.
- Merge / split cells.
- Bulk style apply to range.
- Renderer skips `mergeOrigin*` pointers.

Result: complex table layouts (header spans, summary rows) work.

### Phase 4 — PPTX migration (~3h)

- Import: `parseTable` → ParsedTableObject → writer emits `TableObject`.
- Export: `emitObject` `case 'table'` → pptxgenjs `addTable`.
- Pre-existing grouped-shape "tables" still render correctly (no
  forced migration).
- Right-click → "Convert to table" action for grouped shapes.

Result: imported `.pptx` tables are real tables; exported `.pptx`
tables come from the model directly.

### Phase 5 — Polish (~2h)

- Animations: `fadeIn` etc. work on tables (already do, via base
  SlideObject hooks — verify).
- Folder text-style binding for cell text (reuse TextObject's
  `textStyleId` path).
- Keyboard shortcuts in cell-edit mode (Cmd+B/I/U).
- Skip-table-in-text-flow: when navigating slides with Tab, tables
  count as one stop, not many.
- Remove the feature flag, ship.

## Open design questions for tomorrow

1. **Resize semantics**: "drag right edge of column" — does it (a)
   redistribute width between this column and the next, keeping table
   width constant (Office behaviour), or (b) grow the column +
   the table, pushing right-of cells right (Google Docs behaviour)?
   Pick one; document.

2. **Default new-table size**: 3×3 at cursor with auto-sized cells?
   Or a small modal asking for rows × cols? PowerPoint and Keynote
   both show a 10×8 visual grid picker — too much for v1; default
   3×3 is fine.

3. **Cell padding default**: 8px each side? Match TextObject body
   padding for visual consistency.

4. **Whole-table fill** beyond per-cell fills: should the table itself
   carry a fill (a "table background") that shows through gaps?
   Probably no — cell fills cover everything, and per-cell borders
   already handle the grid look.

5. **Tab stops**: should `<Tab>` exit the table when on the last cell
   (move to next object on slide), or stay trapped (add a new row)?
   Default to "stay + add row" to match Numbers / Docs; Esc + Tab
   for object navigation.

6. **Per-cell hyperlinks**: PPTX supports `<a:hlinkClick>` per text
   run in a cell. Phase 2 should reuse TextObject's hyperlink path —
   no new model needed.

## Files that need touching

```
packages/shared/src/slide.ts                     — TableObject + TableCell types
packages/shared/src/index.ts                     — export new types
packages/slide-model/src/tableMutations.ts       — new file
packages/slide-model/src/bindings.ts             — yMapToTable + tableToYMap
packages/slide-model/src/slides.ts               — getSlideTablesCtx helper
packages/slide-model/src/scanTokenUsages.ts      — scan cell text + fill tokens
apps/web/src/renderer/objects/TableRenderer.ts   — new file
apps/web/src/renderer/SceneGraph.ts              — register TableRenderer
apps/web/src/ui/Toolbar.tsx                      — new tool button + shortcut
apps/web/src/ui/Inspector/InspectorTable.tsx     — new file
apps/web/src/state/ToolContext.ts                — add 'table' tool kind
apps/web/src/state/createObjectOfType.ts         — addTable seed
apps/server/src/pptx/parser.ts                   — parseTable → ParsedTableObject
apps/server/src/pptx/writer.ts                   — mapShape case 'table'
apps/server/src/pptx/export.ts                   — emitObject case 'table'
```

Approx. 12 files touched, 800–1200 LoC.

## Acceptance criteria

- [ ] Insert a 3×3 table from the toolbar; type into each cell.
- [ ] Tab past the last cell adds a new row.
- [ ] Resize a column with mouse; total table width adjusts per chosen
      semantics from Q1.
- [ ] Right-click a cell → "Merge with right" → range merges; "Split"
      reverses.
- [ ] Two peers editing different cells of the same table don't
      conflict.
- [ ] Import a `.pptx` with a table → opens as a real `TableObject`
      (verify via Yjs inspector).
- [ ] Export → re-import the same deck → table identical.
- [ ] Existing deck with a grouped-shape table from a pre-M29 import
      still renders unchanged. Right-click → "Convert to table" works.
- [ ] All existing pptx tests still pass.
