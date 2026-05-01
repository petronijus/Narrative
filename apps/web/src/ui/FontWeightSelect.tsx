/**
 * ui/FontWeightSelect.tsx
 *
 * P15: weight dropdown that adapts to the selected font family.
 *
 * - Fonts that aren't in the deck's custom registry (System default,
 *   the curated stacks Inter/Helvetica/etc.) get the full 100..900
 *   range — the browser handles synthesis or falls back gracefully.
 * - Custom deck fonts get only the weights actually uploaded under
 *   that family. Picking a weight that wasn't uploaded would cause
 *   the browser to drop back to the fallback chain (looks like the
 *   font "didn't take").
 * - When the user switches to a custom family that doesn't include
 *   the current weight, we patch fontWeight to the closest available
 *   weight so the text stays rendered with the chosen face.
 */

import { useEffect, useMemo } from 'react'
import type { SlideObjectPatch, TextObject } from '@narrative/shared'
import { useFolderFontsOptional } from '../state/useFolderFonts.js'
import { SYSTEM_FONTS } from './FontFamilySelect.js'
import {
  applyInlineFormatIfSelected,
  refocusActiveTextEdit,
  getActiveTextSelection,
  isEntireContentSelected,
  clearActiveSelectionAttrs,
  clearAllInlineRunAttrs,
} from './textEditSelection.js'

interface FontWeightSelectProps {
  obj: TextObject
  patch: (p: SlideObjectPatch<TextObject>) => void
}

const ALL_WEIGHTS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 100, label: 'Thin 100' },
  { value: 200, label: 'Extra light 200' },
  { value: 300, label: 'Light 300' },
  { value: 400, label: 'Regular 400' },
  { value: 500, label: 'Medium 500' },
  { value: 600, label: 'Semibold 600' },
  { value: 700, label: 'Bold 700' },
  { value: 800, label: 'Extra bold 800' },
  { value: 900, label: 'Black 900' },
]

function pickPrimaryFamily(fontFamily: string | undefined): string | null {
  if (fontFamily === undefined || fontFamily === '') return null
  const first =
    fontFamily
      .split(',')[0]
      ?.trim()
      .replace(/^["']|["']$/g, '') ?? ''
  return first === '' ? null : first
}

function nearestWeight(target: number, available: ReadonlyArray<number>): number {
  let best = available[0] ?? 400
  let bestDelta = Math.abs(target - best)
  for (const w of available) {
    const d = Math.abs(target - w)
    if (d < bestDelta) {
      best = w
      bestDelta = d
    }
  }
  return best
}

export function FontWeightSelect({ obj, patch }: FontWeightSelectProps) {
  const folderFontsCtx = useFolderFontsOptional()
  const fonts = folderFontsCtx?.fonts ?? []

  // Resolve the current value as a number (the legacy 'normal' / 'bold'
  // strings map to 400 / 700 in the picker UI).
  const currentNumeric: number = useMemo(() => {
    if (obj.fontWeight === 'normal') return 400
    if (obj.fontWeight === 'bold') return 700
    return obj.fontWeight
  }, [obj.fontWeight])

  // Resolve the available weights for the active family:
  // 1. Folder font upload → only the cuts actually uploaded.
  // 2. System font stack → the curated list on SYSTEM_FONTS.
  // 3. Unknown family / "System default" → the full 100..900 range.
  const primary = pickPrimaryFamily(obj.fontFamily)
  const customWeights = useMemo(() => {
    if (primary === null) return null
    const matches = fonts.filter((f) => f.family === primary)
    if (matches.length === 0) return null
    const set = new Set<number>()
    for (const m of matches) set.add(m.weight)
    return [...set].sort((a, b) => a - b)
  }, [primary, fonts])

  const systemWeights = useMemo(() => {
    if (customWeights !== null) return null
    if (obj.fontFamily === undefined || obj.fontFamily === '') return null
    const sys = SYSTEM_FONTS.find((f) => f.value === obj.fontFamily)
    return sys ? [...sys.weights] : null
  }, [customWeights, obj.fontFamily])

  const allowed = customWeights ?? systemWeights
  const options =
    allowed === null ? ALL_WEIGHTS : ALL_WEIGHTS.filter((w) => allowed.includes(w.value))

  // If the current weight isn't in the list (e.g. user just switched
  // family from System to a custom one with only 400 + 700), nudge
  // fontWeight to the nearest available so the rendered face matches
  // the picker label.
  useEffect(() => {
    if (allowed === null) return
    if (allowed.includes(currentNumeric)) return
    const next = nearestWeight(currentNumeric, allowed) as
      | 100
      | 200
      | 300
      | 400
      | 500
      | 600
      | 700
      | 800
      | 900
    patch({ fontWeight: next } as SlideObjectPatch<TextObject>)
    // Intentionally not depending on `patch` — it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primary, currentNumeric, allowed?.join(',')])

  return (
    <div className="flex items-center gap-2" data-text-edit-keep-focus>
      <label
        htmlFor={`inspector-fontweight-${obj.id}`}
        className="w-16 flex-shrink-0 text-xs text-muted-foreground"
      >
        Weight
      </label>
      <select
        id={`inspector-fontweight-${obj.id}`}
        value={String(currentNumeric)}
        onChange={(e) => {
          const parsed = Number.parseInt(e.target.value, 10) as
            | 100
            | 200
            | 300
            | 400
            | 500
            | 600
            | 700
            | 800
            | 900
          // Per-run weight when the textarea has a non-empty selection
          // SHORTER than the full text; whole-content selection (Cmd+A)
          // becomes a box-wide patch so the picker stays consistent
          // and inline overrides on individual runs are cleared.
          const sel = getActiveTextSelection()
          if (sel !== null && sel.objectId === obj.id) {
            if (isEntireContentSelected(obj.id)) {
              clearActiveSelectionAttrs(obj.id, ['fontWeight'])
              patch({ fontWeight: parsed } as SlideObjectPatch<TextObject>)
              refocusActiveTextEdit(obj.id)
              return
            }
            const applied = applyInlineFormatIfSelected(obj.id, { fontWeight: parsed })
            if (!applied) patch({ fontWeight: parsed } as SlideObjectPatch<TextObject>)
            refocusActiveTextEdit(obj.id)
            return
          }
          clearAllInlineRunAttrs(obj.text, ['fontWeight'])
          patch({ fontWeight: parsed } as SlideObjectPatch<TextObject>)
        }}
        className={[
          'flex-1 rounded border border-input field-surface px-2 py-0.5',
          'text-xs text-foreground',
          'focus:border-ring focus:outline-none',
        ].join(' ')}
      >
        {options.map((w) => (
          <option
            key={w.value}
            value={w.value}
            style={
              obj.fontFamily !== undefined && obj.fontFamily !== ''
                ? { fontFamily: obj.fontFamily, fontWeight: w.value }
                : { fontWeight: w.value }
            }
          >
            {w.label}
          </option>
        ))}
      </select>
    </div>
  )
}
