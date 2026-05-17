/**
 * ui/TableInspector.tsx
 *
 * M29 Phase 2 — Inspector panel for the first-class TableObject.
 *
 * Three logical sections:
 *
 *   1. Layout       — base x/y/w/h/rotation/opacity through `patch`.
 *   2. Structure    — Rows / Columns count steppers (append or trim
 *                     from the end). Granular per-cell insert/delete
 *                     lives in the canvas right-click menu so the
 *                     inspector stays focused on table-wide controls.
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

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import * as Y from 'yjs'
import {
  type ObjectsMutationContext,
  type CellStylePatch,
  type TableBorderPreset,
  applyFormat,
  deleteTableCol,
  deleteTableRow,
  edgesForPreset,
  getTableCellYMap,
  insertTableCol,
  insertTableRow,
  LOCAL_ORIGIN,
  mergeTableCells,
  setRangeBorderPreset,
  setRangeCellStyle,
  setTableCellStyle,
  setTableDefaultsPatch,
  splitTableCell,
  updateObject,
} from '@narrative/slide-model'
import {
  isTokenRef,
  type RectangleObject,
  type SlideObject,
  type SlideObjectPatch,
  type TableObject,
  type TextObject,
  type TokenRef,
} from '@narrative/shared'
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
} from 'lucide-react'
import { useTableEdit } from '../state/TableEditContext.js'
import { useSlideObjects } from '../state/useSlideObjects.js'
import { useAnimations } from '../state/useAnimations.js'
import {
  AnimationsSection,
  FillBody,
  type FilledShape,
  IdentitySection,
  LayersPanel,
  PositionSection,
  Section,
  SubLabel,
  TransparencySlider,
  TypographySection,
} from './Inspector.js'
import { TokenColorInput } from './TokenColorInput.js'
import { AlignButtonGroup } from './AlignButtonGroup.js'
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
  const { active, range, activeBorderPreset, setActiveBorderPreset } = useTableEdit()
  // Sibling-object list — IdentitySection enforces per-slide name
  // uniqueness against this, so we feed the live slide snapshot.
  const { objects: slideObjects } = useSlideObjects()
  // AnimationsSection + LayersPanel come straight from the shape
  // inspector; both expect the same hook output (animations array +
  // mutation ctx). Hooks live at the inspector level — TableInspector
  // is unmounted when selection moves off the table, so the
  // subscriptions follow the user's focus naturally.
  const { animations, animationsCtx: animMutationCtx } = useAnimations()

  // Mirrors the `patch` closure inside the generic Inspector — feeds the
  // shared PositionSection the same write path. Viewer mode bails out so
  // the section's disabled inputs can't be subverted by a stale ref.
  const patchObject = (p: SlideObjectPatch<SlideObject>): void => {
    if (isViewer) return
    updateObject(mutationCtx, obj.id, p)
  }

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

  const activeCell = useMemo(() => {
    if (active === null || active.tableId !== obj.id) return null
    return obj.rows[active.r]?.[active.c] ?? null
  }, [active, obj])

  const d = obj.defaults

  // --- Defaults patches ---
  const patchDefault = (patch: Partial<TableObject['defaults']>): void => {
    setTableDefaultsPatch(mutationCtx, obj.id, patch)
  }

  // Synthetic TextObject that mirrors `obj.defaults` so the shared
  // TypographySection (which expects a TextObject) can drive table-
  // wide defaults. Only the typography-relevant fields matter — geometry
  // is dummied. `id` is the table's own id so the inline-format helpers
  // inside TypographySection never spuriously match an active cell-edit
  // session (cell edits use `${tableId}#${r},${c}` as their objectId).
  const defaultsAsTextObject: TextObject = useMemo(
    () => ({
      id: obj.id,
      type: 'text' as const,
      x: 0,
      y: 0,
      width: obj.width,
      height: obj.height,
      rotation: 0,
      opacity: 1,
      text: '',
      fontSize: d.fontSize,
      fontWeight: d.fontWeight,
      color: d.color,
      align: d.align,
      ...(d.fontFamily !== undefined ? { fontFamily: d.fontFamily } : {}),
      vAlign: d.vAlign,
      ...(d.italic !== undefined ? { italic: d.italic } : {}),
      ...(d.underline !== undefined ? { underline: d.underline } : {}),
      ...(d.lineHeight !== undefined ? { lineHeight: d.lineHeight } : {}),
      ...(d.letterSpacing !== undefined ? { letterSpacing: d.letterSpacing } : {}),
      ...(d.textTransform !== undefined ? { textTransform: d.textTransform } : {}),
    }),
    [obj.id, obj.width, obj.height, d],
  )

  // Adapter: TypographySection writes `SlideObjectPatch<TextObject>` —
  // we whitelist the keys TableDefaults actually persists and forward
  // them through `patchDefault`. Keys outside the whitelist
  // (`text`, `textStyleId`, `paragraphSpace*`, etc.) are ignored —
  // those features are gated off in the section's `features` prop so
  // the controls never produce patches for them.
  const TYPOGRAPHY_TO_DEFAULTS: ReadonlyArray<keyof TableObject['defaults']> = [
    'fontFamily',
    'fontSize',
    'fontWeight',
    'italic',
    'underline',
    'lineHeight',
    'letterSpacing',
    'textTransform',
    'color',
    'align',
    'vAlign',
  ]
  const patchDefaultsAsTextObject = (p: SlideObjectPatch<TextObject>): void => {
    const src = p as Record<string, unknown>
    const out: Partial<TableObject['defaults']> = {}
    let touched = false
    for (const key of TYPOGRAPHY_TO_DEFAULTS) {
      if (key in src) {
        ;(out as Record<string, unknown>)[key] = src[key]
        touched = true
      }
    }
    if (touched) patchDefault(out)
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

  // --- Keynote-style border preset + style state ------------------------
  // `activeBorderPreset` (from TableEditContext) tracks which preset
  // icon the user has selected so changes to the line style/width/
  // color below restamp the same preset over the current target.
  // Hoisting it to the context also lets the canvas overlay highlight
  // the very edges the user is about to modify — exactly how Keynote
  // shows a thin blue indicator on the currently-selected border.
  // Local state for the next-stamp style. Seeds from defaults.border
  // so the first preset click uses sensible values.
  const defaultsBorder = obj.defaults.border
  const seedColor =
    typeof defaultsBorder?.color === 'number' ? (defaultsBorder.color as number) : 0xcccccc
  const seedWidth = defaultsBorder?.width ?? 1
  const seedDash: 'solid' | 'dash' | 'dot' = defaultsBorder?.dash ?? 'solid'
  const [edgeColor, setEdgeColor] = useState<number>(seedColor)
  const [edgeWidth, setEdgeWidth] = useState<number>(seedWidth)
  const [edgeDash, setEdgeDash] = useState<'solid' | 'dash' | 'dot'>(seedDash)
  // Clear preset + reseed style whenever the user moves to a different
  // table — sticky state across tables would let style edits leak onto
  // an unrelated table on the next style change.
  const lastTableIdRef = useRef(obj.id)
  useEffect(() => {
    if (lastTableIdRef.current !== obj.id) {
      lastTableIdRef.current = obj.id
      setActiveBorderPreset(null)
      setEdgeColor(seedColor)
      setEdgeWidth(seedWidth)
      setEdgeDash(seedDash)
    }
  }, [obj.id, seedColor, seedWidth, seedDash, setActiveBorderPreset])
  // Inspector unmount = the user navigated away from this table's
  // selection. Dismiss the blue overlay so it doesn't linger on the
  // canvas when the table isn't actively being edited.
  useEffect(() => {
    return () => {
      setActiveBorderPreset(null)
    }
  }, [setActiveBorderPreset])

  /**
   * Target range for border presets: an explicit drag-selected range
   * wins, a single active cell becomes a 1×1 range, and otherwise we
   * default to the whole table so the icons stay useful when the user
   * has the table selected but no cells highlighted.
   */
  const borderTargetRange = useMemo(() => {
    if (range !== null && range.tableId === obj.id) {
      return { r0: range.r0, c0: range.c0, r1: range.r1, c1: range.c1 }
    }
    if (active !== null && active.tableId === obj.id) {
      return { r0: active.r, c0: active.c, r1: active.r, c1: active.c }
    }
    return {
      r0: 0,
      c0: 0,
      r1: Math.max(0, obj.rows.length - 1),
      c1: Math.max(0, obj.colWidths.length - 1),
    }
  }, [range, active, obj])

  const stampBorderPreset = (
    preset: TableBorderPreset,
    spec: { color: number; width: number; dash: 'solid' | 'dash' | 'dot' },
  ): void => {
    setRangeBorderPreset(mutationCtx, obj.id, borderTargetRange, preset, {
      color: spec.color,
      width: spec.width,
      dash: spec.dash,
    })
  }

  // Read the existing style on the edges this preset would target.
  // Returns the uniform {color, width, dash} when every active edge
  // matches, 'mixed' when they differ, or 'empty' when the preset
  // selects no edges (e.g. `insideH` on a 1-row table).
  //
  // Falls back to `defaults.border` whenever a cell has no per-edge
  // override — that's what the renderer would draw, so it's the
  // honest "what's currently there" for the user.
  const readPresetUniformStyle = (
    preset: TableBorderPreset,
  ): { color: number; width: number; dash: 'solid' | 'dash' | 'dot' } | 'mixed' | 'empty' => {
    const range = borderTargetRange
    const dflt = obj.defaults.border
    const dfltColor = typeof dflt?.color === 'number' ? dflt.color : 0xcccccc
    const dfltWidth = dflt?.width ?? 0
    const dfltDash: 'solid' | 'dash' | 'dot' = dflt?.dash ?? 'solid'
    let found: { color: number; width: number; dash: 'solid' | 'dash' | 'dot' } | null = null
    for (let r = range.r0; r <= range.r1; r++) {
      const row = obj.rows[r]
      if (row === undefined) continue
      for (let c = range.c0; c <= range.c1 && c < row.length; c++) {
        const cell = row[c]
        if (cell === undefined) continue
        const edges = edgesForPreset(preset, r, c, range)
        for (const edge of edges) {
          const override = cell.border?.[edge]
          const style =
            override !== undefined
              ? {
                  color: typeof override.color === 'number' ? override.color : 0xcccccc,
                  width: override.width,
                  dash: override.dash ?? 'solid',
                }
              : { color: dfltColor, width: dfltWidth, dash: dfltDash }
          if (found === null) {
            found = style
            continue
          }
          if (
            found.color !== style.color ||
            found.width !== style.width ||
            found.dash !== style.dash
          ) {
            return 'mixed'
          }
        }
      }
    }
    return found ?? 'empty'
  }

  // Mixed-state flag for the style row (color swatch / width / dash).
  // Initialised when a preset is selected; cleared when the user
  // commits any control (because committing implies "make them all
  // this value", which is unambiguous afterwards).
  const [presetMixed, setPresetMixed] = useState(false)

  const applyBorderPreset = (preset: TableBorderPreset): void => {
    // Clicking the already-active icon toggles it off — same Keynote
    // affordance, lets the user dismiss the blue selection indicator
    // without picking a different preset.
    if (activeBorderPreset?.preset === preset && activeBorderPreset.tableId === obj.id) {
      setActiveBorderPreset(null)
      setPresetMixed(false)
      return
    }
    setActiveBorderPreset({ preset, tableId: obj.id })
    // Selection-only: don't stamp. Instead, prime the style controls
    // with whatever the preset's edges currently carry so the user
    // sees a true reading and can adjust from there. The stamp
    // happens later in `updateEdgeStyle` when they actually commit
    // a control.
    const uniform = readPresetUniformStyle(preset)
    if (uniform === 'mixed') {
      setPresetMixed(true)
    } else if (uniform === 'empty') {
      setPresetMixed(false)
    } else {
      setPresetMixed(false)
      setEdgeColor(uniform.color)
      setEdgeWidth(uniform.width)
      setEdgeDash(uniform.dash)
    }
  }

  // Whenever the user tweaks style/width/color WITH a preset active,
  // stamp the active preset — that's the only path that writes
  // borders now (selecting a preset only reads, never writes).
  const updateEdgeStyle = (
    next: Partial<{ color: number; width: number; dash: 'solid' | 'dash' | 'dot' }>,
  ): void => {
    const merged = {
      color: next.color ?? edgeColor,
      width: next.width ?? edgeWidth,
      dash: next.dash ?? edgeDash,
    }
    if (next.color !== undefined) setEdgeColor(next.color)
    if (next.width !== undefined) setEdgeWidth(next.width)
    if (next.dash !== undefined) setEdgeDash(next.dash)
    // Any commit unambiguously sets every targeted edge to one value,
    // so the "mixed" indicator no longer applies.
    setPresetMixed(false)
    if (activeBorderPreset !== null && activeBorderPreset.tableId === obj.id) {
      stampBorderPreset(activeBorderPreset.preset, merged)
    }
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

  /**
   * Set the table to exactly `n` rows. Larger N appends blank rows at
   * the end; smaller N deletes from the end. Bounded at ≥1 so the
   * table never collapses to zero rows. Same logic for columns.
   */
  const setRowCount = (n: number): void => {
    const target = Math.max(1, Math.floor(n))
    const cur = obj.rows.length
    if (target === cur) return
    if (target > cur) {
      for (let i = 0; i < target - cur; i++) insertTableRow(mutationCtx, obj.id, -1)
    } else {
      // Delete from the bottom up until we reach `target`. The mutation
      // refuses to drop below 1 anyway; the explicit min above keeps
      // the loop bound safe.
      for (let i = cur - 1; i >= target; i--) deleteTableRow(mutationCtx, obj.id, i)
    }
  }
  const setColCount = (n: number): void => {
    const target = Math.max(1, Math.floor(n))
    const cur = obj.colWidths.length
    if (target === cur) return
    if (target > cur) {
      for (let i = 0; i < target - cur; i++) insertTableCol(mutationCtx, obj.id, -1)
    } else {
      for (let i = cur - 1; i >= target; i--) deleteTableCol(mutationCtx, obj.id, i)
    }
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
      {/* Shared with shapes — authored name + lock toggle. Same Section
          chrome as the generic inspector; collapse-state shared under
          storageKey="identity" so a user who closed Identity on a
          rectangle finds it closed on a table too. `objects` fed in
          from useSlideObjects for the name-uniqueness check. */}
      <IdentitySection
        obj={obj as SlideObject}
        objects={slideObjects}
        isViewer={isViewer}
        patch={patchObject}
      />
      {/* Shared with shapes / texts — layer order, alignment, X/Y, size,
          rotation, flip. The inner Section component owns its own
          collapse-state under storageKey="position" so the table picks
          up the user's last open/closed preference for free. */}
      <PositionSection
        obj={obj}
        patch={patchObject}
        disabled={isViewer}
        layerMutationCtx={mutationCtx}
      />

      {/* Shared with shapes — exact same Section / SubLabel / FillBody /
          TransparencySlider chrome the generic inspector renders.
          Fill is context-aware: range > active cell > table-wide
          defaults. Same dispatch chain the existing per-section Fill
          controls already use, but funnelled through the
          Inspector-grade Figma-style picker. Stroke / corner radius /
          gradient / image stay out — borders live in the Keynote
          preset grid below, and TableDefaults doesn't model the rest.
          `fill` writes go through patchRange / patchCell /
          patchDefault depending on what's selected; "No color" maps
          to the same dispatch with `fill: undefined`, which the
          mutations interpret as "delete the field" → cell falls back
          to defaults, or the whole table goes transparent. */}
      <TableAppearance
        obj={obj}
        isViewer={isViewer}
        mutationCtx={mutationCtx}
        active={active}
        range={range}
        patchObject={patchObject}
        patchCell={patchCell}
        patchRange={patchRange}
        patchDefault={patchDefault}
      />

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
      {/* STRUCTURE — Rows / Columns count steppers only.                */}
      {/* Granular "insert above / below / left / right" + per-cell      */}
      {/* delete live in the canvas right-click menu; surfacing them    */}
      {/* here too was redundant and crowded the inspector.             */}
      {/* ────────────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-1.5">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Structure
        </div>
        {/* Setting Rows / Columns to a higher number appends blank
            rows/cols from the end; lower deletes from the end. Min 1
            so the table can never collapse. */}
        <Row label="Rows">
          <CountStepper
            value={obj.rows.length}
            min={1}
            disabled={isViewer}
            onSet={(n) => setRowCount(n)}
          />
        </Row>
        <Row label="Columns">
          <CountStepper
            value={obj.colWidths.length}
            min={1}
            disabled={isViewer}
            onSet={(n) => setColCount(n)}
          />
        </Row>
      </div>

      {/* ────────────────────────────────────────────────────────────── */}
      {/* DEFAULTS — drives `obj.defaults` via TypographySection. The    */}
      {/* shared component renders the full text-inspector Typography   */}
      {/* row stack (family, size, weight, B/I/U, align, v-align, case, */}
      {/* line-height, letter-spacing, color). Table-only features      */}
      {/* (paragraphSpacing / listStyle / stroke / colorAlpha /         */}
      {/* textStylePreset) stay off — the TableDefaults schema doesn't  */}
      {/* model them. Padding is below as a table-only row.             */}
      {/* `defaultsAsTextObject` is a synthetic TextObject that mirrors */}
      {/* `obj.defaults` so TypographySection (which expects a real     */}
      {/* TextObject) can read every field it shows. Writes flow back   */}
      {/* through `patchDefaultsAsTextObject`, which whitelists the     */}
      {/* keys TableDefaults actually persists and ignores the rest.    */}
      {/* ────────────────────────────────────────────────────────────── */}
      <TypographySection
        obj={defaultsAsTextObject}
        patch={patchDefaultsAsTextObject}
        features={{
          textStylePreset: false,
          paragraphSpacing: false,
          listStyle: false,
          stroke: false,
          colorAlpha: false,
        }}
      />
      <Section title="Padding" storageKey="table-padding">
        <Row label="All sides">
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
      </Section>

      {/* ────────────────────────────────────────────────────────────── */}
      {/* BORDERS — Keynote-style preset grid + line style controls.    */}
      {/* Wrapped in the shared collapsible Section so users can fold   */}
      {/* it like every other inspector block. `table-border`           */}
      {/* storageKey keeps its open/closed state per-user (localStorage */}
      {/* under `narrative:inspector:collapsed:…`) — same affordance as */}
      {/* Identity / Position / Appearance / Animations.                */}
      {/* Targets the selected range > active cell > whole table.       */}
      {/* Clicking a preset selects it and primes the style controls    */}
      {/* with what's currently drawn on those edges — nothing is       */}
      {/* mutated until the user commits a style change.                */}
      {/* ────────────────────────────────────────────────────────────── */}
      <Section title="Border" storageKey="table-border">
        <BorderPresetGrid
          activePreset={activeBorderPreset?.tableId === obj.id ? activeBorderPreset.preset : null}
          disabled={isViewer}
          onApply={applyBorderPreset}
        />
        <BorderStyleControls
          color={edgeColor}
          width={edgeWidth}
          dash={edgeDash}
          mixed={presetMixed}
          disabled={
            isViewer || activeBorderPreset === null || activeBorderPreset.tableId !== obj.id
          }
          onChangeColor={(n) => updateEdgeStyle({ color: n })}
          onChangeWidth={(n) => updateEdgeStyle({ width: n })}
          onChangeDash={(v) => updateEdgeStyle({ dash: v })}
        />
      </Section>

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
            <AlignButtonGroup
              value={'left'}
              ariaLabel="Range horizontal alignment"
              disabled={isViewer}
              onChange={(v) => patchRange({ align: v })}
              options={[
                { value: 'left', label: 'Left', Icon: AlignLeft },
                { value: 'center', label: 'Center', Icon: AlignCenter },
                { value: 'right', label: 'Right', Icon: AlignRight },
              ]}
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
            <AlignButtonGroup
              value={activeCell.align ?? d.align}
              ariaLabel="Cell horizontal alignment"
              disabled={isViewer}
              onChange={(v) => patchCell({ align: v })}
              options={[
                { value: 'left', label: 'Left', Icon: AlignLeft },
                { value: 'center', label: 'Center', Icon: AlignCenter },
                { value: 'right', label: 'Right', Icon: AlignRight },
              ]}
            />
          </Row>
          <Row label="V-Align">
            <AlignButtonGroup
              value={activeCell.vAlign ?? d.vAlign}
              ariaLabel="Cell vertical alignment"
              disabled={isViewer}
              onChange={(v) => patchCell({ vAlign: v })}
              options={[
                { value: 'top', label: 'Top', Icon: AlignVerticalJustifyStart },
                { value: 'middle', label: 'Middle', Icon: AlignVerticalJustifyCenter },
                { value: 'bottom', label: 'Bottom', Icon: AlignVerticalJustifyEnd },
              ]}
            />
          </Row>
        </div>
      )}

      {/* Animations — same Section the shape inspector renders. Tables
          animate as a single object (whole-table fade / slide / etc.);
          per-cell animation isn't exposed yet, but selecting the table
          and adding a preset here works identically to shapes. */}
      {animMutationCtx !== null && (
        <AnimationsSection
          objectId={obj.id}
          animations={animations}
          mutationCtx={animMutationCtx}
          totalAnimations={animations.length}
        />
      )}

      {/* Layers panel — full slide layer list. Identical to the shape
          inspector's; renders at the bottom so it scrolls
          independently of the table-specific controls above. */}
      <LayersPanel activeIds={[obj.id]} mutationCtx={mutationCtx} readOnly={isViewer} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// BorderPresetGrid — Keynote-style 9-cell preset picker
