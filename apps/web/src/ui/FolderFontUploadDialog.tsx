/**
 * ui/FolderFontUploadDialog.tsx
 *
 * M16 P3 (consolidated): the in-editor "upload custom font" entry point.
 *
 * Replaces the old deck-scoped FontUploadSheet. Posts the file directly
 * to /api/folders/<folderId>/fonts via the API client's uploadFolderFont
 * helper (multipart-free raw binary upload). On success, refreshes the
 * folder fonts cache so FolderFontLoader picks up the new face.
 *
 * The folderId is read from DeckRoleContext — the caller (the inspector)
 * only renders the button when a deck is open, which guarantees a
 * folderId once the deck row has loaded. While folderId is null we
 * silently disable the upload button (rare race condition).
 *
 * Also lists the folder's existing fonts with a delete button.
 */

import { useCallback, useRef, useState } from 'react'
import { Loader2, Trash2, Upload, X } from 'lucide-react'
import { useApi } from '../api/client.js'
import { useFolderFontsOptional } from '../state/useFolderFonts.js'
import { useDeckRole } from '../state/DeckRoleContext.js'

interface FolderFontUploadDialogProps {
  onClose(): void
}

export function FolderFontUploadDialog({ onClose }: FolderFontUploadDialogProps) {
  const api = useApi()
  const { folderId } = useDeckRole()
  const folderFontsCtx = useFolderFontsOptional()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const fonts = folderFontsCtx?.fonts ?? []

  const onPick = useCallback(
    async (file: File) => {
      if (!folderId) {
        setError('No folder context — cannot upload a folder font here.')
        return
      }
      setError(null)
      setBusy(true)
      try {
        await api.uploadFolderFont(folderId, file)
        await folderFontsCtx?.refresh()
      } catch (err: unknown) {
        const body = (err as { body?: { error?: string } }).body
        const msg = body?.error ?? (err instanceof Error ? err.message : 'Upload failed')
        setError(msg)
      } finally {
        setBusy(false)
      }
    },
    [api, folderId, folderFontsCtx],
  )

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      e.stopPropagation()
      const file = e.dataTransfer.files?.[0]
      if (file) void onPick(file)
    },
    [onPick],
  )

  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  const onDelete = useCallback(
    async (assetId: string) => {
      if (!folderId) return
      setError(null)
      try {
        await api.deleteFolderFont(folderId, assetId)
        await folderFontsCtx?.refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Delete failed')
      }
    },
    [api, folderId, folderFontsCtx],
  )

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

        <h2 className="text-sm font-semibold">Folder fonts</h2>

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
          <span>
            {busy ? 'Uploading…' : 'Drop a .ttf, .otf, or .woff2 here, or click to choose'}
          </span>
          <input
            ref={inputRef}
            type="file"
            accept=".ttf,.otf,.woff2,font/ttf,font/otf,font/woff2"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void onPick(file)
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
              In this folder ({fonts.length})
            </h3>
            <ul className="flex max-h-48 flex-col gap-1 overflow-auto">
              {fonts.map((f) => (
                <li
                  key={f.assetId}
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
                    onClick={() => void onDelete(f.assetId)}
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
