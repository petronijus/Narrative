/**
 * ui/MoveDeckModal.tsx
 *
 * M16 P1 — Modal that lets the user pick a destination folder for one or
 * more decks.  Rendered from FolderDecks (deck card kebab → "Move to…").
 *
 * Props
 *   deckIds        — ids to move (usually just one from the card menu)
 *   currentFolderId — folder that is currently open; excluded from the list
 *   folders        — the user's folders (caller provides, no extra fetch); only
 *                    those they may add decks to (editor or owner) are offered
 *   onConfirm      — called with the chosen destination folder id
 *   onClose        — dismiss without action
 *
 * Share links: a deck's guests — share-link holders included — can read the
 * pictures and videos of its folder's components, so moving a share-linked
 * deck opens the destination folder's component media to whoever has the
 * link (ADR 0013, Consequences; accepted by Petr 2026-10-03). The dialog
 * reads the decks' links (`GET /decks/:id/share-links`, owner-only — the
 * role a move needs anyway) and warns when one is active. "Move here" waits
 * for that answer, at most `SHARE_CHECK_TIMEOUT_MS`; a check that fails or
 * times out warns conditionally rather than not at all.
 */

import { useEffect, useState } from 'react'
import { AlertTriangle, Folder } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useApi, type FolderSummary, type ShareLink } from '../api/client.js'

/** How long "Move here" waits for the share-link check. */
const SHARE_CHECK_TIMEOUT_MS = 5_000

/** A link that still opens the deck: the server lists unrevoked links, expired ones included. */
function isActiveLink(link: ShareLink, now: number): boolean {
  return link.expiresAt === null || Date.parse(link.expiresAt) > now
}

type ShareLinkCheck = 'checking' | 'shared' | 'not-shared' | 'unknown'

function shareLinkWarning(check: ShareLinkCheck, several: boolean, folderName: string): string {
  const consequence = `will be able to see the pictures and videos of the components in “${folderName}”.`
  if (check === 'shared') {
    return several
      ? `A deck you are moving has an active share link. Anyone with the link ${consequence}`
      : `This deck has an active share link. Anyone with the link ${consequence}`
  }
  return several
    ? `Couldn’t check these decks for share links. If one has a link, anyone with it ${consequence}`
    : `Couldn’t check this deck for share links. If it has one, anyone with the link ${consequence}`
}

/** Whether any of `deckIds` has an active share link. */
function useActiveShareLinkCheck(deckIds: string[]): ShareLinkCheck {
  const api = useApi()
  const [check, setCheck] = useState<ShareLinkCheck>('checking')
  const key = deckIds.join('|')

  useEffect(() => {
    let settled = false
    const settle = (value: ShareLinkCheck): void => {
      if (settled) return
      settled = true
      setCheck(value)
    }
    const timer = window.setTimeout(() => settle('unknown'), SHARE_CHECK_TIMEOUT_MS)
    const ids = key.split('|')
    Promise.all(ids.map((id) => api.listShareLinks(id)))
      .then((perDeck) => {
        const now = Date.now()
        settle(
          perDeck.some((links) => links.some((l) => isActiveLink(l, now)))
            ? 'shared'
            : 'not-shared',
        )
      })
      .catch((err: unknown) => {
        console.warn('[MoveDeckModal] could not read the share links', err)
        settle('unknown')
      })
    return () => {
      settled = true
      window.clearTimeout(timer)
    }
  }, [api, key])

  return check
}

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
  // Moving needs the editor role in the destination (services/decks.ts moveDecks).
  const targets = folders.filter((f) => f.id !== currentFolderId && f.role !== 'viewer')
  const [selected, setSelected] = useState<string | null>(targets[0]?.id ?? null)
  const shareCheck = useActiveShareLinkCheck(deckIds)
  const destination = targets.find((f) => f.id === selected)
  const several = deckIds.length > 1

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

        {destination !== undefined && (shareCheck === 'shared' || shareCheck === 'unknown') && (
          <div
            role="note"
            className="mb-4 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-foreground"
          >
            <AlertTriangle
              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500"
              aria-hidden="true"
            />
            <span>{shareLinkWarning(shareCheck, several, destination.name)}</span>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="btn-brand"
            onClick={handleConfirm}
            disabled={selected === null || targets.length === 0 || shareCheck === 'checking'}
            aria-busy={shareCheck === 'checking'}
          >
            Move here
          </Button>
        </div>
      </div>
    </div>
  )
}
