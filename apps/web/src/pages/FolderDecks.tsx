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
import type { ActiveEditorUser, DeckSummary, FolderSummary } from '../api/client.js'
import { peerColorFromId } from '@narrative/shared'
import { FolderDocProvider, useFolderTokens } from '../state/FolderDocProvider.js'
import { FolderFontsProvider, useFolderFonts } from '../state/useFolderFonts.js'
import { FolderFontLoader } from '../state/FolderFontLoader.js'
import { useFolderComponents } from '../state/useFolderComponents.js'
import { usePptxImport } from '../ui/usePptxImport.js'

// ---------------------------------------------------------------------------
// FolderDecks
// ---------------------------------------------------------------------------

/**
 * Outer wrapper — pulls folderId from the URL and mounts the folder
 * Y.Doc provider so the inner page can render the live styleguide
 * (colors / text styles).
 */
export function FolderDecks() {
  const { folderId } = useParams<{ folderId: string }>()
  const navigate = useNavigate()
  useEffect(() => {
    if (folderId === undefined) void navigate('/')
  }, [folderId, navigate])
  if (folderId === undefined) return null
  return (
    <FolderDocProvider folderId={folderId}>
      <FolderFontsProvider folderId={folderId}>
        {/* Loader registers each folder font with document.fonts so the
            styleguide preview renders in the actual face. */}
        <FolderFontLoader />
        <FolderDecksInner />
      </FolderFontsProvider>
    </FolderDocProvider>
  )
}

function FolderDecksInner() {
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

  // Drop a .pptx anywhere on this page to import it as a new deck. This
  // folder is offered first, since it is the one you are looking at, but the
  // dialog still lets you send it elsewhere.
  const pptxImport = usePptxImport({
    folders:
      folder === null ? allFolders : [folder, ...allFolders.filter((f) => f.id !== folder.id)],
    onCreateFolder: (name) => api.createFolder(name),
    onImported: (result) => {
      void navigate(`/deck/${result.deckId}`)
    },
    onError: setError,
  })
  // deckId → list of users currently editing it. Each entry includes the
  // user's email + name (server enriches via the `users` directory) so the
  // bubble can show real initials instead of the opaque Google sub. Polled
  // separately from the deck list so a slow active-editors response doesn't
  // delay first paint.
  const [activeEditors, setActiveEditors] = useState<Record<string, ActiveEditorUser[]>>({})

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

  // Poll "who is editing each deck" every 5s. Server reads from the
  // Hocuspocus in-memory presence tracker — cheap, no DB lookup.
  // Stops when the page unmounts or folderId changes.
  useEffect(() => {
    if (folderId === undefined) return
    let cancelled = false
    const refresh = async () => {
      try {
        const entries = await api.listFolderActiveEditors(folderId)
        if (cancelled) return
        const next: Record<string, ActiveEditorUser[]> = {}
        for (const e of entries) next[e.deckId] = e.users
        setActiveEditors(next)
      } catch {
        // Best-effort UX — silent on failure.
      }
    }
    void refresh()
    const handle = window.setInterval(() => void refresh(), 5000)
    return () => {
      cancelled = true
      window.clearInterval(handle)
    }
  }, [api, folderId])

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
    <div
      className="flex h-screen flex-col bg-background text-foreground"
      {...pptxImport.dropHandlers}
    >
      {pptxImport.overlay}
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
                className="min-w-0 max-w-[240px] rounded-xs border border-border-strong bg-surface-1 px-1.5 py-0.5 text-sm font-semibold text-foreground outline-none focus:ring-1 focus:ring-ring/40"
                aria-label="Folder name"
              />
            ) : (
              <button
                onClick={() => {
                  setFolderNameDraft(folder?.name ?? '')
                  setEditingFolderName(true)
                }}
                className="min-w-0 max-w-[240px] truncate rounded-xs px-1.5 py-0.5 text-sm font-semibold text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
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

        {folderId !== undefined && (
          <FolderStyleguide
            onOpenSettings={(tab, focusId) => {
              const params = new URLSearchParams()
              if (tab !== undefined) params.set('tab', tab)
              if (focusId !== undefined) params.set('focus', focusId)
              const qs = params.toString()
              void navigate(`/folder/${folderId}/settings${qs === '' ? '' : `?${qs}`}`)
            }}
            folderId={folderId}
          />
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
                activeEditors={activeEditors[deck.id] ?? EMPTY_EDITORS}
                onOpen={() => void navigate(`/deck/${deck.id}`)}
                onDelete={() => void handleDeleteDeck(deck.id)}
                onRename={(title) => void handleRenameDeck(deck.id, title)}
                onMoveRequest={() => setMoveDeckId(deck.id)}
              />
            ))}
          </div>
        )}
      </main>

      {/* PowerPoint import — folder picker + upload progress */}
      {pptxImport.dialog}

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
  /** Users currently editing this deck (server-enriched with email + name). */
  activeEditors: ActiveEditorUser[]
  onOpen: () => void
  onDelete: () => void
  onRename: (title: string) => void
  onMoveRequest: () => void
}

