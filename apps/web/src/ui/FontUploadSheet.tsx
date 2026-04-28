/**
 * ui/FontUploadSheet.tsx
 *
 * P15: lightweight modal that lets the user pick a .ttf / .otf file
 * and (a) uploads it via the shared media tus pipeline, (b) writes
 * the resulting metadata to the deck Y.Doc so every collaborator
 * sees it, and (c) lists the deck's existing fonts with a delete
 * button (uploader / owner only).
 */

import { useCallback, useRef, useState } from 'react'
import { Loader2, Trash2, Upload, X } from 'lucide-react'
import { addDeckFont, removeDeckFont } from '@narrative/slide-model'
import type { DeckFontEntry } from '@narrative/shared'
import { useDeckFonts } from '../state/useDeckFonts.js'
import { useMediaUpload } from '../state/useMediaUpload.js'
import { useAuth } from '../state/AuthContext.js'

interface FontUploadSheetProps {
  onClose(): void
}

export function FontUploadSheet({ onClose }: FontUploadSheetProps) {
  const { fonts, fontsCtx } = useDeckFonts()
  const { startUpload } = useMediaUpload()
  const { user } = useAuth()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const onPick = useCallback(
    (file: File) => {
      setError(null)
      setBusy(true)
      const userId = user?.sub ?? 'unknown'
      startUpload(file, {
        onDone: (entry) => {
          setBusy(false)
          if (entry.status !== 'done' || entry.assetId === undefined) {
            setError(entry.error ?? 'Upload failed')
            return
          }
          if (
            entry.fontFamily === undefined ||
            entry.fontWeight === undefined ||
            entry.fontStyle === undefined ||
            entry.fontPostscriptName === undefined
          ) {
            setError('Server returned no font metadata — is this a valid TTF / OTF?')
            return
          }
          const deckEntry: DeckFontEntry = {
            id: entry.assetId,
            family: entry.fontFamily,
            weight: entry.fontWeight,
            style: entry.fontStyle,
            postscriptName: entry.fontPostscriptName,
            addedBy: userId,
            addedAt: Date.now(),
            originalFilename: entry.filename,
          }
          addDeckFont(fontsCtx, deckEntry)
        },
      })
    },
    [startUpload, user, fontsCtx],
  )

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      e.stopPropagation()
      const file = e.dataTransfer.files?.[0]
      if (file) onPick(file)
    },
    [onPick],
  )

  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  return (
    <div
      role="dialog"
      aria-label="Upload custom font"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="panel relative flex w-[420px] max-w-full flex-col gap-3 rounded-md p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>

        <h2 className="text-sm font-semibold">Custom fonts</h2>

        <div
          onDrop={onDrop}
          onDragOver={onDragOver}
          onClick={() => inputRef.current?.click()}
          className={[
            'flex cursor-pointer flex-col items-center justify-center gap-2 rounded border border-dashed border-border px-3 py-6',
            'text-xs text-muted-foreground transition-colors',
            'hover:border-primary hover:bg-accent/30',
            busy ? 'pointer-events-none opacity-60' : '',
          ].join(' ')}
        >
          {busy ? (
            <Loader2 className="h-5 w-5 animate-spin text-primary" aria-hidden="true" />
          ) : (
            <Upload className="h-5 w-5 text-foreground/70" aria-hidden="true" />
          )}
          <span>{busy ? 'Uploading…' : 'Drop a .ttf or .otf here, or click to choose'}</span>
          <input
            ref={inputRef}
            type="file"
            accept=".ttf,.otf,font/ttf,font/otf,font/sfnt,application/font-ttf,application/font-otf,application/x-font-ttf,application/x-font-otf,application/x-font-opentype,application/x-font-truetype,application/vnd.ms-opentype"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) onPick(file)
              // Reset so re-picking the same file fires onChange.
              e.currentTarget.value = ''
            }}
          />
        </div>

        {error !== null && (
          <p role="alert" className="text-xs text-red-500">
            {error}
          </p>
        )}

        {fonts.length > 0 && (
          <>
            <h3 className="mt-1 text-xs font-medium text-muted-foreground">
              In this deck ({fonts.length})
            </h3>
            <ul className="flex max-h-48 flex-col gap-1 overflow-auto">
              {fonts.map((f) => (
                <li
                  key={f.id}
                  className="flex items-center gap-2 rounded border border-border px-2 py-1 text-xs"
                >
                  <span className="flex-1 truncate" style={{ fontFamily: f.family }}>
                    {f.family}{' '}
                    <span className="text-muted-foreground">
                      {f.weight} {f.style === 'italic' ? 'italic' : ''}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => removeDeckFont(fontsCtx, f.id)}
                    aria-label={`Remove ${f.family}`}
                    title="Remove"
                    className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-destructive/20 hover:text-destructive"
                  >
                    <Trash2 className="h-3 w-3" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}
