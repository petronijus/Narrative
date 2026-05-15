/**
 * ui/TableInspector.tsx
 *
 * M29 Phase 2 — Inspector panel for the first-class TableObject.
 *
 * Three logical sections:
 *
 *   1. Layout       — base x/y/w/h/rotation/opacity through `patch`.
 *   2. Structure    — insert/delete row + col around the active cell.
 *                     "Active cell" is read from TableEditContext; when
 *                     no cell is active, the buttons operate on the
 *                     last row / last col so the user can still grow
 *                     the table from a fresh selection.
 *   3. Defaults     — table-wide style (font size, weight, color,
 *                     align, border color/width, padding).
 *   4. Active cell  — per-cell overrides (fill, color, font-size,
 *                     alignments) with a reset-to-default action.
 *                     Only renders when a cell is active.
 *
 * Writes go through `setTableCellStyle`, `setTableDefaultsPatch`, and
 * the row/col mutations exported from `@narrative/slide-model`. All
 * mutations are atomic via `ctx.doc.transact()` — no parallel React
 * state.
 */

import { useMemo, useSyncExternalStore } from 'react'
import * as Y from 'yjs'
import {
  type ObjectsMutationContext,
  type CellStylePatch,
  applyFormat,
  deleteTableCol,
  deleteTableRow,
  getTableCellYMap,
  insertTableCol,
  insertTableRow,
  LOCAL_ORIGIN,
  mergeTableCells,
  setRangeCellStyle,
  setTableCellStyle,
  setTableDefaultsPatch,
  splitTableCell,
} from '@narrative/slide-model'
import { isTokenRef, type TableObject } from '@narrative/shared'
import { useTableEdit } from '../state/TableEditContext.js'
import { TokenColorInput } from './TokenColorInput.js'
import {
  applyInlineFormatIfSelected,
  getActiveTextSelection,
  readActiveSelectionAttrs,
  refocusActiveTextEdit,
  subscribeActiveTextSelection,
} from './textEditSelection.js'

function numberToHex(value: number): string {
  return '#' + value.toString(16).padStart(6, '0')
}

