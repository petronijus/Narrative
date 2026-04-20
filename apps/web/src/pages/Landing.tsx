/**
 * pages/Landing.tsx
 *
 * Minimalist landing page — list decks, create + navigate.
 *
 * M10: Refactored to use centralized API client (useApi hook) which
 * automatically attaches Bearer token to all requests. Sign-out button
 * added to header using useAuth().
 */

import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApi } from '../api/client.js'
import { useAuth } from '../state/AuthContext.js'
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
    <div className="flex min-h-screen flex-col bg-gray-950 text-gray-100">
      {/* Header */}
      <header className="border-b border-gray-800 px-8 py-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold tracking-tight">Narrative</h1>
          <div className="flex items-center gap-3">
            {user !== null && (
              <div className="flex items-center gap-2">
                <span className="hidden sm:block text-sm text-gray-400">
                  {user.name ?? user.email ?? user.sub.slice(0, 8)}
                </span>
                <button
                  onClick={() => void logout()}
                  className="rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-800 hover:text-gray-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500"
                >
                  Sign out
                </button>
              </div>
            )}
            <button
              onClick={() => void handleCreateDeck()}
              disabled={creating}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
            >
              {creating ? 'Creating…' : '+ New Deck'}
            </button>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 px-8 py-6">
        {error !== null && (
          <div className="mb-4 rounded-md bg-red-900/30 border border-red-800 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}

        {loading ? (
          <p className="text-sm text-gray-500">Loading decks…</p>
        ) : decks.length === 0 ? (
          <div className="flex flex-col items-center justify-center pt-24 text-center">
            <p className="text-gray-500">No decks yet.</p>
            <p className="mt-1 text-sm text-gray-600">Click "+ New Deck" to get started.</p>
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
      className="group relative cursor-pointer rounded-lg border border-gray-800 bg-gray-900 p-4 hover:border-gray-600 hover:bg-gray-850 transition-colors"
    >
      {/* Thumbnail placeholder */}
      <div className="mb-3 h-28 rounded bg-gray-800 flex items-center justify-center">
        <span className="text-xs text-gray-600">No preview</span>
      </div>

      <p className="truncate text-sm font-medium text-gray-100">{deck.title}</p>
      <p className="mt-0.5 text-xs text-gray-500">{date}</p>

      {/* Delete button */}
      <button
        onClick={onDelete}
        aria-label="Delete deck"
        className="absolute right-2 top-2 hidden rounded p-1 text-gray-500 hover:bg-gray-700 hover:text-red-400 group-hover:flex"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
          <path d="M10 11v6M14 11v6" />
          <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" />
        </svg>
      </button>
    </div>
  )
}
