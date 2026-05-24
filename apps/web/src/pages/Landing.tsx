/**
 * pages/Landing.tsx
 *
 * Deck-list landing page.
 *
 * P1 visual foundation pass: migrated to the semantic token palette
 * (surface-* / border-border / muted-foreground) and shadcn Button. The
 * deck grid cards use the `.panel` utility so they pick up the same
 * gradient + rim as the editor's sidebars / toolbar.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { LogOut, Pencil, Plus, Trash2 } from 'lucide-react'
import { useApi } from '../api/client.js'
import { useAuth } from '../state/AuthContext.js'
import { Button } from '@/components/ui/button'
import type { DeckSummary } from '../api/client.js'
import { deleteDeckThumbnail, getAllDeckThumbnails } from '../state/deckThumbnailCache.js'

export function Landing() {
  const navigate = useNavigate()
  const api = useApi()
  const { user, logout } = useAuth()
  const [decks, setDecks] = useState<DeckSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  // P13: cached deck thumbnails written by the editor on per-slide
  // render. Read once on mount; re-reads happen if the user navigates
  // back from the editor (Landing remounts via React Router).
  const [thumbnails] = useState<Record<string, string>>(() => getAllDeckThumbnails())

  const fetchDecks = useCallback(async () => {
    try {
      const data = await api.listDecks()
      setDecks(data)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load decks')
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    void fetchDecks()
  }, [fetchDecks])

  const handleCreateDeck = useCallback(async () => {
    setCreating(true)
    try {
      const deck = await api.createDeck('Untitled Deck')
      void navigate(`/deck/${deck.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create deck')
      setCreating(false)
    }
  }, [api, navigate])

  const handleDeleteDeck = useCallback(
    async (id: string, e: React.MouseEvent) => {
      e.stopPropagation()
      try {
        await api.deleteDeck(id)
        deleteDeckThumbnail(id)
        setDecks((prev) => prev.filter((d) => d.id !== id))
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to delete deck')
      }
    },
    [api],
  )

  const handleRenameDeck = useCallback(
    async (id: string, title: string) => {
      // Optimistic — update local state first, roll back on error.
      const trimmed = title.trim()
      if (trimmed === '') return
      setDecks((prev) => prev.map((d) => (d.id === id ? { ...d, title: trimmed } : d)))
      try {
        await api.renameDeck(id, trimmed)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to rename deck')
        void fetchDecks()
      }
    },
    [api, fetchDecks],
  )

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* Header */}
      <header className="panel border-b border-border px-8 py-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold tracking-tight">Narrative</h1>
          <div className="flex items-center gap-3">
            {user !== null && (
              <div className="flex items-center gap-2">
                <span className="hidden sm:block text-sm text-muted-foreground">
                  {user.name ?? user.email ?? user.sub.slice(0, 8)}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => void logout()}
                  aria-label="Sign out"
                  className="h-8 w-8"
                >
                  <LogOut className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            )}
            <Button
              onClick={() => void handleCreateDeck()}
              disabled={creating}
              size="sm"
              className="btn-brand gap-1.5"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              {creating ? 'Creating…' : 'New Deck'}
            </Button>
          </div>
        </div>
      </header>

      {/* Main content — fills remaining viewport height and scrolls when
          the grid overflows (many decks or small window). */}
      <main className="flex-1 overflow-y-auto px-8 py-6">
        {error !== null && (
          <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive-foreground">
            {error}
          </div>
        )}

        {loading ? (
          <p className="text-sm text-muted-foreground/80">Loading decks…</p>
        ) : decks.length === 0 ? (
          <div className="flex flex-col items-center justify-center pt-24 text-center">
            <p className="text-muted-foreground">No decks yet.</p>
            <p className="mt-1 text-sm text-muted-foreground/60">
              Click <span className="text-foreground/80">+ New Deck</span> to get started.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
            {decks.map((deck) => (
              <DeckCard
                key={deck.id}
                deck={deck}
                // Server-side preview is the source of truth; the
                // localStorage cache is the fallback for old deployments
                // that haven't uploaded a thumbnail yet AND for instant
                // first paint on the device that authored it.
                thumbnail={deck.thumbnailUrl ?? thumbnails[deck.id]}
                onOpen={() => void navigate(`/deck/${deck.id}`)}
                onDelete={(e) => void handleDeleteDeck(deck.id, e)}
                onRename={(title) => void handleRenameDeck(deck.id, title)}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  )
}

// ---------------------------------------------------------------------------
// DeckCard
// ---------------------------------------------------------------------------

interface DeckCardProps {
  deck: DeckSummary
  thumbnail?: string | undefined
  onOpen: () => void
  onDelete: (e: React.MouseEvent) => void
  onRename: (title: string) => void
}

function DeckCard({ deck, thumbnail, onOpen, onDelete, onRename }: DeckCardProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(deck.title)
  const inputRef = useRef<HTMLInputElement>(null)

  // Keep draft in sync if the deck title changes from elsewhere (e.g.
  // the editor renamed it via the Y.Doc → server → list refresh path).
  useEffect(() => {
    if (!editing) setDraft(deck.title)
  }, [deck.title, editing])

  // Auto-focus + select on edit-mode entry.
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  const date = new Date(deck.updatedAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })

  const startEdit = (e: React.MouseEvent): void => {
    e.stopPropagation()
    setEditing(true)
  }

  const commit = (): void => {
    setEditing(false)
    const trimmed = draft.trim()
    if (trimmed !== '' && trimmed !== deck.title) {
      onRename(trimmed)
    } else {
      setDraft(deck.title)
    }
  }

  const cancel = (): void => {
    setEditing(false)
    setDraft(deck.title)
  }

  return (
    <div
      onClick={editing ? undefined : onOpen}
      className="panel group relative cursor-pointer rounded-lg border border-border p-4 hover:border-border-strong hover:shadow-glow transition-all"
    >
      {/* Thumbnail — locked to the artboard's 16:9 aspect so the
          preview matches what the user sees in the editor / present. */}
      <div className="mb-3 aspect-video overflow-hidden rounded-md bg-surface-2 flex items-center justify-center">
        {thumbnail !== undefined ? (
          <img src={thumbnail} alt="" className="h-full w-full object-cover" draggable={false} />
        ) : (
          <span className="text-xs text-muted-foreground/60">No preview</span>
        )}
      </div>

      {/* Title row + hover actions inline on the same Y axis. */}
      <div className="flex items-center gap-1.5">
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commit()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                cancel()
              }
            }}
            onBlur={commit}
            maxLength={200}
            className="min-w-0 flex-1 rounded-xs border border-border-strong bg-surface-1 px-1 py-0.5 text-sm font-medium text-foreground outline-none focus:ring-1 focus:ring-ring/40"
            aria-label="Deck title"
          />
        ) : (
          <>
            <p
              className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
              onDoubleClick={startEdit}
              title="Double-click to rename"
            >
              {deck.title}
            </p>
            <div className="flex shrink-0 gap-0.5 opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto">
              <button
                onClick={startEdit}
                aria-label="Rename deck"
                className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <button
                onClick={onDelete}
                aria-label="Delete deck"
                className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          </>
        )}
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground/80">{date}</p>
    </div>
  )
}