function hexToNumber(hex: string): number {
  const trimmed = hex.replace(/^#/, '')
  const parsed = parseInt(trimmed, 16)
  if (Number.isFinite(parsed)) return parsed
  return 0
}

function resolveHex(v: number | { $token: string } | undefined, fallbackHex: string): string {
  if (v === undefined) return fallbackHex
  if (typeof v === 'object' && isTokenRef(v)) return fallbackHex // token render TBD; show fallback in the picker
  return numberToHex(v as number)
}

export interface TableInspectorProps {
  obj: TableObject
  mutationCtx: ObjectsMutationContext
  isViewer: boolean
}

export function TableInspector({ obj, mutationCtx, isViewer }: TableInspectorProps) {
  const { active, range } = useTableEdit()

  // Re-render when the active text selection (cell editor publishes
  // here) changes so the toolbar's pressed state stays accurate as
  // the user moves the caret across runs of varying format.
  useSyncExternalStore(subscribeActiveTextSelection, getActiveTextSelection, getActiveTextSelection)
  // Cell editor publishes objectId in the form `${tableId}#${r},${c}`;
  // matches the same template used by `TableCellEditor`. Anything
  // outside this prefix is ignored — the inspector targets only the
  // currently-edited cell, never some other text object.
  const editingObjectId =
    active !== null && active.editing && active.tableId === obj.id
      ? `${obj.id}#${active.r},${active.c}`
      : null
  const selectionAttrs = editingObjectId === null ? null : readActiveSelectionAttrs(editingObjectId)

  // The (r, c) that structural mutations and cell-override edits target.
  // When the editor isn't tracking an active cell (user clicked the table
  // body but never a specific cell), default to (rowCount-1, colCount-1)
  // so "+ Row Below" / "+ Col After" still produce sensible appends.
  const target = useMemo(() => {
    if (active !== null && active.tableId === obj.id) {
      return { r: active.r, c: active.c }
    }
    return { r: obj.rows.length - 1, c: obj.colWidths.length - 1 }
  }, [active, obj])

  const activeCell = useMemo(() => {
    if (active === null || active.tableId !== obj.id) return null
    return obj.rows[active.r]?.[active.c] ?? null
  }, [active, obj])

  const d = obj.defaults

  // --- Structure mutations ---
  const handleAddRowAbove = () => insertTableRow(mutationCtx, obj.id, target.r)
  const handleAddRowBelow = () => insertTableRow(mutationCtx, obj.id, target.r + 1)
  const handleDeleteRow = () => deleteTableRow(mutationCtx, obj.id, target.r)
  const handleAddColBefore = () => insertTableCol(mutationCtx, obj.id, target.c)
  const handleAddColAfter = () => insertTableCol(mutationCtx, obj.id, target.c + 1)
  const handleDeleteCol = () => deleteTableCol(mutationCtx, obj.id, target.c)

  // --- Defaults patches ---
  const patchDefault = (patch: Partial<TableObject['defaults']>): void => {
    setTableDefaultsPatch(mutationCtx, obj.id, patch)
  }

  // --- Active cell patches (no-op when no active cell) ---
  const patchCell = (patch: Parameters<typeof setTableCellStyle>[4]): void => {
    if (active === null || active.tableId !== obj.id) return
    setTableCellStyle(mutationCtx, obj.id, active.r, active.c, patch)
  }

  // --- Range patches (M29 Phase 3) — applied to every non-continuation
  //     cell in the drag-selected rectangle. Falls back to per-cell when
  //     no range is set so the same callback shape can drive both
  //     single-cell and multi-cell controls.
  const patchRange = (patch: CellStylePatch): void => {
    if (range !== null && range.tableId === obj.id) {
      setRangeCellStyle(
        mutationCtx,
        obj.id,
        { r0: range.r0, c0: range.c0, r1: range.r1, c1: range.c1 },
        patch,
      )
      return
    }
    patchCell(patch as Parameters<typeof setTableCellStyle>[4])
  }

  const rangeInfo = useMemo(() => {
    if (range === null || range.tableId !== obj.id) return null
    const r0 = Math.min(range.r0, range.r1)
    const r1 = Math.max(range.r0, range.r1)
    const c0 = Math.min(range.c0, range.c1)
    const c1 = Math.max(range.c0, range.c1)
    const count = (r1 - r0 + 1) * (c1 - c0 + 1)
    const origin = obj.rows[r0]?.[c0]
    const originIsMerge =
      origin !== undefined && ((origin.gridSpan ?? 1) > 1 || (origin.rowSpan ?? 1) > 1)
    return { r0, c0, r1, c1, count, originIsMerge }
  }, [range, obj])

  const handleMerge = (): void => {
    if (rangeInfo === null) return
    mergeTableCells(mutationCtx, obj.id, {
      r0: rangeInfo.r0,
      c0: rangeInfo.c0,
      r1: rangeInfo.r1,
      c1: rangeInfo.c1,
    })
  }

  const handleSplit = (): void => {
    if (active === null || active.tableId !== obj.id) return
    splitTableCell(mutationCtx, obj.id, active.r, active.c)
  }

  const applyAndRefocus = (attrs: Parameters<typeof applyInlineFormatIfSelected>[1]): void => {
    if (editingObjectId === null) return
    // Try the inline-format path first (user has highlighted text);
    // if that returns false (collapsed caret), fall back to formatting
    // the entire cell text so the picker / toggle still has visible
    // effect — matches the "you can color a cell without selecting"
    // expectation users have from Excel / Numbers.
    const ok = applyInlineFormatIfSelected(editingObjectId, attrs)
    if (!ok && active !== null && active.tableId === obj.id) {
      const cellY = getTableCellYMap(mutationCtx, obj.id, active.r, active.c)
      const yText = cellY?.get('text')
      if (yText instanceof Y.Text && yText.length > 0) {
        // Wrap in a transact with LOCAL_ORIGIN so the undo manager
        // captures the format change. Without the origin, the Y.Text
        // mutation runs in an implicit transact whose origin is
        // undefined, which the UndoManager filters out.
        mutationCtx.doc.transact(() => {
          applyFormat(yText, 0, yText.length, attrs)
        }, LOCAL_ORIGIN)
      }
    }
    refocusActiveTextEdit(editingObjectId)
  }

  return (
    <div className="flex flex-col gap-3 px-3 py-2 text-xs">
      {/* ────────────────────────────────────────────────────────────── */}
      {/* TEXT FORMAT (Phase 5 / advanced typing)                        */}
      {/* Only renders while a cell is in edit mode and there is a       */}
      {/* non-collapsed selection in that cell.                           */}
      {/* ────────────────────────────────────────────────────────────── */}
      {editingObjectId !== null && (
        <div className="flex flex-col gap-1.5">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Text format
          </div>
          <div className="flex items-center gap-1.5">
            <FormatToggle
              label="B"
              pressed={(selectionAttrs?.fontWeight ?? 400) >= 600}
              disabled={isViewer || selectionAttrs === null}
              onClick={() => {
                const isBold = (selectionAttrs?.fontWeight ?? 400) >= 600
                applyAndRefocus({ fontWeight: isBold ? 400 : 700 })
              }}
              bold
            />
            <FormatToggle
              label="I"
              pressed={selectionAttrs?.italic === true}
              disabled={isViewer || selectionAttrs === null}
              onClick={() => applyAndRefocus({ italic: selectionAttrs?.italic !== true })}
              italic
            />
            <FormatToggle
              label="U"
              pressed={selectionAttrs?.underline === true}
              disabled={isViewer || selectionAttrs === null}
              onClick={() => applyAndRefocus({ underline: selectionAttrs?.underline !== true })}
              underline
            />
            <div className="ml-2 flex flex-1 items-center gap-1.5">
              <ColorCell
                value={resolveHex(selectionAttrs?.color, '#111111')}
                disabled={isViewer || selectionAttrs === null}
                onChange={(hex) => applyAndRefocus({ color: hexToNumber(hex) })}
              />
            </div>
          </div>
          <div className="text-[10px] text-muted-foreground/70">
            {selectionAttrs === null
              ? 'Select text inside the cell to format it'
              : 'Toggles apply to the highlighted range'}
          </div>
        </div>
      )}

      {/* ────────────────────────────────────────────────────────────── */}
      {/* STRUCTURE                                                      */}
      {/* ────────────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-1.5">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Structure
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <BtnRow
            label={`+ Row above (r=${target.r})`}
            disabled={isViewer}
            onClick={handleAddRowAbove}
          />
          <BtnRow label={`+ Row below`} disabled={isViewer} onClick={handleAddRowBelow} />
          <BtnRow label="+ Col left" disabled={isViewer} onClick={handleAddColBefore} />
          <BtnRow label="+ Col right" disabled={isViewer} onClick={handleAddColAfter} />
          <BtnRow
            label="− Delete row"
            danger
            disabled={isViewer || obj.rows.length <= 1}
            onClick={handleDeleteRow}
          />
          <BtnRow
            label="− Delete col"
            danger
            disabled={isViewer || obj.colWidths.length <= 1}
            onClick={handleDeleteCol}
          />
        </div>
        <div className="text-[10px] text-muted-foreground/70">
          Targets r=
          {target.r}, c={target.c}
          {active !== null && active.tableId === obj.id
            ? active.editing
              ? ' (editing)'
              : ' (active)'
            : ' (last cell — pick one to target)'}
        </div>
      </div>

      {/* ────────────────────────────────────────────────────────────── */}
      {/* DEFAULTS                                                       */}
      {/* ────────────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-1.5">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Defaults
        </div>
        <Row label="Font size">
          <NumInput
            value={d.fontSize}
            min={6}
            max={200}
            disabled={isViewer}
            onCommit={(n) => patchDefault({ fontSize: n })}
          />
        </Row>
        <Row label="Font weight">
          <select
            value={String(d.fontWeight)}
            disabled={isViewer}
            onChange={(e) =>
              patchDefault({
                fontWeight: e.target.value === 'bold' ? 'bold' : 'normal',
              })
            }
            className="h-6 flex-1 rounded-md border border-input bg-background px-1.5 text-xs disabled:opacity-50"
          >
            <option value="normal">Normal</option>
            <option value="bold">Bold</option>
          </select>
        </Row>
        <Row label="Text color">
          <ColorCell
            value={resolveHex(d.color, '#111111')}
            disabled={isViewer}
            onChange={(hex) => patchDefault({ color: hexToNumber(hex) })}
          />
        </Row>
        <Row label="Align">
          <SegBtns
            value={d.align}
            options={[
              { v: 'left', label: 'L' },
              { v: 'center', label: 'C' },
              { v: 'right', label: 'R' },
            ]}
            disabled={isViewer}
            onChange={(v) => patchDefault({ align: v as 'left' | 'center' | 'right' })}
          />
        </Row>
        <Row label="V-Align">
          <SegBtns
            value={d.vAlign}
            options={[
              { v: 'top', label: 'T' },
              { v: 'middle', label: 'M' },
              { v: 'bottom', label: 'B' },
            ]}
            disabled={isViewer}
            onChange={(v) => patchDefault({ vAlign: v as 'top' | 'middle' | 'bottom' })}
          />
        </Row>
        <Row label="Border color">
          <ColorCell
            value={resolveHex(d.border?.color, '#cccccc')}
            disabled={isViewer}
            onChange={(hex) =>
              patchDefault({
                border: {
                  color: hexToNumber(hex),
                  width: d.border?.width ?? 1,
                },
              })
            }
          />
        </Row>
        <Row label="Border width">
          <NumInput
            value={d.border?.width ?? 1}
            min={0}
            max={20}
            step={0.5}
            disabled={isViewer}
            onCommit={(n) =>
              patchDefault({
                border: {
                  color: typeof d.border?.color === 'number' ? d.border.color : 0xcccccc,
                  width: n,
                },
              })
            }
          />
        </Row>
        <Row label="Padding">
          <NumInput
            value={d.padding.top}
            min={0}
            max={64}
            disabled={isViewer}
            onCommit={(n) =>
              patchDefault({
                padding: { top: n, right: n, bottom: n, left: n },
              })
            }
          />
        </Row>
      </div>

      {/* ────────────────────────────────────────────────────────────── */}
      {/* RANGE (Phase 3 — multi-cell drag selection)                    */}
      {/* ────────────────────────────────────────────────────────────── */}
      {rangeInfo !== null && (
        <div className="flex flex-col gap-1.5">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Selection ({rangeInfo.count} cells)
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <BtnRow label="Merge cells" disabled={isViewer} onClick={handleMerge} />
            <BtnRow
              label="Split"
              disabled={isViewer || !rangeInfo.originIsMerge}
              onClick={handleSplit}
            />
          </div>
          <Row label="Fill all">
            <ColorCell
              value="#ffffff"
              disabled={isViewer}
              onChange={(hex) => patchRange({ fill: hexToNumber(hex) })}
            />
          </Row>
          <Row label="Text color">
            <ColorCell
              value={resolveHex(d.color, '#111111')}
              disabled={isViewer}
              onChange={(hex) => patchRange({ color: hexToNumber(hex) })}
            />
          </Row>
          <Row label="Align">
            <SegBtns
              value={'left'}
              options={[
                { v: 'left', label: 'L' },
                { v: 'center', label: 'C' },
                { v: 'right', label: 'R' },
              ]}
              disabled={isViewer}
              onChange={(v) => patchRange({ align: v as 'left' | 'center' | 'right' })}
            />
          </Row>
        </div>
      )}

      {/* ────────────────────────────────────────────────────────────── */}
      {/* ACTIVE CELL                                                    */}
      {/* ────────────────────────────────────────────────────────────── */}
      {rangeInfo === null && activeCell !== null && active !== null && (
        <div className="flex flex-col gap-1.5">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Cell ({active.r}, {active.c})
          </div>
          <Row label="Fill">
            <div className="flex flex-1 items-center gap-1.5">
              <ColorCell
                value={
                  activeCell.fill !== undefined ? resolveHex(activeCell.fill, '#ffffff') : '#ffffff'
                }
                disabled={isViewer}
                onChange={(hex) => patchCell({ fill: hexToNumber(hex) })}
              />
              {activeCell.fill !== undefined && (
                <button
                  type="button"
                  className="text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-40"
                  disabled={isViewer}
                  onClick={() => patchCell({ fill: undefined })}
                >
                  reset
                </button>
              )}
            </div>
          </Row>
          <Row label="Text color">
            <div className="flex flex-1 items-center gap-1.5">
              <ColorCell
                value={resolveHex(activeCell.color, resolveHex(d.color, '#111111'))}
                disabled={isViewer}
                onChange={(hex) => patchCell({ color: hexToNumber(hex) })}
              />
              {activeCell.color !== undefined && (
                <button
                  type="button"
                  className="text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-40"
                  disabled={isViewer}
                  onClick={() => patchCell({ color: undefined })}
                >
                  reset
                </button>
              )}
            </div>
          </Row>
          <Row label="Font size">
            <NumInput
              value={activeCell.fontSize ?? d.fontSize}
              min={6}
              max={200}
              disabled={isViewer}
              onCommit={(n) => patchCell({ fontSize: n })}
            />
          </Row>
          <Row label="Align">
            <SegBtns
              value={activeCell.align ?? d.align}
              options={[
                { v: 'left', label: 'L' },
                { v: 'center', label: 'C' },
                { v: 'right', label: 'R' },
              ]}
              disabled={isViewer}
              onChange={(v) => patchCell({ align: v as 'left' | 'center' | 'right' })}
            />
          </Row>
          <Row label="V-Align">
            <SegBtns
              value={activeCell.vAlign ?? d.vAlign}
              options={[
                { v: 'top', label: 'T' },
                { v: 'middle', label: 'M' },
                { v: 'bottom', label: 'B' },
              ]}
              disabled={isViewer}
              onChange={(v) => patchCell({ vAlign: v as 'top' | 'middle' | 'bottom' })}
            />
          </Row>
          <CellBorderEditor
            cell={activeCell}
            defaults={d}
            disabled={isViewer}
            onPatch={(border) => patchCell({ border })}
          />
        </div>
      )}
    </div>
  )
}

/**
 * Per-edge border editor for one cell. Each edge is toggleable (button)
 * + its own colour swatch + width input. "Clear" returns the cell to
 * inheriting the table's uniform default border on every edge.
 */
function CellBorderEditor({
  cell,
  defaults,
  disabled,
  onPatch,
}: {
  cell: ReturnType<TableObject['rows'][number]['at']> extends infer T
    ? T extends TableObject['rows'][number][number]
      ? T
      : never
    : never
  defaults: TableObject['defaults']
  disabled: boolean
  onPatch: (border: TableObject['rows'][number][number]['border']) => void
}) {
  const edges = ['top', 'right', 'bottom', 'left'] as const
  type Edge = (typeof edges)[number]
  // Default border colour / width used as the seed when a user enables
  // an edge for the first time. Matches the renderer's fallback so the
  // visual is predictable.
  const seedBorder = (): { color: number; width: number } => ({
    color:
      typeof defaults.border?.color === 'number' ? (defaults.border.color as number) : 0xcccccc,
    width: defaults.border?.width ?? 1,
  })
  // Returns the per-edge spec the inspector is rendering for: cell
  // override > undefined (i.e. inheriting default).
  const edgeOverride = (edge: Edge): { color: number; width: number } | undefined => {
    const v = cell.border?.[edge]
    if (v === undefined) return undefined
    return {
      color: typeof v.color === 'number' ? (v.color as number) : 0xcccccc,
      width: v.width,
    }
  }
  const setEdge = (edge: Edge, spec: { color: number; width: number } | undefined): void => {
    const next: NonNullable<typeof cell.border> = { ...(cell.border ?? {}) }
    if (spec === undefined) delete (next as Record<string, unknown>)[edge]
    else next[edge] = spec
    // Empty record collapses to undefined so the cell goes back to
    // inheriting defaults on every edge.
    const hasAny = (Object.keys(next) as Edge[]).some((k) => next[k] !== undefined)
    onPatch(hasAny ? next : undefined)
  }
  return (
    <div className="flex flex-col gap-1">
      <div className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Borders
      </div>
      {edges.map((edge) => {
        const cur = edgeOverride(edge)
        const enabled = cur !== undefined
        const label = edge.charAt(0).toUpperCase() + edge.slice(1)
        return (
          <div key={edge} className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setEdge(edge, enabled ? undefined : seedBorder())}
              disabled={disabled}
              aria-pressed={enabled}
              className={[
                'h-6 w-12 rounded-md border text-[10px] font-medium',
                enabled
                  ? 'border-primary bg-primary/15 text-primary'
                  : 'border-input text-muted-foreground hover:bg-accent/40',
                'disabled:opacity-40',
              ].join(' ')}
            >
              {label}
            </button>
            <div className="flex flex-1 items-center gap-1.5">
              <ColorCell
                value={resolveHex(cur?.color, '#cccccc')}
                disabled={disabled || !enabled}
                onChange={(hex) =>
                  enabled && setEdge(edge, { color: hexToNumber(hex), width: cur?.width ?? 1 })
                }
              />
              <input
                type="number"
                min={0}
                max={20}
                step={0.5}
                value={cur?.width ?? ''}
                placeholder={String(defaults.border?.width ?? 1)}
                disabled={disabled || !enabled}
                onChange={(e) => {
                  const n = Number(e.target.value)
                  if (Number.isFinite(n)) {
                    setEdge(edge, { color: cur?.color ?? 0xcccccc, width: n })
                  }
                }}
                className="h-6 w-14 rounded-md border border-input bg-background px-1.5 text-xs disabled:opacity-50"
              />
            </div>
          </div>
        )
      })}
      {cell.border !== undefined && (
        <button
          type="button"
          onClick={() => onPatch(undefined)}
          disabled={disabled}
          className="self-start text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-40"
        >
          Reset all edges
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tiny presentational helpers — kept local to keep the rest of the
// Inspector's design-system imports unchanged.
// ---------------------------------------------------------------------------

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <label className="w-20 flex-shrink-0 text-[11px] text-muted-foreground">{label}</label>
      <div className="flex flex-1 items-center gap-1.5">{children}</div>
    </div>
  )
}

function BtnRow({
  label,
  onClick,
  disabled,
  danger,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[
        'h-6 rounded-md border px-1.5 text-[10px] font-medium transition-colors',
        danger
          ? 'border-destructive/40 text-destructive hover:bg-destructive/10'
          : 'border-input hover:bg-accent/40',
        'disabled:opacity-40',
      ].join(' ')}
    >
      {label}
    </button>
  )
}

function NumInput({
  value,
  min,
  max,
  step,
  disabled,
  onCommit,
}: {
  value: number
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  onCommit: (n: number) => void
}) {
  return (
    <input
      type="number"
      defaultValue={value}
      key={value}
      min={min}
      max={max}
      step={step ?? 1}
      disabled={disabled}
      className="h-6 w-full rounded-md border border-input bg-background px-1.5 text-xs disabled:opacity-50"
      onBlur={(e) => {
        const n = Number(e.target.value)
        if (Number.isFinite(n)) onCommit(n)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
    />
  )
}

function ColorCell({
  value,
  onChange,
  disabled,
}: {
  value: string
  onChange: (hex: string) => void
  disabled?: boolean
}) {
  if (disabled === true) {
    return (
      <div className="flex h-6 w-full items-center gap-1 rounded-md border border-input px-1.5 opacity-50">
        <span
          className="block h-3 w-3 rounded border border-border"
          style={{ background: value }}
        />
        <span className="text-[10px] uppercase">{value}</span>
      </div>
    )
  }
  return (
    <div className="flex h-6 w-full items-center gap-1 rounded-md border border-input px-1.5">
      <TokenColorInput
        value={value}
        onChange={onChange}
        ariaLabel="color"
        showHex
        inputClassName="!h-4 !w-5"
        hexClassName="!h-4 !border-0 !bg-transparent !px-1 !py-0 !text-[10px] uppercase"
      />
    </div>
  )
}

function SegBtns<T extends string>({
  value,
  options,
  disabled,
  onChange,
}: {
  value: T
  options: { v: T; label: string }[]
  disabled?: boolean
  onChange: (v: T) => void
}) {
  return (
    <div className="flex h-6 overflow-hidden rounded-md border border-input">
      {options.map((opt) => (
        <button
          key={opt.v}
          type="button"
          aria-pressed={value === opt.v}
          disabled={disabled}
          onClick={() => onChange(opt.v)}
          className={[
            'flex-1 px-1.5 text-[10px] font-medium transition-colors',
            value === opt.v
              ? 'bg-primary text-primary-foreground'
              : 'bg-background text-muted-foreground hover:bg-accent/40',
            'disabled:opacity-40',
          ].join(' ')}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

function FormatToggle({
  label,
  pressed,
  disabled,
  onClick,
  bold,
  italic,
  underline,
}: {
  label: string
  pressed: boolean
  disabled?: boolean
  onClick: () => void
  bold?: boolean
  italic?: boolean
  underline?: boolean
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      data-text-edit-keep-focus
      // Stops the editor's onBlur from firing when we click the button.
      // TextEditOverlay's blur-closes-edit-mode logic uses this same
      // data attribute to identify safe focus targets — we honour it
      // for the table editor too (it shares the same global selection
      // slot).
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={[
        'flex h-6 w-6 items-center justify-center rounded-md border text-[12px] transition-colors',
        pressed
          ? 'border-primary bg-primary/15 text-primary'
          : 'border-input text-muted-foreground hover:bg-accent/40',
        'disabled:opacity-40',
        bold ? 'font-bold' : '',
        italic ? 'italic' : '',
        underline ? 'underline' : '',
      ].join(' ')}
    >
      {label}
    </button>
  )
}
