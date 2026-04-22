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

import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { LogOut, Plus, Trash2 } from 'lucide-react'
import { useApi } from '../api/client.js'
import { useAuth } from '../state/AuthContext.js'
import { Button } from '@/components/ui/button'
import type { DeckSummary } from '../api/client.js'

export function Landing() {
  const navigate = useNavigate()
  const api = useApi()
  const { user, logout } = useAuth()
  const [decks, setDecks] = useState<DeckSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

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
        setDecks((prev) => prev.filter((d) => d.id !== id))
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to delete deck')
      }
    },
    [api],
  )

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
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

      {/* Main content */}
      <main className="flex-1 px-8 py-6">
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
                onOpen={() => void navigate(`/deck/${deck.id}`)}
                onDelete={(e) => void handleDeleteDeck(deck.id, e)}
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
  onOpen: () => void
  onDelete: (e: React.MouseEvent) => void
}

function DeckCard({ deck, onOpen, onDelete }: DeckCardProps) {
  const date = new Date(deck.updatedAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })

  return (
    <div
      onClick={onOpen}
      className="panel group relative cursor-pointer rounded-lg border border-border p-4 hover:border-border-strong hover:shadow-glow transition-all"
    >
      {/* Thumbnail placeholder */}
      <div className="mb-3 h-28 rounded-md bg-surface-2 flex items-center justify-center">
        <span className="text-xs text-muted-foreground/60">No preview</span>
      </div>

      <p className="truncate text-sm font-medium text-foreground">{deck.title}</p>
      <p className="mt-0.5 text-xs text-muted-foreground/80">{date}</p>

      {/* Delete button */}
      <button
        onClick={onDelete}
        aria-label="Delete deck"
        className="absolute right-2 top-2 hidden rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-destructive group-hover:flex focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  )
}