// ---------------------------------------------------------------------------

/**
 * Glyph edges drawn inside each preset thumbnail. Each segment is shown
 * solid when "active" and faint otherwise so the user can tell at a
 * glance which edges the preset will stamp.
 *
 *   ┌─┬─┐
 *   ├─┼─┤    six segments: top/right/bottom/left (outer)
 *   └─┴─┘                  innerH (middle horizontal)
 *                          innerV (middle vertical)
 */
type PresetGlyphEdge = 'top' | 'right' | 'bottom' | 'left' | 'innerH' | 'innerV'

interface PresetDef {
  preset: TableBorderPreset
  label: string
  active: PresetGlyphEdge[]
}

/** Preset order mirrors Keynote's familiar 3×3 layout. */
const PRESETS: PresetDef[] = [
  { preset: 'outer', label: 'Outer border', active: ['top', 'right', 'bottom', 'left'] },
  {
    preset: 'all',
    label: 'All borders',
    active: ['top', 'right', 'bottom', 'left', 'innerH', 'innerV'],
  },
  { preset: 'inside', label: 'Inside borders', active: ['innerH', 'innerV'] },
  { preset: 'top', label: 'Top edge only', active: ['top'] },
  { preset: 'right', label: 'Right edge only', active: ['right'] },
  { preset: 'bottom', label: 'Bottom edge only', active: ['bottom'] },
  { preset: 'left', label: 'Left edge only', active: ['left'] },
  { preset: 'insideH', label: 'Inside horizontals', active: ['innerH'] },
  { preset: 'insideV', label: 'Inside verticals', active: ['innerV'] },
]

