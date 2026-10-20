/**
 * ui/FontFamilySelect.tsx
 *
 * Native <select> with system fonts + an <optgroup> of folder-uploaded
 * custom fonts, plus a small upload button that opens the
 * FolderFontUploadDialog. Used inside the Inspector's text section.
 *
 * Custom font values use just the family name (CSS picks the
 * weight/style from the @font-face descriptors); system fonts use the
 * full CSS stack so the fallback chain stays sensible.
 *
 * M16 P3 (consolidated): uploaded fonts are folder-scoped only; the
 * legacy deck-fonts pipeline has been removed.
 */

import { Upload } from 'lucide-react'
import { useState, useMemo } from 'react'
import type { SlideObjectPatch, TextObject } from '@narrative/shared'
import { useFolderFontsOptional } from '../state/useFolderFonts.js'
import { FolderFontUploadDialog } from './lazyEditorParts.js'
import { SYSTEM_FONTS, pickPrimaryFamily } from '@narrative/commands'
import { refocusActiveTextEdit } from './textEditSelection.js'
import { useTextFormat } from './useTextFormat.js'

interface FontFamilySelectProps {
  obj: TextObject
  patch: (p: SlideObjectPatch<TextObject>) => void
  disabled: boolean
}

export function FontFamilySelect({ obj, patch, disabled }: FontFamilySelectProps) {
  const folderFontsCtx = useFolderFontsOptional()
  const textFormat = useTextFormat()
  const [sheetOpen, setSheetOpen] = useState(false)

  // Group folder-level custom fonts by family.
  const folderFamilies = useMemo(() => {
    if (!folderFontsCtx) return []
    const set = new Set<string>()
    for (const f of folderFontsCtx.fonts) set.add(f.family)
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [folderFontsCtx])

  return (
    <div className="flex flex-1 items-center gap-1" data-text-edit-keep-focus>
      <select
        id={`inspector-fontfamily-${obj.id}`}
        value={obj.fontFamily ?? ''}
        disabled={disabled}
        onChange={(e) => {
          const value = e.target.value === '' ? undefined : e.target.value
          // The selected part of the text being edited takes the family
          // inline; otherwise the whole box does, and its command keeps the
          // weight on a cut the new family has (text.setBoxTypography, or
          // table.style.table for a table's defaults).
          const box = (): void =>
            patch({ fontFamily: value } as unknown as SlideObjectPatch<TextObject>)
          if (value === undefined) box()
          else
            textFormat.applyTypography(
              obj.id,
              { fontFamily: pickPrimaryFamily(value) ?? value },
              box,
            )
          refocusActiveTextEdit(obj.id)
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
        {folderFamilies.length > 0 && (
          <optgroup label="Folder fonts">
            {folderFamilies.map((family) => (
              <option key={`folder-${family}`} value={family}>
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
        title="Upload custom font for this folder"
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

      {sheetOpen && <FolderFontUploadDialog onClose={() => setSheetOpen(false)} />}
    </div>
  )
}
