/**
 * pages/FolderDecks.tsx
 *
 * M16 P1 — Step 2 of the two-level home: decks inside a specific folder.
 *
 * Route: /folder/:folderId
 *
 * - Breadcrumb: ← All folders / <Folder name>
 * - Folder name is inline-editable.
 * - Deck grid is a rework of the original Landing.tsx DeckCard UX (thumbnails
 *   from deckThumbnailCache + server, rename, delete) with an added
 *   "Move to…" option in the card kebab menu.
 * - Invalid folderId → redirect to /.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ChevronLeft, LogOut, MoreVertical, Pencil, Plus, Trash2 } from 'lucide-react'
import { useApi } from '../api/client.js'
import { useAuth } from '../state/AuthContext.js'
import { Button } from '@/components/ui/button'
import { MoveDeckModal } from '../ui/MoveDeckModal.js'
import { deleteDeckThumbnail, getAllDeckThumbnails } from '../state/deckThumbnailCache.js'
import type { DeckSummary, FolderSummary } from '../api/client.js'

// ---------------------------------------------------------------------------
// FolderDecks
// ---------------------------------------------------------------------------

export function FolderDecks() {
  const { folderId } = useParams<{ folderId: string }>()
  const navigate = useNavigate()
  const api = useApi()
  const { user, logout } = useAuth()

  const [folder, setFolder] = useState<FolderSummary | null>(null)
  const [decks, setDecks] = useState<DeckSummary[]>([])
  const [allFolders, setAllFolders] = useState<FolderSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [editingFolderName, setEditingFolderName] = useState(false)
  const [folderNameDraft, setFolderNameDraft] = useState('')
  const folderNameInputRef = useRef<HTMLInputElement>(null)
  const [thumbnails] = useState<Record<string, string>>(() => getAllDeckThumbnails())
  // id of deck for which the Move modal is open
  const [moveDeckId, setMoveDeckId] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    if (folderId === undefined) return
    try {
      const [fetchedFolders, fetchedDecks] = await Promise.all([
        api.listFolders(),
        api.listDecks({ folderId }),
      ])
      const current = fetchedFolders.find((f) => f.id === folderId)
      if (current === undefined) {
        // Unknown folder id → back to home
        void navigate('/')
        return
      }
      setFolder(current)
      setFolderNameDraft(current.name)
      setAllFolders(fetchedFolders)
      setDecks(fetchedDecks)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load folder')
    } finally {
      setLoading(false)
    }
  }, [api, folderId, navigate])

  useEffect(() => {
    void fetchData()
  }, [fetchData])

  // Auto-focus folder name input when entering edit mode.
  useEffect(() => {
    if (editingFolderName) {
      folderNameInputRef.current?.focus()
      folderNameInputRef.current?.select()
    }
  }, [editingFolderName])

  const commitFolderRename = useCallback(() => {
    const trimmed = folderNameDraft.trim()
    setEditingFolderName(false)
    if (trimmed === '' || trimmed === folder?.name) {
      setFolderNameDraft(folder?.name ?? '')
      return
    }
    setFolder((prev) => (prev !== null ? { ...prev, name: trimmed } : prev))
    void api.renameFolder(folderId!, trimmed).catch((err) => {
      setError(err instanceof Error ? err.message : 'Failed to rename folder')
      void fetchData()
    })
  }, [api, folder?.name, folderId, folderNameDraft, fetchData])

  const handleCreateDeck = useCallback(async () => {
    if (folderId === undefined) return
    setCreating(true)
    try {
      const deck = await api.createDeck('Untitled Deck', folderId)
      void navigate(`/deck/${deck.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create deck')
      setCreating(false)
    }
  }, [api, folderId, navigate])

  const handleDeleteDeck = useCallback(
    async (id: string) => {
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
      const trimmed = title.trim()
      if (trimmed === '') return
      setDecks((prev) => prev.map((d) => (d.id === id ? { ...d, title: trimmed } : d)))
      try {
        await api.renameDeck(id, trimmed)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to rename deck')
        void fetchData()
      }
    },
    [api, fetchData],
  )

  const handleMoveConfirm = useCallback(
    async (destFolderId: string) => {
      if (moveDeckId === null || folderId === undefined) return
      const id = moveDeckId
      setMoveDeckId(null)
      // Optimistic remove from current view
      setDecks((prev) => prev.filter((d) => d.id !== id))
      try {
        await api.moveDecks(folderId, [id], destFolderId)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to move deck')
        void fetchData()
      }
    },
    [api, fetchData, folderId, moveDeckId],
  )

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* Header */}
      <header className="panel border-b border-border px-8 py-4">
        <div className="flex items-center justify-between">
          {/* Breadcrumb */}
          <div className="flex items-center gap-2 min-w-0">
            <button
              onClick={() => void navigate('/')}
              aria-label="All folders"
              className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 transition-colors"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
              All folders
            </button>
            <span className="shrink-0 text-muted-foreground/40" aria-hidden="true">
              /
            </span>
            {editingFolderName ? (
              <input
                ref={folderNameInputRef}
                value={folderNameDraft}
                onChange={(e) => setFolderNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    commitFolderRename()
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    setEditingFolderName(false)
                    setFolderNameDraft(folder?.name ?? '')
                  }
                }}
                onBlur={commitFolderRename}
                maxLength={200}
                className="min-w-0 max-w-[240px] rounded-sm border border-border-strong bg-surface-1 px-1.5 py-0.5 text-sm font-semibold text-foreground outline-none focus:ring-1 focus:ring-ring/40"
                aria-label="Folder name"
              />
            ) : (
              <button
                onClick={() => {
                  setFolderNameDraft(folder?.name ?? '')
                  setEditingFolderName(true)
                }}
                className="min-w-0 max-w-[240px] truncate rounded-sm px-1.5 py-0.5 text-sm font-semibold text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                aria-label="Rename folder (click to edit)"
                title="Click to rename"
              >
                {folder?.name ?? '…'}
              </button>
            )}
          </div>

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
              {creating ? 'Creating…' : 'New deck'}
            </Button>
          </div>
        </div>
      </header>

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
            <p className="text-muted-foreground">No decks in this folder yet.</p>
            <p className="mt-1 text-sm text-muted-foreground/60">
              Click <span className="text-foreground/80">+ New deck</span> to get started.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
            {decks.map((deck) => (
              <DeckCard
                key={deck.id}
                deck={deck}
                thumbnail={deck.thumbnailUrl ?? thumbnails[deck.id]}
                onOpen={() => void navigate(`/deck/${deck.id}`)}
                onDelete={() => void handleDeleteDeck(deck.id)}
                onRename={(title) => void handleRenameDeck(deck.id, title)}
                onMoveRequest={() => setMoveDeckId(deck.id)}
              />
            ))}
          </div>
        )}
      </main>

      {/* Move deck modal */}
      {moveDeckId !== null && folderId !== undefined && (
        <MoveDeckModal
          deckIds={[moveDeckId]}
          currentFolderId={folderId}
          folders={allFolders}
          onConfirm={(destId) => void handleMoveConfirm(destId)}
          onClose={() => setMoveDeckId(null)}
        />
      )}
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
  onDelete: () => void
  onRename: (title: string) => void
  onMoveRequest: () => void
}