function PresetGlyph({ active }: { active: PresetGlyphEdge[] }) {
  const set = new Set(active)
  const seg = (key: PresetGlyphEdge, x1: number, y1: number, x2: number, y2: number) => (
    <line
      key={key}
      x1={x1}
      y1={y1}
      x2={x2}
      y2={y2}
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="square"
      opacity={set.has(key) ? 1 : 0.22}
    />
  )
  return (
    <svg width={20} height={20} viewBox="0 0 20 20" aria-hidden="true">
      {seg('top', 2, 2, 18, 2)}
      {seg('right', 18, 2, 18, 18)}
      {seg('bottom', 2, 18, 18, 18)}
      {seg('left', 2, 2, 2, 18)}
      {seg('innerH', 2, 10, 18, 10)}
      {seg('innerV', 10, 2, 10, 18)}
    </svg>
  )
}

function BorderPresetGrid({
  activePreset,
  disabled,
  onApply,
}: {
  activePreset: TableBorderPreset | null
  disabled: boolean
  onApply: (preset: TableBorderPreset) => void
}) {
  return (
    <div className="grid grid-cols-3 gap-1">
      {PRESETS.map(({ preset, label, active }) => {
        const isActive = activePreset === preset
        return (
          <button
            key={preset}
            type="button"
            title={label}
            aria-label={label}
            aria-pressed={isActive}
            disabled={disabled}
            onClick={() => onApply(preset)}
            className={[
              'flex h-8 items-center justify-center rounded-md border transition-colors',
              isActive
                ? 'border-primary bg-primary/15 text-primary'
                : 'border-input text-muted-foreground hover:border-primary hover:bg-accent/40 hover:text-foreground',
              'disabled:opacity-40 disabled:hover:border-input disabled:hover:bg-transparent',
            ].join(' ')}
          >
            <PresetGlyph active={active} />
          </button>
        )
      })}
    </div>
  )
}

