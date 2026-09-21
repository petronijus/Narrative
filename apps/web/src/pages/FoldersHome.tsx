/**
 * pages/FoldersHome.tsx
 *
 * M16 P1 — Step 1 of the two-level home: the folders grid.
 *
 * Shows all user folders as cards with a cover composite of up to 4
 * latest deck thumbnails.  Drafts folder is pinned first and cannot be
 * deleted.
 *
 * Navigation: click a folder card → /folder/:folderId (FolderDecks).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  FileUp,
  Folder,
  FolderPlus,
  LogOut,
  MoreVertical,
  Pencil,
  Plus,
  Settings,
  Trash2,
} from 'lucide-react'
import { useApi } from '../api/client.js'
import { useAuth } from '../state/AuthContext.js'
import { Button } from '@/components/ui/button'
import type { FolderSummary } from '../api/client.js'
import { NewDeckDialog } from '../ui/NewDeckDialog.js'
import { usePptxImport } from '../ui/usePptxImport.js'

// ---------------------------------------------------------------------------
// FoldersHome
// ---------------------------------------------------------------------------

export function FoldersHome() {
  const navigate = useNavigate()
  const api = useApi()
  const { user, logout } = useAuth()
  const [folders, setFolders] = useState<FolderSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  // id of the folder whose name is being inline-edited on creation
  const [inlineEditId, setInlineEditId] = useState<string | null>(null)
  // Modal for non-empty folder delete
  const [deleteBlockedId, setDeleteBlockedId] = useState<string | null>(null)
  // New deck dialog (folder picker)
  const [newDeckOpen, setNewDeckOpen] = useState(false)

  const fetchFolders = useCallback(async () => {
    try {
      const data = await api.listFolders()
      // Server is expected to return Drafts first, but sort defensively:
      // a folder named "Drafts" at position 0 is treated as the auto-provisioned
      // one.  In P1 we can't distinguish it by flag (the type has no isDrafts),
      // so we rely on server ordering.
      setFolders(data)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load folders')
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    void fetchFolders()
  }, [fetchFolders])

  const handleCreateFolder = useCallback(async () => {
    setCreating(true)
    try {
      const folder = await api.createFolder('New folder')
      setFolders((prev) => [...prev, folder])
      setInlineEditId(folder.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create folder')
    } finally {
      setCreating(false)
    }
  }, [api])

  const handleRenameFolder = useCallback(
    async (id: string, name: string) => {
      const trimmed = name.trim()
      if (trimmed === '') return
      // Optimistic update
      setFolders((prev) => prev.map((f) => (f.id === id ? { ...f, name: trimmed } : f)))
      try {
        await api.renameFolder(id, trimmed)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to rename folder')
        void fetchFolders()
      }
    },
    [api, fetchFolders],
  )

  const handleDeleteFolder = useCallback(
    async (id: string) => {
      try {
        await api.deleteFolder(id)
        setFolders((prev) => prev.filter((f) => f.id !== id))
      } catch (err) {
        const status = (err as { status?: number }).status
        if (status === 409) {
          // Server returns 409 only for "cannot_delete_drafts" now —
          // every other folder cascade-deletes its decks.
          setDeleteBlockedId(id)
        } else {
          setError(err instanceof Error ? err.message : 'Failed to delete folder')
        }
      }
    },
    [api],
  )

  const blockedFolder = folders.find((f) => f.id === deleteBlockedId)

  // ---------------------------------------------------------------------------
  // PPTX import — file picker + page-level drag-drop, shared with FolderDecks
  // ---------------------------------------------------------------------------

  const pptxImport = usePptxImport({
    folders,
    onCreateFolder: async (name) => {
      const created = await api.createFolder(name)
      setFolders((prev) => [...prev, created])
      return created
    },
    onImported: (result) => {
      // Navigate to the freshly created deck so the Hocuspocus seed plays
      // back as the editor mounts.
      void navigate(`/deck/${result.deckId}`)
    },
    onError: setError,
    hint: "You'll pick a folder on the next step.",
  })

  return (
    <div
      className="flex h-screen flex-col bg-background text-foreground"
      {...pptxImport.dropHandlers}
    >
      {pptxImport.fileInput}
      {pptxImport.overlay}

      {/* Header */}
      <header className="panel border-b border-border px-8 py-4">
        <div className="flex items-center justify-end">
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
              onClick={() => void handleCreateFolder()}
              disabled={creating}
              size="sm"
              variant="ghost"
              className="gap-1.5"
            >
              <FolderPlus className="h-4 w-4" aria-hidden="true" />
              {creating ? 'Creating…' : 'New folder'}
            </Button>
            <Button
              onClick={pptxImport.openFilePicker}
              size="sm"
              variant="ghost"
              className="gap-1.5"
              aria-label="Import PowerPoint"
              title="Import a .pptx file (or drop one anywhere on the page)"
            >
              <FileUp className="h-4 w-4" aria-hidden="true" />
              Import PPT
            </Button>
            <Button onClick={() => setNewDeckOpen(true)} size="sm" className="btn-brand gap-1.5">
              <Plus className="h-4 w-4" aria-hidden="true" />
              New deck
            </Button>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto px-8 py-6">
        {/* Hero */}
        <section className="mb-12 mt-12 text-center">
          <h1 className="text-7xl md:text-8xl font-bold tracking-tight leading-none bg-gradient-to-b from-foreground to-muted-foreground/60 bg-clip-text text-transparent">
            Narrative
          </h1>
          <p className="mt-4 text-base md:text-lg text-muted-foreground/80">
            Pro tool for keynote masters
          </p>
        </section>

        {error !== null && (
          <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive-foreground">
            {error}
          </div>
        )}

        {loading ? (
          <p className="text-sm text-muted-foreground/80">Loading folders…</p>
        ) : folders.length === 0 ? (
          <div className="flex flex-col items-center justify-center pt-24 text-center">
            <p className="text-muted-foreground">No folders yet.</p>
            <p className="mt-1 text-sm text-muted-foreground/60">
              Click <span className="text-foreground/80">+ New folder</span> to get started.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
            {folders.map((folder) => (
              <FolderCard
                key={folder.id}
                folder={folder}
                isDrafts={folder.name === 'Drafts'}
                editingInline={inlineEditId === folder.id}
                onOpen={() => void navigate(`/folder/${folder.id}`)}
                onRename={(name) => {
                  setInlineEditId(null)
                  void handleRenameFolder(folder.id, name)
                }}
                onDelete={() => void handleDeleteFolder(folder.id)}
                onInlineEditStart={() => setInlineEditId(folder.id)}
                onInlineEditEnd={() => setInlineEditId(null)}
              />
            ))}
          </div>
        )}
      </main>

      {/* New deck dialog */}
      {newDeckOpen && (
        <NewDeckDialog
          folders={folders}
          onClose={() => setNewDeckOpen(false)}
          onCreateFolder={async (name) => {
            const folder = await api.createFolder(name)
            setFolders((prev) => [...prev, folder])
            return folder
          }}
          onConfirm={async (folderId) => {
            const deck = await api.createDeck('Untitled Deck', folderId)
            void navigate(`/deck/${deck.id}`)
          }}
        />
      )}

      {/* Import PowerPoint dialog */}
      {pptxImport.dialog}

      {/* Non-empty folder delete blocker modal */}
      {deleteBlockedId !== null && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Cannot delete folder"
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/60 backdrop-blur-xs"
          onClick={(e) => {
            if (e.target === e.currentTarget) setDeleteBlockedId(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setDeleteBlockedId(null)
          }}
          tabIndex={-1}
        >
          <div className="panel w-[400px] rounded-xl border border-border p-5 shadow-xl">
            <h2 className="mb-2 text-sm font-semibold text-foreground">Cannot delete folder</h2>
            <p className="mb-4 text-sm text-muted-foreground">
              <span className="font-medium text-foreground">
                &ldquo;{blockedFolder?.name}&rdquo;
              </span>{' '}
              cannot be deleted. Drafts is the default folder and must always exist.
            </p>
            <div className="flex justify-end">
              <Button variant="ghost" size="sm" onClick={() => setDeleteBlockedId(null)}>
                OK
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// FolderCard
// ---------------------------------------------------------------------------

interface FolderCardProps {
  folder: FolderSummary
  isDrafts: boolean
  editingInline: boolean
  onOpen: () => void
  onRename: (name: string) => void
  onDelete: () => void
  onInlineEditStart: () => void
  onInlineEditEnd: () => void
}

function FolderCard({
  folder,
  isDrafts,
  editingInline,
  onOpen,
  onRename,
  onDelete,
  onInlineEditStart,
  onInlineEditEnd,
}: FolderCardProps) {
  const navigate = useNavigate()
  const [draft, setDraft] = useState(folder.name)
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Keep draft in sync when folder name changes from outside (e.g. rename from
  // another device, though unlikely in P1).
  useEffect(() => {
    if (!editingInline) setDraft(folder.name)
  }, [folder.name, editingInline])

  // Auto-focus on inline-edit entry (e.g. after folder creation).
  useEffect(() => {
    if (editingInline) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editingInline])

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

  const commitRename = () => {
    const trimmed = draft.trim()
    if (trimmed !== '' && trimmed !== folder.name) {
      onRename(trimmed)
    } else {
      setDraft(folder.name)
      onInlineEditEnd()
    }
  }

  const cancelRename = () => {
    setDraft(folder.name)
    onInlineEditEnd()
  }

  return (
    <div
      onClick={editingInline || menuOpen ? undefined : onOpen}
      className="panel group relative cursor-pointer rounded-lg border border-border p-4 hover:border-border-strong hover:shadow-glow transition-all"
    >
      {/* Cover placeholder — cover composite (up to 4 deck thumbnails) will be
          added once the server returns coverThumbnails in FolderSummary (P2). */}
      <div className="mb-3 aspect-video overflow-hidden rounded-md bg-surface-2 flex items-center justify-center">
        <Folder className="h-8 w-8 text-muted-foreground/30" aria-hidden="true" />
      </div>

      {/* Name row + actions */}
      <div className="flex items-center gap-1.5">
        {editingInline ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commitRename()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                cancelRename()
              }
            }}
            onBlur={commitRename}
            maxLength={200}
            className="min-w-0 flex-1 rounded-xs border border-border-strong bg-surface-1 px-1 py-0.5 text-sm font-medium text-foreground outline-none focus:ring-1 focus:ring-ring/40"
            aria-label="Folder name"
          />
        ) : (
          <>
            <p
              className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
              onDoubleClick={(e) => {
                e.stopPropagation()
                onInlineEditStart()
              }}
              title="Double-click to rename"
            >
              {folder.name}
            </p>
            {/* Kebab menu — hidden until hover, not shown for Drafts' delete option */}
            <div className="relative shrink-0 opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto">
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setMenuOpen((v) => !v)
                  setConfirmDelete(false)
                }}
                aria-label="Folder options"
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
                  aria-label="Folder options"
                  className="absolute right-0 top-full z-20 mt-1 w-36 rounded-md border border-border bg-popover py-1 shadow-lg"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false)
                      onInlineEditStart()
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
                      void navigate(`/folder/${folder.id}/settings`)
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-foreground hover:bg-accent"
                  >
                    <Settings className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                    Settings
                  </button>

                  {/* Delete — hidden for Drafts; cascades decks otherwise */}
                  {!isDrafts &&
                    (confirmDelete ? (
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
                        {folder.deckCount > 0
                          ? `Delete folder + ${folder.deckCount} deck${folder.deckCount === 1 ? '' : 's'}`
                          : 'Confirm delete'}
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
                    ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <p className="mt-0.5 text-xs text-muted-foreground/80">
        {folder.deckCount} {folder.deckCount === 1 ? 'deck' : 'decks'}
      </p>
    </div>
  )
}
