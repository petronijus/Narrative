/**
 * pages/Landing.tsx
 *
 * Minimalistická landing page — list decků, create + navigate.
 *
 * UI je záměrně prostý — design polish přijde v M20 (templates + themes).
 * Hlavní je funkční flow:
 *   1. Fetch GET /decks → zobrazí seznam
 *   2. "New deck" → POST /decks → navigate na /deck/:id
 *   3. Klik na deck → navigate na /deck/:id
 *   4. Trash icon → DELETE /decks/:id → refetch
 *
 * API base URL z env: VITE_API_URL (default http://localhost:3001)
 */

import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

const API_URL = import.meta.env['VITE_API_URL'] ?? 'http://localhost:3001'

interface Deck {
  id: string
  title: string
  ownerUserId: string
  createdAt: string
  updatedAt: string
}

export function Landing() {
  const navigate = useNavigate()
  const [decks, setDecks] = useState<Deck[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const fetchDecks = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/decks`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as Deck[]
      setDecks(data)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load decks')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchDecks()
  }, [fetchDecks])

  const handleCreateDeck = useCallback(async () => {
    setCreating(true)
    try {
      const res = await fetch(`${API_URL}/decks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Untitled Deck' }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const deck = (await res.json()) as Deck
      void navigate(`/deck/${deck.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create deck')
      setCreating(false)
    }
  }, [navigate])

  const handleDeleteDeck = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      const res = await fetch(`${API_URL}/decks/${id}`, { method: 'DELETE' })
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`)
      setDecks((prev) => prev.filter((d) => d.id !== id))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete deck')
    }
  }, [])

  return (
    <div className="flex min-h-screen flex-col bg-gray-950 text-gray-100">
      {/* Header */}
      <header className="border-b border-gray-800 px-8 py-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold tracking-tight">Narrative</h1>
          <button
            onClick={() => void handleCreateDeck()}
            disabled={creating}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {creating ? 'Creating…' : '+ New Deck'}
          </button>
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
  deck: Deck
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
