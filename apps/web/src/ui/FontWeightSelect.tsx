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
 * - When the stored weight is one the family does not have (a deck
 *   imported with Semibold, a family whose cuts changed, folder fonts
 *   still loading), the picker SHOWS the face the browser actually
 *   renders (CSS weight matching, see `fontWeights.ts`) — it never
 *   writes to fix the value up. Viewing a box must not edit the deck:
 *   such a write would land on the viewer's undo stack and go out to
 *   every collaborator, each of whom would repeat it. The stored weight
 *   changes only when the user picks one here, or switches family in
 *   `FontFamilySelect` (which snaps it in the same patch).
 */

import { useMemo } from 'react'
import type { SlideObjectPatch, TextObject } from '@narrative/shared'
import { useFolderFontsOptional } from '../state/useFolderFonts.js'
import {
  applyInlineFormatIfSelected,
  refocusActiveTextEdit,
  getActiveTextSelection,
  isEntireContentSelected,
  clearActiveSelectionAttrs,
  clearAllInlineRunAttrs,
  transactTextAction,
} from './textEditSelection.js'
import { allowedWeightsFor, effectiveFontWeight, type NumericFontWeight } from './fontWeights.js'

interface FontWeightSelectProps {
  obj: TextObject
  patch: (p: SlideObjectPatch<TextObject>) => void
}

const ALL_WEIGHTS: ReadonlyArray<{ value: NumericFontWeight; label: string }> = [
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

export function FontWeightSelect({ obj, patch }: FontWeightSelectProps) {
  const folderFontsCtx = useFolderFontsOptional()
  const fonts = folderFontsCtx?.fonts

  // Available weights for the active family (null = any weight):
  // folder upload → the uploaded cuts; curated system stack → its list;
  // anything else → the full 100..900 range.
  const allowed = useMemo(
    () => allowedWeightsFor(obj.fontFamily, fonts ?? []),
    [obj.fontFamily, fonts],
  )
  const options =
    allowed === null ? ALL_WEIGHTS : ALL_WEIGHTS.filter((w) => allowed.includes(w.value))

  // Derived, never written back: the stored weight when the family has
  // it, else the face the browser falls back to (legacy 'normal' / 'bold'
  // read as 400 / 700).
  const displayed = effectiveFontWeight(obj.fontWeight, allowed)

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
        value={String(displayed)}
        onChange={(e) => {
          const parsed = Number.parseInt(e.target.value, 10) as NumericFontWeight
          // Per-run weight when the textarea has a non-empty selection
          // SHORTER than the full text; whole-content selection (Cmd+A)
          // becomes a box-wide patch so the picker stays consistent
          // and inline overrides on individual runs are cleared. Either
          // way the gesture is one LOCAL_ORIGIN transaction (one undo step).
          const sel = getActiveTextSelection()
          if (sel !== null && sel.objectId === obj.id) {
            transactTextAction(obj, () => {
              if (isEntireContentSelected(obj.id)) {
                clearActiveSelectionAttrs(obj.id, ['fontWeight'])
                patch({ fontWeight: parsed } as SlideObjectPatch<TextObject>)
                return
              }
              const applied = applyInlineFormatIfSelected(obj.id, { fontWeight: parsed })
              if (!applied) patch({ fontWeight: parsed } as SlideObjectPatch<TextObject>)
            })
            refocusActiveTextEdit(obj.id)
            return
          }
          transactTextAction(obj, () => {
            clearAllInlineRunAttrs(obj.text, ['fontWeight'])
            patch({ fontWeight: parsed } as SlideObjectPatch<TextObject>)
          })
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
