/**
 * ui/MoveDeckModal.tsx
 *
 * M16 P1 — Modal that lets the user pick a destination folder for one or
 * more decks.  Rendered from FolderDecks (deck card kebab → "Move to…").
 *
 * Props
 *   deckIds        — ids to move (usually just one from the card menu)
 *   currentFolderId — folder that is currently open; excluded from the list
 *   folders        — all folders the user owns (caller provides, no extra fetch)
 *   onConfirm      — called with the chosen destination folder id
 *   onClose        — dismiss without action
 */

import { useState } from 'react'
import { Folder } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { FolderSummary } from '../api/client.js'

interface MoveDeckModalProps {
  deckIds: string[]
  currentFolderId: string
  folders: FolderSummary[]
  onConfirm: (destFolderId: string) => void
  onClose: () => void
}

export function MoveDeckModal({
  deckIds,
  currentFolderId,
  folders,
  onConfirm,
  onClose,
}: MoveDeckModalProps) {
  const targets = folders.filter((f) => f.id !== currentFolderId)
  const [selected, setSelected] = useState<string | null>(targets[0]?.id ?? null)

  const handleConfirm = () => {
    if (selected === null) return
    onConfirm(selected)
  }

  // Close on backdrop click.
  const handleBackdrop = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose()
  }

  // Close on Escape.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') onClose()
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Move ${deckIds.length === 1 ? 'deck' : `${deckIds.length} decks`} to folder`}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/60 backdrop-blur-xs"
      onClick={handleBackdrop}
      onKeyDown={handleKeyDown}
    >
      <div className="panel w-[360px] rounded-xl border border-border p-5 shadow-xl">
        <h2 className="mb-4 text-sm font-semibold text-foreground">
          Move {deckIds.length === 1 ? 'deck' : `${deckIds.length} decks`} to&hellip;
        </h2>

        {targets.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No other folders available. Create a folder first.
          </p>
        ) : (
          <ul
            className="mb-4 max-h-60 overflow-y-auto space-y-1"
            role="listbox"
            aria-label="Destination folders"
          >
            {targets.map((folder) => (
              <li key={folder.id} role="none">
                <button
                  role="option"
                  aria-selected={selected === folder.id}
                  onClick={() => setSelected(folder.id)}
                  className={[
                    'flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm text-left transition-colors',
                    selected === folder.id
                      ? 'bg-accent text-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                  ].join(' ')}
                >
                  <Folder className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{folder.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground/60">
                    {folder.deckCount}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="btn-brand"
            onClick={handleConfirm}
            disabled={selected === null || targets.length === 0}
          >
            Move here
          </Button>
        </div>
      </div>
    </div>
  )
}
