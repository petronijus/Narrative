/**
 * ui/FontFamilySelect.tsx
 *
 * P15: native <select> with system fonts + an <optgroup> of deck-
 * uploaded custom fonts, plus a small upload button that opens the
 * FontUploadSheet. Used inside the Inspector's text section.
 *
 * Custom font values use just the family name (CSS picks the
 * weight/style from the @font-face descriptors); system fonts use the
 * full CSS stack so the fallback chain stays sensible.
 */

import { Upload } from 'lucide-react'
import { useState, useMemo } from 'react'
import type { SlideObjectPatch, TextObject } from '@narrative/shared'
import { useDeckFonts } from '../state/useDeckFonts.js'
import { FontUploadSheet } from './FontUploadSheet.js'
import {
  applyInlineFormatIfSelected,
  refocusActiveTextEdit,
  getActiveTextSelection,
} from './textEditSelection.js'

interface FontFamilySelectProps {
  obj: TextObject
  patch: (p: SlideObjectPatch<TextObject>) => void
  disabled: boolean
}

const SYSTEM_FONTS: ReadonlyArray<{ label: string; value: string }> = [
  { label: 'Inter', value: 'Inter, system-ui, sans-serif' },
  { label: 'Helvetica', value: "'Helvetica Neue', Helvetica, Arial, sans-serif" },
  { label: 'Georgia', value: "Georgia, 'Times New Roman', serif" },
  { label: 'Times', value: "'Times New Roman', Times, serif" },
  { label: 'Courier', value: "'Courier New', Courier, monospace" },
  { label: 'SF Mono', value: "'SF Mono', Menlo, monospace" },
]

export function FontFamilySelect({ obj, patch, disabled }: FontFamilySelectProps) {
  const { fonts } = useDeckFonts()
  const [sheetOpen, setSheetOpen] = useState(false)

  // Group custom fonts by family so multiple weights/styles collapse
  // to one picker entry. The picker stores `family` only — the
  // explicit fontWeight field on the TextObject already controls
  // which uploaded face the browser picks via @font-face matching.
  const customFamilies = useMemo(() => {
    const set = new Set<string>()
    for (const f of fonts) set.add(f.family)
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [fonts])

  return (
    <div className="flex flex-1 items-center gap-1" data-text-edit-keep-focus>
      <select
        id={`inspector-fontfamily-${obj.id}`}
        value={obj.fontFamily ?? ''}
        disabled={disabled}
        onChange={(e) => {
          const value = e.target.value === '' ? undefined : e.target.value
          const sel = getActiveTextSelection()
          if (sel !== null && sel.objectId === obj.id && value !== undefined) {
            // Pixi v8 HTMLText's font-family scraper splits on whitespace
            // (`font-family:([^;"\s]+)`), so we have to emit the primary
            // family token only — passing the full "Inter, system-ui,
            // sans-serif" stack would break the @font-face embed.
            const primary =
              value
                .split(',')[0]
                ?.trim()
                .replace(/^["']|["']$/g, '') ?? value
            const applied = applyInlineFormatIfSelected(obj.id, { fontFamily: primary })
            if (!applied) {
              patch({ fontFamily: value } as unknown as SlideObjectPatch<TextObject>)
            }
            refocusActiveTextEdit(obj.id)
            return
          }
          patch({ fontFamily: value } as unknown as SlideObjectPatch<TextObject>)
        }}
        className={[
          'flex-1 min-w-0 rounded border border-input field-surface px-2 py-0.5',
          'text-xs text-foreground',
          'focus:border-ring focus:outline-none',
          disabled ? 'opacity-50' : '',
        ].join(' ')}
      >
        <option value="">System default</option>
        <optgroup label="System">
          {SYSTEM_FONTS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </optgroup>
        {customFamilies.length > 0 && (
          <optgroup label="Custom (this deck)">
            {customFamilies.map((family) => (
              <option key={family} value={family}>
                {family}
              </option>
            ))}
          </optgroup>
        )}
      </select>

      <button
        type="button"
        onClick={() => setSheetOpen(true)}
        disabled={disabled}
        aria-label="Upload custom font"
        title="Upload custom font for this deck"
        className={[
          'flex h-6 w-6 flex-shrink-0 items-center justify-center rounded',
          'text-muted-foreground/70 transition-colors',
          'hover:bg-accent hover:text-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
          disabled ? 'pointer-events-none opacity-40' : '',
        ].join(' ')}
      >
        <Upload className="h-3.5 w-3.5" aria-hidden="true" />
      </button>

      {sheetOpen && <FontUploadSheet onClose={() => setSheetOpen(false)} />}
    </div>
  )
}
