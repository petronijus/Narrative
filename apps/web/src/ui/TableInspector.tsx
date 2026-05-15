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

import { useMemo } from 'react'
import {
  type ObjectsMutationContext,
  deleteTableCol,
  deleteTableRow,
  insertTableCol,
  insertTableRow,
  setTableCellStyle,
  setTableDefaultsPatch,
} from '@narrative/slide-model'
import { isTokenRef, type TableObject } from '@narrative/shared'
import { useTableEdit } from '../state/TableEditContext.js'
import { TokenColorInput } from './TokenColorInput.js'

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
  const { active } = useTableEdit()

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

  return (
    <div className="flex flex-col gap-3 px-3 py-2 text-xs">
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
          <BtnRow label="+ Col before" disabled={isViewer} onClick={handleAddColBefore} />
          <BtnRow label="+ Col after" disabled={isViewer} onClick={handleAddColAfter} />
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
      {/* ACTIVE CELL                                                    */}
      {/* ────────────────────────────────────────────────────────────── */}
      {activeCell !== null && active !== null && (
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
        </div>
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