function DeckCard({ deck, thumbnail, onOpen, onDelete, onRename, onMoveRequest }: DeckCardProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(deck.title)
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!editing) setDraft(deck.title)
  }, [deck.title, editing])

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  // Close kebab menu when clicking outside.
  useEffect(() => {
    if (!menuOpen) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
        setConfirmDelete(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuOpen])

  const date = new Date(deck.updatedAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })

  const commit = () => {
    setEditing(false)
    const trimmed = draft.trim()
    if (trimmed !== '' && trimmed !== deck.title) {
      onRename(trimmed)
    } else {
      setDraft(deck.title)
    }
  }

  const cancel = () => {
    setEditing(false)
    setDraft(deck.title)
  }

  return (
    <div
      onClick={editing || menuOpen ? undefined : onOpen}
      className="panel group relative cursor-pointer rounded-lg border border-border p-4 hover:border-border-strong hover:shadow-glow transition-all"
    >
      {/* Thumbnail */}
      <div className="mb-3 aspect-video overflow-hidden rounded-md bg-surface-2 flex items-center justify-center">
        {thumbnail !== undefined ? (
          <img src={thumbnail} alt="" className="h-full w-full object-cover" draggable={false} />
        ) : (
          <span className="text-xs text-muted-foreground/60">No preview</span>
        )}
      </div>

      {/* Title row + actions */}
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
            className="min-w-0 flex-1 rounded-sm border border-border-strong bg-surface-1 px-1 py-0.5 text-sm font-medium text-foreground outline-none focus:ring-1 focus:ring-ring/40"
            aria-label="Deck title"
          />
        ) : (
          <>
            <p
              className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
              onDoubleClick={(e) => {
                e.stopPropagation()
                setEditing(true)
              }}
              title="Double-click to rename"
            >
              {deck.title}
            </p>
            {/* Kebab menu */}
            <div className="relative shrink-0 opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto">
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setMenuOpen((v) => !v)
                  setConfirmDelete(false)
                }}
                aria-label="Deck options"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <MoreVertical className="h-3.5 w-3.5" aria-hidden="true" />
              </button>

              {menuOpen && (
                <div
                  ref={menuRef}
                  role="menu"
                  aria-label="Deck options"
                  className="absolute right-0 top-full z-20 mt-1 w-40 rounded-md border border-border bg-popover py-1 shadow-lg"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false)
                      setEditing(true)
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-foreground hover:bg-accent"
                  >
                    <Pencil className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                    Rename
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false)
                      onMoveRequest()
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-foreground hover:bg-accent"
                  >
                    {/* Using Folder icon as Move-to indicator */}
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
                      className="text-muted-foreground"
                      aria-hidden="true"
                    >
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                      <line x1="12" y1="11" x2="12" y2="17" />
                      <line x1="9" y1="14" x2="15" y2="14" />
                    </svg>
                    Move to&hellip;
                  </button>
                  {/* TODO(M16-P1): Duplicate to… — not in P1 scope */}
                  <div className="my-1 border-t border-border" />
                  {confirmDelete ? (
                    <button
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false)
                        setConfirmDelete(false)
                        onDelete()
                      }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-destructive hover:bg-accent"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      Confirm delete
                    </button>
                  ) : (
                    <button
                      role="menuitem"
                      onClick={() => setConfirmDelete(true)}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      Delete
                    </button>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground/80">{date}</p>
    </div>
  )
}