// Stable empty-array reference so DeckCard's prop identity doesn't flip
// every render when nobody is editing the deck.
const EMPTY_EDITORS: ActiveEditorUser[] = []

function DeckCard({
  deck,
  thumbnail,
  activeEditors,
  onOpen,
  onDelete,
  onRename,
  onMoveRequest,
}: DeckCardProps) {
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
      className={`panel group relative cursor-pointer rounded-lg border border-border p-4 hover:border-border-strong hover:shadow-glow transition-all ${
        menuOpen ? 'z-30' : ''
      }`}
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
            className="min-w-0 flex-1 rounded-xs border border-border-strong bg-surface-1 px-1 py-0.5 text-sm font-medium text-foreground outline-none focus:ring-1 focus:ring-ring/40"
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
            {/* Active editor bubbles — sit right of the name, before the
                kebab. Visible at all times (not just on hover) so the
                user can spot collaborators without rolling over each
                tile. */}
            {activeEditors.length > 0 && (
              <ActiveEditorsBubbles users={activeEditors} className="shrink-0" />
            )}
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

// ---------------------------------------------------------------------------
// ActiveEditorsBubbles — small avatar bubbles overlaid on the deck
// thumbnail, one per user currently editing the deck. Driven by the
// parent's 5s poll of /folders/:id/active-editors which since 0.7.0
// returns email + name (resolved via the `users` directory) so initials
// reflect the actual identity, not the opaque Google sub.
// ---------------------------------------------------------------------------

interface ActiveEditorsBubblesProps {
  users: ActiveEditorUser[]
  className?: string
}

function bubbleInitial(u: ActiveEditorUser): string {
  if (u.name) {
    return u.name.trim().charAt(0).toUpperCase() || '?'
  }
  if (u.email) {
    return u.email.charAt(0).toUpperCase() || '?'
  }
  // Share-token connections show up as `share:abc12345` — the user-facing
  // letter should still be a letter, not a digit.
  if (u.userId.startsWith('share:')) return '?'
  return u.userId.charAt(0).toUpperCase() || '?'
}

function bubbleTooltip(u: ActiveEditorUser): string {
  if (u.name && u.email) return `${u.name} (${u.email}) is editing`
  if (u.email) return `${u.email} is editing`
  if (u.name) return `${u.name} is editing`
  return 'A collaborator is editing'
}

function ActiveEditorsBubbles({ users, className = '' }: ActiveEditorsBubblesProps) {
  const MAX = 3
  const visible = users.slice(0, MAX)
  const overflow = users.length - visible.length
  return (
    <div className={`flex -space-x-1.5 ${className}`}>
      {visible.map((u) => {
        const colour = peerColorFromId(u.userId)
        return (
          <span
            key={u.userId}
            title={bubbleTooltip(u)}
            className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-background text-[10px] font-semibold leading-none text-white shadow-xs"
            style={{ backgroundColor: colour }}
            aria-label={bubbleTooltip(u)}
          >
            {bubbleInitial(u)}
          </span>
        )
      })}
      {overflow > 0 && (
        <span
          className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full border border-background bg-surface-3 px-1 text-[10px] font-semibold leading-none text-foreground shadow-xs"
          title={`${overflow} more editor${overflow === 1 ? '' : 's'}`}
        >
          +{overflow}
        </span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// FolderStyleguide — compact preview of the folder's tokens above the
// deck grid, with a shortcut to the settings page.
// ---------------------------------------------------------------------------

type StyleguideTab = 'colors' | 'textStyles' | 'fonts' | 'components'

interface FolderStyleguideProps {
  onOpenSettings: (tab?: StyleguideTab, focusId?: string) => void
  folderId: string
}

function FolderStyleguide({ onOpenSettings, folderId }: FolderStyleguideProps) {
  const { colors, textStyles } = useFolderTokens()
  const { fonts } = useFolderFonts()
  const { components } = useFolderComponents(folderId, { eager: true })
  const colorList = Object.values(colors)
  const styleList = Object.values(textStyles)
  // Group fonts by family — multiple weights/styles share a chip. We
  // also need a representative font asset per family so clicking the
  // chip can deep-link to that specific entry on the Fonts tab.
  const fontFamilyEntries = Array.from(
    fonts
      .reduce((acc, f) => {
        if (!acc.has(f.family)) acc.set(f.family, f.assetId)
        return acc
      }, new Map<string, string>())
      .entries(),
  ).sort((a, b) => a[0].localeCompare(b[0]))
  const componentList = components ?? []

  if (
    colorList.length === 0 &&
    styleList.length === 0 &&
    fontFamilyEntries.length === 0 &&
    componentList.length === 0
  ) {
    return null
  }

  // Whole section is a click target → opens settings on the Colors tab
  // by default. Children stop propagation so their own tab routing
  // wins. Pencil icon stays as an obvious affordance in the corner.
  return (
    <section
      role="button"
      tabIndex={0}
      onClick={() => onOpenSettings('colors')}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpenSettings('colors')
        }
      }}
      className="panel group mb-6 cursor-pointer rounded-xl border border-border p-4 transition-colors hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      aria-label="Open style guide"
    >
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground/80">
          Style guide
        </h2>
        <span className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors group-hover:bg-accent group-hover:text-foreground">
          <Pencil className="h-3 w-3" aria-hidden="true" />
          Edit
        </span>
      </div>

      {/* Two-column layout: tokens (colors / text styles / fonts) on
          the left, components on the right. 50:50 split on md+ so
          components get half the row regardless of count. Stacks on
          narrow viewports. */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 md:items-start">
        <div className="min-w-0 space-y-3">
          {/* Colors row */}
          {colorList.length > 0 && (
            <div>
              <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                Colors
              </p>
              <div className="flex flex-wrap items-center gap-1.5">
                {colorList.map((c) => (
                  <button
                    type="button"
                    key={c.id}
                    title={`${c.name} — ${c.value}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      onOpenSettings('colors', c.id)
                    }}
                    className="h-6 w-6 shrink-0 rounded border border-border-strong/60 shadow-inner transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                    style={{ backgroundColor: c.value }}
                    aria-label={`Edit color ${c.name}`}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Text styles row — render each on a small white chip so any
              token color is legible against the dark UI. */}
          {styleList.length > 0 && (
            <div>
              <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                Text styles
              </p>
              <div className="flex flex-wrap items-end gap-2">
                {styleList.map((s) => (
                  <button
                    type="button"
                    key={s.id}
                    onClick={(e) => {
                      e.stopPropagation()
                      onOpenSettings('textStyles', s.id)
                    }}
                    className="flex flex-col items-start rounded transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                    title={`Edit ${s.name} — ${s.family} ${s.weight} ${s.size}px`}
                    aria-label={`Edit text style ${s.name}`}
                  >
                    <div className="rounded bg-white px-2 py-1 text-black">
                      <span
                        className="leading-none"
                        style={{
                          fontFamily: s.family,
                          fontWeight: s.weight,
                          fontSize: Math.min(s.size ?? 16, 22),
                          color: typeof s.color === 'string' ? s.color : '#0f172a',
                        }}
                      >
                        Aa
                      </span>
                    </div>
                    <span className="mt-0.5 text-[10px] tabular-nums text-muted-foreground/70">
                      {s.name}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Custom fonts row — show each uploaded family rendered in itself. */}
          {fontFamilyEntries.length > 0 && (
            <div>
              <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                Custom fonts
              </p>
              <div className="flex flex-wrap items-end gap-2">
                {fontFamilyEntries.map(([family, assetId]) => (
                  <button
                    type="button"
                    key={family}
                    onClick={(e) => {
                      e.stopPropagation()
                      onOpenSettings('fonts', assetId)
                    }}
                    className="flex flex-col items-start rounded transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                    title={`Edit ${family}`}
                    aria-label={`Edit font ${family}`}
                  >
                    <div className="rounded bg-white px-2 py-1 text-black">
                      <span
                        className="leading-none"
                        style={{
                          fontFamily: `"${family}", system-ui, sans-serif`,
                          fontSize: 18,
                        }}
                      >
                        Aa
                      </span>
                    </div>
                    <span className="mt-0.5 max-w-[120px] truncate text-[10px] text-muted-foreground/70">
                      {family}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Components column — vertical divider on md+, top divider on
            stacked layout. Caps width so a wall of components doesn't
            crowd the tokens. */}
        {componentList.length > 0 && (
          <div className="min-w-0 border-t border-border/40 pt-3 md:max-w-[360px] md:border-l md:border-t-0 md:pl-4 md:pt-0">
            <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
              Components
            </p>
            <div className="flex flex-wrap items-end gap-2">
              {componentList.map((c) => (
                <button
                  type="button"
                  key={c.id}
                  onClick={(e) => {
                    e.stopPropagation()
                    onOpenSettings('components', c.id)
                  }}
                  className="flex flex-col items-start rounded transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                  title={`Edit ${c.name}`}
                  aria-label={`Edit component ${c.name}`}
                >
                  <div className="flex h-12 w-20 items-center justify-center overflow-hidden rounded border border-border-strong/60 bg-surface-2">
                    {c.thumbnailUrl !== undefined && c.thumbnailUrl !== null ? (
                      <img
                        src={c.thumbnailUrl}
                        alt=""
                        className="h-full w-full object-cover"
                        draggable={false}
                      />
                    ) : (
                      <span className="text-[9px] text-muted-foreground/60">No preview</span>
                    )}
                  </div>
                  <span className="mt-0.5 max-w-[80px] truncate text-[10px] text-muted-foreground/70">
                    {c.name}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
