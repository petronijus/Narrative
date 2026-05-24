/**
 * ui/NewDeckDialog.tsx
 *
 * M16 P1 — Modal launched from FoldersHome's "New deck" button.
 * Forces the user to pick (or create) a folder before the deck is created.
 */

import { useEffect, useRef, useState } from 'react'
import { Folder, FolderPlus, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { FolderSummary } from '../api/client.js'

interface NewDeckDialogProps {
  folders: FolderSummary[]
  /** Called with the destination folder id once the user confirms. */
  onConfirm: (folderId: string) => void | Promise<void>
  /** Create a new folder with the given name; resolves to the created folder. */
  onCreateFolder: (name: string) => Promise<FolderSummary>
  onClose: () => void
}

export function NewDeckDialog({ folders, onConfirm, onCreateFolder, onClose }: NewDeckDialogProps) {
  const [selectedId, setSelectedId] = useState<string | null>(folders[0]?.id ?? null)
  const [creatingNew, setCreatingNew] = useState(false)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const newNameInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (creatingNew) newNameInputRef.current?.focus()
  }, [creatingNew])

  const handleConfirm = async () => {
    setError(null)
    setBusy(true)
    try {
      let folderId = selectedId
      if (creatingNew) {
        const trimmed = newName.trim()
        if (trimmed === '') {
          setError('Folder name cannot be empty.')
          setBusy(false)
          return
        }
        const created = await onCreateFolder(trimmed)
        folderId = created.id
      }
      if (folderId == null) {
        setError('Pick a folder first.')
        setBusy(false)
        return
      }
      await onConfirm(folderId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create deck')
      setBusy(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Create new deck"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/60 backdrop-blur-xs"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !busy) onClose()
      }}
      tabIndex={-1}
    >
      <div className="panel w-[440px] rounded-xl border border-border p-5 shadow-xl">
        <h2 className="mb-1 text-sm font-semibold text-foreground">New deck</h2>
        <p className="mb-4 text-xs text-muted-foreground">
          Pick a folder for the new deck or create a new one.
        </p>

        {/* Folder list */}
        <div className="max-h-64 overflow-y-auto rounded-md border border-border">
          {folders.length === 0 && !creatingNew && (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              No folders yet. Create one below.
            </p>
          )}
          {folders.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => {
                setSelectedId(f.id)
                setCreatingNew(false)
              }}
              className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                !creatingNew && selectedId === f.id
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
              }`}
            >
              <Folder className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="flex-1 truncate">{f.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground/70">
                {f.deckCount} {f.deckCount === 1 ? 'deck' : 'decks'}
              </span>
            </button>
          ))}
        </div>

        {/* Create-new-folder row */}
        <div className="mt-3">
          {creatingNew ? (
            <div className="flex items-center gap-2 rounded-md border border-border-strong bg-surface-1 px-2 py-1.5">
              <FolderPlus
                className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <input
                ref={newNameInputRef}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !busy) {
                    e.preventDefault()
                    void handleConfirm()
                  }
                }}
                placeholder="New folder name"
                maxLength={200}
                className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none"
                aria-label="New folder name"
              />
              <button
                type="button"
                onClick={() => {
                  setCreatingNew(false)
                  setNewName('')
                }}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setCreatingNew(true)}
              className="flex w-full items-center gap-2 rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground hover:border-border-strong hover:text-foreground transition-colors"
            >
              <FolderPlus className="h-3.5 w-3.5" aria-hidden="true" />
              Create new folder
            </button>
          )}
        </div>

        {error !== null && <p className="mt-3 text-xs text-destructive-foreground">{error}</p>}

        {/* Actions */}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => void handleConfirm()}
            disabled={busy || (!creatingNew && selectedId == null)}
            className="btn-brand gap-1.5"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            {busy ? 'Creating…' : 'Create deck'}
          </Button>
        </div>
      </div>
    </div>
  )
}