/**
 * Single style configurator that drives the active preset. When the
 * user has selected a preset icon, edits here restamp that preset
 * over the current target — the user-facing "the style controls
 * configure the selected border" affordance from Keynote.
 *
 *   ┌──────────────────────────────────────────┐
 *   │   Style: [solid ▾]                       │
 *   │   Color: [■] Width: [ 1 ]                │
 *   └──────────────────────────────────────────┘
 */
function BorderStyleControls({
  color,
  width,
  dash,
  mixed,
  disabled,
  onChangeColor,
  onChangeWidth,
  onChangeDash,
}: {
  color: number
  width: number
  dash: 'solid' | 'dash' | 'dot'
  /**
   * True when the currently selected preset spans edges with differing
   * styles. The controls show a "Mixed" hint instead of a (possibly
   * misleading) single value; committing any control normalises every
   * targeted edge to that value and clears the hint.
   */
  mixed: boolean
  disabled: boolean
  onChangeColor: (n: number) => void
  onChangeWidth: (n: number) => void
  onChangeDash: (v: 'solid' | 'dash' | 'dot') => void
}) {
  return (
    <div className="flex flex-col gap-1">
      <Row label="Style">
        <select
          value={mixed ? '' : dash}
          disabled={disabled}
          onChange={(e) => onChangeDash(e.target.value as 'solid' | 'dash' | 'dot')}
          className="h-6 flex-1 rounded-md border border-input bg-background px-1.5 text-xs disabled:opacity-50"
        >
          {mixed && (
            <option value="" disabled>
              Mixed
            </option>
          )}
          <option value="solid">Solid</option>
          <option value="dash">Dashed</option>
          <option value="dot">Dotted</option>
        </select>
      </Row>
      <Row label="Color">
        {mixed ? (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChangeColor(color)}
            className="h-6 flex-1 rounded-md border border-input bg-background px-1.5 text-left text-xs text-muted-foreground disabled:opacity-50"
            title="Multiple colors — click to normalise to one"
          >
            Mixed
          </button>
        ) : (
          <ColorCell
            value={numberToHex(color)}
            disabled={disabled}
            onChange={(hex) => onChangeColor(hexToNumber(hex))}
          />
        )}
      </Row>
      <Row label="Width">
        {/* `key` swap when `mixed` flips forces the uncontrolled input to
            adopt the new placeholder / value cleanly. */}
        <NumInput
          key={mixed ? 'mixed' : `value-${width}`}
          value={width}
          min={0}
          max={20}
          step={0.5}
          placeholder={mixed ? 'Mixed' : undefined}
          disabled={disabled}
          onCommit={onChangeWidth}
        />
      </Row>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Appearance section — reuses the shape inspector's Section / SubLabel /
// FillBody / TransparencySlider so the table inspector is visually
// identical to a rectangle's. Fill writes dispatch through the existing
// table mutation helpers based on what's selected:
//   - range present       → patchRange (paint every non-merged cell)
//   - active cell present → patchCell (paint just that cell)
//   - neither             → patchDefault (table-wide default fill)
// "No color" maps to the same dispatch with `fill: undefined`, which
// the underlying mutations interpret as "delete the field" — cells
// fall back to defaults, table-wide goes transparent.
// ---------------------------------------------------------------------------

interface TableAppearanceProps {
  obj: TableObject
  isViewer: boolean
  mutationCtx: ObjectsMutationContext
  active: { tableId: string; r: number; c: number; editing: boolean } | null
  range: { tableId: string; r0: number; c0: number; r1: number; c1: number } | null
  patchObject: (p: SlideObjectPatch<SlideObject>) => void
  patchCell: (p: CellStylePatch) => void
  patchRange: (p: CellStylePatch) => void
  patchDefault: (p: Partial<TableObject['defaults']>) => void
}

function TableAppearance({
  obj,
  isViewer,
  mutationCtx,
  active,
  range,
  patchObject,
  patchCell,
  patchRange,
  patchDefault,
}: TableAppearanceProps) {
  const d = obj.defaults

  // Which scope a fill write should land on. Mirrors the priority chain
  // the border-preset code already uses.
  const scope: 'range' | 'cell' | 'table' =
    range !== null && range.tableId === obj.id
      ? 'range'
      : active !== null && active.tableId === obj.id
        ? 'cell'
        : 'table'

  // Resolved fill + alpha for display in the picker. Reads from the
  // most specific level that actually carries a value (cell override
  // > table defaults > sensible defaults). The shim still hands
  // FillBody a literal fill so the in-popover saturation picker has
  // somewhere to start when the user un-clears.
  const cellAtActive =
    scope === 'cell' && active !== null ? (obj.rows[active.r]?.[active.c] ?? null) : null
  const resolvedFill: number | TokenRef | undefined =
    (cellAtActive?.fill as number | TokenRef | undefined) ??
    (d.fill as number | TokenRef | undefined)
  const resolvedAlpha: number = cellAtActive?.fillAlpha ?? d.fillAlpha ?? 1
  // "No color" matches the shape inspector's representation: alpha 0.
  // Show the picker's empty-state chrome (checkered swatch, "No color"
  // label) whenever the resolved alpha is exactly zero.
  const emptyFill = resolvedAlpha === 0
  const seedFill: number | TokenRef = resolvedFill ?? 0xffffff

  // Shape-flavoured surrogate. FillBody reads `fill`, `fillStyle`,
  // `fillAlpha`, `opacity` — the rest of RectangleObject is filled in
  // from the real table so id/keying stays stable across renders.
  const shimmedShape: RectangleObject = {
    id: obj.id,
    type: 'rectangle',
    x: obj.x,
    y: obj.y,
    width: obj.width,
    height: obj.height,
    rotation: obj.rotation,
    opacity: obj.opacity,
    fill: seedFill,
    fillAlpha: resolvedAlpha,
  }

  /**
   * Dispatch a fill / fillAlpha write to the right scope. Picking a
   * colour on a table-wide write must override every per-cell `fill`
   * override (so the whole table truly recolours), so we clear cell
   * overrides first and then update the defaults. "No color" is
   * encoded as `fillAlpha = 0` to match the shape inspector — the
   * literal `fill` stays as a seed so picking a fresh hue later has
   * a starting point.
   */
  const writeFillPatch = (patch: { fill?: number | TokenRef; fillAlpha?: number }): void => {
    if (isViewer) return
    if (scope === 'range') {
      patchRange(patch as CellStylePatch)
      return
    }
    if (scope === 'cell') {
      patchCell(patch as CellStylePatch)
      return
    }
    // Table-wide: erase per-cell overrides for the keys we're writing
    // so the new default wins everywhere — Keynote-style "paint the
    // whole table" semantics. Wrap in a transact so the clear + set
    // land in a single Yjs update.
    const rows = obj.rows.length
    const cols = obj.colWidths.length
    mutationCtx.doc.transact(() => {
      if (rows > 0 && cols > 0) {
        const clear: CellStylePatch = {}
        if ('fill' in patch) clear.fill = undefined
        if ('fillAlpha' in patch) clear.fillAlpha = undefined
        if (Object.keys(clear).length > 0) {
          setRangeCellStyle(
            mutationCtx,
            obj.id,
            { r0: 0, c0: 0, r1: rows - 1, c1: cols - 1 },
            clear,
          )
        }
      }
      // patchDefault's type is Partial<TableDefaults> with
      // exactOptionalPropertyTypes — bare `fill?: …` doesn't accept
      // `undefined` in the value position. The underlying mutation
      // deletes the field on undefined; bypass the strict optional
      // check the same way the rest of the file's WithUndefined
      // patches do.
      patchDefault(patch as Partial<TableObject['defaults']>)
    })
  }

  const patchShim = (p: SlideObjectPatch<FilledShape>): void => {
    const next = p as Partial<RectangleObject>
    const fillNext = next.fill as number | TokenRef | undefined
    const alphaNext = next.fillAlpha
    // Combine fill + alpha into a single dispatched patch so the
    // table-wide path only emits one Yjs transaction (one clear-cells
    // pass, one defaults set). If the user is in the empty state and
    // picks a hex, auto-restore alpha to 1 so the colour is actually
    // visible — otherwise the hue change would silently no-op.
    const combined: { fill?: number | TokenRef; fillAlpha?: number } = {}
    if (fillNext !== undefined) combined.fill = fillNext
    if (alphaNext !== undefined) combined.fillAlpha = alphaNext
    if (fillNext !== undefined && alphaNext === undefined && emptyFill) {
      combined.fillAlpha = 1
    }
    if (Object.keys(combined).length > 0) writeFillPatch(combined)
    if (next.opacity !== undefined) {
      patchObject({ opacity: next.opacity } as SlideObjectPatch<SlideObject>)
    }
  }

  const clearFill = (): void => writeFillPatch({ fillAlpha: 0 })

  return (
    <Section title="Appearance" storageKey="appearance">
      <SubLabel>Fill</SubLabel>
      <FillBody obj={shimmedShape} patch={patchShim} onClear={clearFill} emptyFill={emptyFill} />

      <SubLabel>Transparency</SubLabel>
      <TransparencySlider
        id={`inspector-opacity-${obj.id}`}
        value={obj.opacity}
        disabled={isViewer}
        onChange={(v) => patchObject({ opacity: v } as SlideObjectPatch<SlideObject>)}
      />
    </Section>
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
  placeholder,
  disabled,
  onCommit,
}: {
  value: number
  min?: number
  max?: number
  step?: number
  /** Shown instead of `value` when the parent wants an empty visual
   *  state — e.g. "Mixed" when the selected edges aren't uniform. */
  placeholder?: string | undefined
  disabled?: boolean
  onCommit: (n: number) => void
}) {
  return (
    <input
      type="number"
      defaultValue={placeholder === undefined ? value : ''}
      key={value}
      min={min}
      max={max}
      step={step ?? 1}
      placeholder={placeholder}
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

/**
 * Numeric stepper — `−` and `+` buttons flanking a small read-only
 * value display, used for Rows / Columns count. Click `−` decrements,
 * `+` increments, with the same min-clamp as the underlying setter.
 * Editing the value directly is intentionally NOT supported here —
 * stepping is the safer interaction since each ± click maps to one
 * insertRow/deleteRow mutation and one undo step.
 */
function CountStepper({
  value,
  min,
  disabled,
  onSet,
}: {
  value: number
  min: number
  disabled?: boolean
  onSet: (n: number) => void
}) {
  return (
    <div className="flex h-6 items-center overflow-hidden rounded-md border border-input field-surface">
      <button
        type="button"
        aria-label="Decrease"
        disabled={disabled || value <= min}
        onClick={() => onSet(value - 1)}
        className="flex h-full w-6 items-center justify-center text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
      >
        −
      </button>
      <div className="flex h-full min-w-[2rem] flex-1 items-center justify-center border-x border-input bg-background px-2 text-xs font-medium">
        {value}
      </div>
      <button
        type="button"
        aria-label="Increase"
        disabled={disabled}
        onClick={() => onSet(value + 1)}
        className="flex h-full w-6 items-center justify-center text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
      >
        +
      </button>
    </div>
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
