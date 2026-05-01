/**
 * pages/FolderSettings.tsx
 *
 * M16 P2 — Folder settings route: /folder/:folderId/settings
 *
 * Tabs:
 *   Colors      — grid of color swatches with inline rename + popover picker
 *   Text styles — list of text style rows with an editor panel
 *   Effect styles — shadow + blur presets
 *
 * Wraps with FolderDocProvider so token mutations land on the folder Y.Doc.
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ChevronLeft, Plus, Settings, Trash2, Upload, X } from 'lucide-react'
import { useApi } from '../api/client.js'
import type { FolderFontSummary } from '../api/client.js'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { HexColorPicker } from 'react-colorful'
import {
  FolderDocProvider,
  useFolderTokens,
  useFolderMutations,
} from '../state/FolderDocProvider.js'
import { FolderFontsProvider, useFolderFonts } from '../state/useFolderFonts.js'
import { FolderFontLoader } from '../state/FolderFontLoader.js'
import type { FolderSummary } from '../api/client.js'
import { MAX_COLORS } from '../state/defaultTokens.js'
import type { ColorTokenSnapshot, TextStyleTokenSnapshot } from '@narrative/slide-model'

// ---------------------------------------------------------------------------
// Tab type
// ---------------------------------------------------------------------------

type SettingsTab = 'colors' | 'textStyles' | 'fonts'

// ---------------------------------------------------------------------------
// FolderSettingsInner — rendered inside FolderDocProvider
// ---------------------------------------------------------------------------

function FolderSettingsInner({ folderId }: { folderId: string }) {
  const navigate = useNavigate()
  const api = useApi()
  const [folder, setFolder] = useState<FolderSummary | null>(null)
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const nameInputRef = useRef<HTMLInputElement>(null)
  const [activeTab, setActiveTab] = useState<SettingsTab>('colors')
  const [error, setError] = useState<string | null>(null)

  // Load folder info for the breadcrumb + name
  useEffect(() => {
    api
      .listFolders()
      .then((folders) => {
        const found = folders.find((f) => f.id === folderId)
        if (found === undefined) {
          void navigate('/')
          return
        }
        setFolder(found)
        setNameDraft(found.name)
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load folder')
      })
  }, [api, folderId, navigate])

  useEffect(() => {
    if (editingName) {
      nameInputRef.current?.focus()
      nameInputRef.current?.select()
    }
  }, [editingName])

  const commitNameRename = () => {
    const trimmed = nameDraft.trim()
    setEditingName(false)
    if (trimmed === '' || trimmed === folder?.name) {
      setNameDraft(folder?.name ?? '')
      return
    }
    setFolder((prev) => (prev !== null ? { ...prev, name: trimmed } : prev))
    void api.renameFolder(folderId, trimmed).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'Failed to rename folder')
    })
  }

  const TABS: { id: SettingsTab; label: string }[] = [
    { id: 'colors', label: 'Colors' },
    { id: 'fonts', label: 'Fonts' },
    { id: 'textStyles', label: 'Text styles' },
  ]

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* Header */}
      <header className="panel border-b border-border px-8 py-4">
        <div className="flex items-center gap-3 min-w-0">
          {/* Back to folder */}
          <button
            onClick={() => void navigate(`/folder/${folderId}`)}
            aria-label="Back to folder"
            className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 transition-colors"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            {folder?.name ?? '…'}
          </button>
          <span className="shrink-0 text-muted-foreground/40" aria-hidden="true">
            /
          </span>
          {editingName ? (
            <input
              ref={nameInputRef}
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commitNameRename()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  setEditingName(false)
                  setNameDraft(folder?.name ?? '')
                }
              }}
              onBlur={commitNameRename}
              maxLength={200}
              className="min-w-0 max-w-[240px] rounded-sm border border-border-strong bg-surface-1 px-1.5 py-0.5 text-sm font-semibold text-foreground outline-none focus:ring-1 focus:ring-ring/40"
              aria-label="Folder name"
            />
          ) : (
            <button
              onClick={() => {
                setNameDraft(folder?.name ?? '')
                setEditingName(true)
              }}
              className="min-w-0 max-w-[240px] truncate rounded-sm px-1.5 py-0.5 text-sm font-semibold text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              title="Click to rename folder"
            >
              {folder?.name ?? '…'}
            </button>
          )}
          <Settings className="h-4 w-4 shrink-0 text-muted-foreground/50" aria-hidden="true" />
          <span className="text-sm text-muted-foreground">Settings</span>
        </div>
      </header>

      {/* Tab bar */}
      <div className="flex border-b border-border bg-surface-1 px-8" role="tablist">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            aria-selected={activeTab === tab.id}
            role="tab"
            className={[
              'px-4 py-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40',
              activeTab === tab.id
                ? 'border-b-2 border-primary text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            ].join(' ')}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <main className="flex-1 overflow-y-auto">
        {error !== null && (
          <div className="mx-8 mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive-foreground">
            {error}
          </div>
        )}

        {activeTab === 'colors' && <ColorsTab folderId={folderId} />}
        {activeTab === 'fonts' && <FontsTab folderId={folderId} />}
        {activeTab === 'textStyles' && <TextStylesTab />}
      </main>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Fonts tab (M16 P3)
// ---------------------------------------------------------------------------

interface FontsTabProps {
  folderId: string
}

/**
 * Fonts tab body — wraps content in FolderFontsProvider so it can share the
 * same cache instance as DeckShell's FolderFontLoader when both are mounted,
 * and works standalone on the settings page when the editor isn't open.
 */
function FontsTab({ folderId }: FontsTabProps) {
  return (
    <FolderFontsProvider folderId={folderId}>
      {/* Register every uploaded font with document.fonts so the previews
          below render in the actual face instead of falling back to
          system-ui. Mirrors the loader DeckShell mounts during editing. */}
      <FolderFontLoader />
      <FontsTabInner folderId={folderId} />
    </FolderFontsProvider>
  )
}

function FontsTabInner({ folderId }: FontsTabProps) {
  const api = useApi()
  const { fonts, loading, error, refresh } = useFolderFonts()
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return
      setUploadError(null)

      for (const file of Array.from(files)) {
        const ext = file.name.split('.').pop()?.toLowerCase()
        if (!ext || !['ttf', 'otf', 'woff2'].includes(ext)) {
          setUploadError(
            `Unsupported file type: ${file.name}. Only .ttf, .otf, .woff2 are accepted.`,
          )
          continue
        }

        setUploading(true)
        try {
          const uploaded = await api.uploadFolderFont(folderId, file)
          // Push the font into document.fonts immediately so it's selectable
          // in text-style editor without a page reload.
          try {
            const face = new FontFace(uploaded.family, `url(${uploaded.url})`, {
              weight: String(uploaded.weight),
              style: uploaded.style,
              display: 'swap',
            })
            await face.load()
            document.fonts.add(face)
          } catch {
            // Font registered server-side; browser load failure is non-fatal here.
          }
          await refresh()
        } catch (err: unknown) {
          const body = (err as { body?: { error?: string } }).body
          const msg = body?.error ?? (err instanceof Error ? err.message : 'Upload failed')
          setUploadError(msg)
        } finally {
          setUploading(false)
        }
      }
    },
    [api, folderId, refresh],
  )

  const handleDelete = useCallback(
    async (assetId: string) => {
      setUploadError(null)
      try {
        await api.deleteFolderFont(folderId, assetId)
        await refresh()
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : 'Delete failed')
      }
    },
    [api, folderId, refresh],
  )

  return (
    <div className="px-8 py-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">Folder fonts</h2>
      </div>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".ttf,.otf,.woff2"
        multiple
        className="hidden"
        aria-hidden="true"
        onChange={(e) => void handleFiles(e.target.files)}
      />

      {/* Drop zone — also clickable to open the file picker */}
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        disabled={uploading}
        aria-label="Upload font — drop or click to choose"
        className={[
          'mb-4 flex w-full cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-8 text-center transition-colors',
          isDragOver
            ? 'border-primary bg-primary/5 text-foreground'
            : 'border-border text-muted-foreground hover:border-border-strong hover:text-foreground',
          uploading ? 'pointer-events-none opacity-60' : '',
        ].join(' ')}
        onDragOver={(e) => {
          e.preventDefault()
          setIsDragOver(true)
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setIsDragOver(false)
          void handleFiles(e.dataTransfer.files)
        }}
      >
        <Upload className="mb-2 h-6 w-6 opacity-60" aria-hidden="true" />
        <p className="text-sm font-medium">
          {uploading ? 'Uploading…' : 'Drop .ttf, .otf, or .woff2 here'}
        </p>
        <p className="mt-0.5 text-xs opacity-60">or click to choose a file</p>
      </button>

      {/* Error messages */}
      {(error !== null || uploadError !== null) && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive-foreground">
          {error ?? uploadError}
        </div>
      )}

      {/* Font list — grouped by family so multiple weights/styles share a row. */}
      {loading && fonts.length === 0 ? (
        <p className="text-xs text-muted-foreground/70">Loading…</p>
      ) : fonts.length === 0 ? (
        <p className="text-xs text-muted-foreground/70">No fonts uploaded yet.</p>
      ) : (
        <ul role="list" aria-label="Folder fonts" className="flex flex-col gap-2">
          {groupFontsByFamily(fonts).map((group) => (
            <FontFamilyRow key={group.family} group={group} onDelete={handleDelete} />
          ))}
        </ul>
      )}
    </div>
  )
}

interface FontFamilyGroup {
  family: string
  faces: FolderFontSummary[]
}

function groupFontsByFamily(fonts: FolderFontSummary[]): FontFamilyGroup[] {
  const map = new Map<string, FolderFontSummary[]>()
  for (const f of fonts) {
    const arr = map.get(f.family) ?? []
    arr.push(f)
    map.set(f.family, arr)
  }
  return [...map.entries()]
    .map(([family, faces]) => ({
      family,
      faces: faces.sort((a, b) => a.weight - b.weight || a.style.localeCompare(b.style)),
    }))
    .sort((a, b) => a.family.localeCompare(b.family))
}

interface FontFamilyRowProps {
  group: FontFamilyGroup
  onDelete: (assetId: string) => void
}

function FontFamilyRow({ group, onDelete }: FontFamilyRowProps) {
  const { family, faces } = group
  const totalKB = faces.reduce((sum, f) => sum + f.sizeBytes, 0) / 1024
  return (
    <li
      role="listitem"
      className="group flex items-stretch gap-3 rounded-md border border-border bg-surface-1 px-4 py-3"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{family}</p>
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {faces.map((f) => (
            <FaceChip key={f.assetId} face={f} onDelete={() => onDelete(f.assetId)} />
          ))}
        </div>
        <p className="mt-1.5 text-[10px] text-muted-foreground/50">
          {faces.length} {faces.length === 1 ? 'face' : 'faces'} · {totalKB.toFixed(0)} KB
        </p>
      </div>

      {/* Live preview rendered on a forced white surface */}
      <div className="hidden shrink-0 self-center rounded-md bg-white px-3 py-2 text-black sm:block">
        <span
          className="leading-tight"
          style={{
            fontFamily: `"${family}", system-ui, sans-serif`,
            fontWeight: faces[0]?.weight ?? 400,
            fontStyle: faces[0]?.style ?? 'normal',
            fontSize: 22,
          }}
        >
          The quick brown fox
        </span>
      </div>
    </li>
  )
}

interface FaceChipProps {
  face: FolderFontSummary
  onDelete: () => void
}

function FaceChip({ face, onDelete }: FaceChipProps) {
  const [confirming, setConfirming] = useState(false)
  const label = `${face.weight}${face.style === 'italic' ? ' italic' : ''}`
  return (
    <span className="inline-flex items-center gap-1 rounded border border-border bg-surface-2 px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
      {label}
      {confirming ? (
        <>
          <button
            type="button"
            onClick={() => {
              setConfirming(false)
              onDelete()
            }}
            className="rounded px-1 text-destructive hover:bg-destructive/10"
            aria-label={`Confirm delete ${face.postscriptName}`}
          >
            ✓
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="rounded px-1 text-muted-foreground hover:bg-accent"
            aria-label="Cancel"
          >
            ✕
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          aria-label={`Delete ${face.postscriptName}`}
          className="opacity-0 transition group-hover:opacity-100 hover:text-destructive"
        >
          <Trash2 className="h-2.5 w-2.5" aria-hidden="true" />
        </button>
      )}
    </span>
  )
}

// Legacy single-font row (unused now after grouping; kept as reference until P3 wraps).

interface FontRowProps {
  font: FolderFontSummary
  onDelete: (assetId: string) => void
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function FontRow({ font, onDelete }: FontRowProps) {
  const [confirming, setConfirming] = useState(false)

  return (
    <li
      role="listitem"
      className="group flex items-center gap-3 rounded-md border border-border bg-surface-1 px-4 py-3"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{font.family}</p>
        <p className="mt-0.5 text-xs text-muted-foreground/70">
          {font.weight} · {font.style} · {font.postscriptName}
        </p>
        <p className="mt-0.5 text-[10px] text-muted-foreground/50">
          {(font.sizeBytes / 1024).toFixed(0)} KB
        </p>
      </div>

      {/* Live preview rendered with the uploaded font, on a forced
          white surface so light variants stay legible against dark
          theme. */}
      <div className="hidden shrink-0 rounded-md bg-white px-3 py-2 text-black sm:block">
        <span
          className="leading-tight"
          style={{
            fontFamily: `"${font.family}", system-ui, sans-serif`,
            fontWeight: font.weight,
            fontStyle: font.style,
            fontSize: 22,
          }}
        >
          The quick brown fox
        </span>
      </div>

      {confirming ? (
        <div className="flex shrink-0 items-center gap-1">
          <span className="text-xs text-muted-foreground">Delete?</span>
          <button
            type="button"
            onClick={() => {
              setConfirming(false)
              onDelete(font.assetId)
            }}
            className="rounded-md px-2 py-0.5 text-xs text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            aria-label={`Confirm delete ${font.family}`}
          >
            Yes
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="rounded-md px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            aria-label="Cancel delete"
          >
            No
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          aria-label={`Delete font ${font.family}`}
          className="shrink-0 rounded-md p-1 text-muted-foreground opacity-0 transition group-hover:opacity-100 hover:bg-accent hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
    </li>
  )
}

// ---------------------------------------------------------------------------
// Colors tab
// ---------------------------------------------------------------------------

interface ColorsTabProps {
  folderId: string
}

function ColorsTab({ folderId: _folderId }: ColorsTabProps) {
  const snapshot = useFolderTokens()
  const { addToken, updateToken, deleteToken, listUsages } = useFolderMutations()
  const colorsList = Object.values(snapshot.colors)
  const atCap = colorsList.length >= MAX_COLORS

  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null)
  const [deleteUsages, setDeleteUsages] = useState<string[]>([])

  const handleAddColor = () => {
    if (atCap) return
    addToken('colors', { name: 'New color', value: '#3b82f6' })
  }

  const handleDeleteRequest = (id: string) => {
    const usages = listUsages('colors', id)
    setDeleteUsages(usages)
    setDeleteTargetId(id)
  }

  const handleDeleteConfirm = () => {
    if (deleteTargetId !== null) {
      deleteToken('colors', deleteTargetId)
    }
    setDeleteTargetId(null)
    setDeleteUsages([])
  }

  return (
    <div className="px-8 py-6">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-foreground">Color tokens</h2>
          <span className="text-xs tabular-nums text-muted-foreground/70">
            {colorsList.length} / {MAX_COLORS}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {atCap && (
            <span className="text-xs text-muted-foreground/80">
              Maximum {MAX_COLORS} colors per folder — delete one to add another.
            </span>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="gap-1.5"
            onClick={handleAddColor}
            disabled={atCap}
            aria-label="Add new color token"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add color
          </Button>
        </div>
      </div>

      {colorsList.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <p className="text-sm text-muted-foreground">No colors defined yet.</p>
          <p className="mt-1 text-xs text-muted-foreground/60">
            Click <span className="text-foreground/70">+ New color</span> to add your first color
            token.
          </p>
        </div>
      ) : (
        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(80px, 1fr))' }}
          role="list"
          aria-label="Color tokens"
        >
          {colorsList.map((color) => (
            <ColorSwatch
              key={color.id}
              color={color}
              onUpdate={(patch) => updateToken('colors', color.id, patch)}
              onDeleteRequest={() => handleDeleteRequest(color.id)}
            />
          ))}
        </div>
      )}

      {/* Delete confirmation modal (usage-aware, P4 wires real usage list) */}
      {deleteTargetId !== null && (
        <DeleteTokenModal
          tokenName={snapshot.colors[deleteTargetId]?.name ?? 'color'}
          usageCount={deleteUsages.length}
          onConfirm={handleDeleteConfirm}
          onCancel={() => {
            setDeleteTargetId(null)
            setDeleteUsages([])
          }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// ColorSwatch — single swatch cell with inline rename + popover picker
// ---------------------------------------------------------------------------

interface ColorSwatchProps {
  color: ColorTokenSnapshot
  onUpdate: (patch: Partial<Omit<ColorTokenSnapshot, 'id'>>) => void
  onDeleteRequest: () => void
}

function ColorSwatch({ color, onUpdate, onDeleteRequest }: ColorSwatchProps) {
  const [editing, setEditing] = useState(false)
  const [nameDraft, setNameDraft] = useState(color.name)
  const [pickerOpen, setPickerOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!editing) setNameDraft(color.name)
  }, [color.name, editing])

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  const commitName = () => {
    setEditing(false)
    const trimmed = nameDraft.trim()
    if (trimmed !== '' && trimmed !== color.name) {
      onUpdate({ name: trimmed })
    } else {
      setNameDraft(color.name)
    }
  }

  return (
    <div role="listitem" className="group relative flex flex-col items-center gap-1.5">
      {/* Swatch — click opens color picker popover */}
      <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Color: ${color.name} (${color.value}). Click to edit.`}
            title={`${color.name}\n${color.value.toUpperCase()}`}
            className="h-20 w-full rounded-lg border-2 border-transparent transition hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            style={{ background: color.value }}
          />
        </PopoverTrigger>
        <PopoverContent className="w-52 p-3" side="bottom" align="center" sideOffset={4}>
          <div className="flex flex-col gap-3">
            <HexColorPicker
              color={color.value}
              onChange={(hex) => onUpdate({ value: hex })}
              style={{ width: '100%', height: 130 }}
            />
            <input
              type="text"
              aria-label="Color hex value"
              value={color.value.toUpperCase()}
              onChange={(e) => {
                const raw = e.target.value.trim()
                const hex = raw.startsWith('#') ? raw : `#${raw}`
                if (/^#[0-9a-f]{6}$/i.test(hex)) {
                  onUpdate({ value: hex.toLowerCase() })
                }
              }}
              className="rounded-md border border-input field-surface px-2 py-1 font-mono text-xs text-foreground focus:border-ring focus:outline-none"
            />
          </div>
        </PopoverContent>
      </Popover>

      {/* Delete button — appears on hover */}
      <button
        type="button"
        onClick={onDeleteRequest}
        aria-label={`Delete color ${color.name}`}
        className="absolute right-1 top-1 hidden rounded-md p-0.5 text-white/80 opacity-0 transition group-hover:opacity-100 group-hover:block hover:bg-black/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <X className="h-3 w-3" aria-hidden="true" />
      </button>

      {/* Hex label */}
      <p className="text-[10px] tabular-nums text-muted-foreground/70">
        {color.value.toUpperCase()}
      </p>

      {/* Inline-editable name */}
      {editing ? (
        <input
          ref={inputRef}
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commitName()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setEditing(false)
              setNameDraft(color.name)
            }
          }}
          onBlur={commitName}
          maxLength={80}
          className="w-full rounded-sm border border-border-strong bg-surface-1 px-1 py-0.5 text-center text-[11px] text-foreground outline-none focus:ring-1 focus:ring-ring/40"
          aria-label="Color name"
        />
      ) : (
        <button
          type="button"
          onDoubleClick={() => setEditing(true)}
          title="Double-click to rename"
          className="max-w-full truncate rounded-sm px-1 py-0.5 text-center text-[11px] text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/40"
        >
          {color.name}
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Text styles tab
// ---------------------------------------------------------------------------

function TextStylesTab() {
  const snapshot = useFolderTokens()
  const { addToken, updateToken, deleteToken, listUsages } = useFolderMutations()
  const stylesList = Object.values(snapshot.textStyles)
  const colorsList = Object.values(snapshot.colors)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null)
  const [deleteUsages, setDeleteUsages] = useState<string[]>([])

  const selected = selectedId !== null ? (snapshot.textStyles[selectedId] ?? null) : null

  const handleAdd = () => {
    const id = addToken('textStyles', {
      name: 'New style',
      family: 'Inter, sans-serif',
      weight: 400,
      size: 16,
      lineHeight: 1.5,
      letterSpacing: 0,
      color: '#111111',
    })
    setSelectedId(id)
  }

  const handleDeleteRequest = (id: string) => {
    const usages = listUsages('textStyles', id)
    setDeleteUsages(usages)
    setDeleteTargetId(id)
  }

  const handleDeleteConfirm = () => {
    if (deleteTargetId !== null) {
      deleteToken('textStyles', deleteTargetId)
      if (selectedId === deleteTargetId) setSelectedId(null)
    }
    setDeleteTargetId(null)
    setDeleteUsages([])
  }

  return (
    <div className="flex h-[calc(100vh-140px)] min-h-0">
      {/* List */}
      <div className="w-64 shrink-0 border-r border-border overflow-y-auto">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground">Text styles</h2>
          <button
            type="button"
            onClick={handleAdd}
            aria-label="Add text style"
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {stylesList.length === 0 ? (
          <p className="px-4 py-6 text-xs text-muted-foreground/70">
            No text styles yet. Click + to add one.
          </p>
        ) : (
          <ul role="listbox" aria-label="Text styles" className="py-1">
            {stylesList.map((style) => (
              <li
                key={style.id}
                role="option"
                aria-selected={selectedId === style.id}
                onClick={() => setSelectedId(style.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setSelectedId(style.id)
                  }
                }}
                tabIndex={0}
                className={[
                  'group flex w-full cursor-pointer items-center gap-2 px-4 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40',
                  selectedId === style.id
                    ? 'bg-primary/10 text-foreground'
                    : 'text-foreground hover:bg-accent',
                ].join(' ')}
              >
                {/* Mini preview — forced white background so light token
                    colors stay legible against the dark UI. */}
                <span
                  className="shrink-0 grid h-7 w-8 place-items-center rounded bg-white leading-none"
                  style={{
                    fontFamily: style.family,
                    fontWeight: style.weight,
                    fontSize: Math.min(style.size ?? 16, 14),
                    color: typeof style.color === 'string' ? style.color : '#0f172a',
                  }}
                  aria-hidden="true"
                >
                  Aa
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px]">{style.name}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    handleDeleteRequest(style.id)
                  }}
                  aria-label={`Delete style ${style.name}`}
                  className="shrink-0 rounded-md p-1 text-muted-foreground opacity-0 transition group-hover:opacity-100 hover:bg-accent hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  <Trash2 className="h-3 w-3" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Editor panel */}
      <div className="flex-1 overflow-y-auto px-8 py-6">
        {selected !== null ? (
          <TextStyleEditor
            style={selected}
            colors={colorsList}
            onUpdate={(patch) => updateToken('textStyles', selected.id, patch)}
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-muted-foreground">Select a style to edit</p>
          </div>
        )}
      </div>

      {deleteTargetId !== null && (
        <DeleteTokenModal
          tokenName={snapshot.textStyles[deleteTargetId]?.name ?? 'style'}
          usageCount={deleteUsages.length}
          onConfirm={handleDeleteConfirm}
          onCancel={() => {
            setDeleteTargetId(null)
            setDeleteUsages([])
          }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// TextStyleEditor
// ---------------------------------------------------------------------------

interface TextStyleEditorProps {
  style: TextStyleTokenSnapshot
  colors: ColorTokenSnapshot[]
  onUpdate: (patch: Partial<Omit<TextStyleTokenSnapshot, 'id'>>) => void
}

function TextStyleEditor({ style, colors, onUpdate }: TextStyleEditorProps) {
  const [nameDraft, setNameDraft] = useState(style.name)

  useEffect(() => {
    setNameDraft(style.name)
  }, [style.id, style.name])

  const colorValue = typeof style.color === 'string' ? style.color : '#000000'

  return (
    <div className="flex flex-col gap-4 max-w-sm">
      <h3 className="text-sm font-semibold text-foreground">Edit text style</h3>

      {/* Name */}
      <SettingsFieldRow label="Name">
        <input
          type="text"
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={() => {
            const trimmed = nameDraft.trim()
            if (trimmed !== '' && trimmed !== style.name) {
              onUpdate({ name: trimmed })
            } else {
              setNameDraft(style.name)
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
          className="w-full rounded-md border border-input field-surface px-2 py-1 text-sm text-foreground focus:border-ring focus:outline-none"
          aria-label="Style name"
        />
      </SettingsFieldRow>

      {/* Font family */}
      <SettingsFieldRow label="Family">
        <input
          type="text"
          value={style.family ?? ''}
          onChange={(e) => onUpdate({ family: e.target.value })}
          className="w-full rounded-md border border-input field-surface px-2 py-1 text-sm text-foreground focus:border-ring focus:outline-none"
          aria-label="Font family"
        />
      </SettingsFieldRow>

      {/* Font weight */}
      <SettingsFieldRow label="Weight">
        <select
          value={String(style.weight ?? 400)}
          onChange={(e) => onUpdate({ weight: Number(e.target.value) as 400 })}
          className="w-full rounded-md border border-input field-surface px-2 py-1 text-sm text-foreground focus:border-ring focus:outline-none"
          aria-label="Font weight"
        >
          {[100, 200, 300, 400, 500, 600, 700, 800, 900].map((w) => (
            <option key={w} value={w}>
              {w}
            </option>
          ))}
        </select>
      </SettingsFieldRow>

      {/* Font size */}
      <SettingsFieldRow label="Size">
        <input
          type="number"
          min={1}
          value={style.size ?? 16}
          onChange={(e) => onUpdate({ size: Math.max(1, Number(e.target.value)) })}
          className="w-full rounded-md border border-input field-surface px-2 py-1 text-sm text-foreground focus:border-ring focus:outline-none"
          aria-label="Font size"
        />
      </SettingsFieldRow>

      {/* Line height */}
      <SettingsFieldRow label="Line height">
        <input
          type="number"
          min={0.5}
          step={0.05}
          value={style.lineHeight ?? 1.5}
          onChange={(e) => onUpdate({ lineHeight: Math.max(0.5, Number(e.target.value)) })}
          className="w-full rounded-md border border-input field-surface px-2 py-1 text-sm text-foreground focus:border-ring focus:outline-none"
          aria-label="Line height"
        />
      </SettingsFieldRow>

      {/* Letter spacing */}
      <SettingsFieldRow label="Letter spacing">
        <input
          type="number"
          step={0.01}
          value={style.letterSpacing ?? 0}
          onChange={(e) => onUpdate({ letterSpacing: Number(e.target.value) })}
          className="w-full rounded-md border border-input field-surface px-2 py-1 text-sm text-foreground focus:border-ring focus:outline-none"
          aria-label="Letter spacing"
        />
      </SettingsFieldRow>

      {/* Color — literal hex */}
      <SettingsFieldRow label="Color">
        <div className="flex items-center gap-1.5">
          <input
            type="color"
            value={colorValue}
            onChange={(e) => onUpdate({ color: e.target.value })}
            className="h-7 w-10 cursor-pointer rounded border border-input p-0.5 focus:outline-none"
            aria-label="Text color"
          />
          <input
            type="text"
            value={colorValue}
            onChange={(e) => {
              const raw = e.target.value.trim()
              const hex = raw.startsWith('#') ? raw : `#${raw}`
              if (/^#[0-9a-f]{6}$/i.test(hex)) {
                onUpdate({ color: hex.toLowerCase() })
              }
            }}
            className="w-full rounded-md border border-input field-surface px-2 py-1 font-mono text-sm text-foreground focus:border-ring focus:outline-none"
            aria-label="Color hex"
          />
        </div>
        {/* Token color swatches from Colors tab */}
        {colors.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Color tokens">
            {colors.map((c) => (
              <button
                key={c.id}
                type="button"
                title={`${c.name} (${c.value.toUpperCase()})`}
                aria-label={`Use color token: ${c.name}`}
                onClick={() => onUpdate({ color: c.value })}
                className={[
                  'h-5 w-5 rounded-sm border transition',
                  colorValue === c.value
                    ? 'border-foreground shadow-[0_0_0_1.5px_hsl(var(--background))_inset]'
                    : 'border-border hover:border-border-strong',
                ].join(' ')}
                style={{ background: c.value }}
              />
            ))}
          </div>
        )}
      </SettingsFieldRow>

      {/* Preview — render on a white slide-like surface so the
          token color is always legible regardless of editor theme. */}
      <div className="mt-2 rounded-lg border border-border bg-white p-4 text-black">
        <p
          style={{
            fontFamily: style.family,
            fontWeight: style.weight,
            fontSize: style.size,
            lineHeight: style.lineHeight,
            letterSpacing: style.letterSpacing,
            color: colorValue,
          }}
        >
          The quick brown fox jumps over the lazy dog.
        </p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// DeleteTokenModal — usage-aware delete confirm.
// P2: listUsages() stubs return []. P4 wires real usage scanning.
// ---------------------------------------------------------------------------

interface DeleteTokenModalProps {
  tokenName: string
  usageCount: number
  onConfirm: () => void
  onCancel: () => void
}

function DeleteTokenModal({ tokenName, usageCount, onConfirm, onCancel }: DeleteTokenModalProps) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Delete ${tokenName}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel()
      }}
      tabIndex={-1}
    >
      <div className="panel w-[400px] rounded-xl border border-border p-5 shadow-xl">
        <h2 className="mb-2 text-sm font-semibold text-foreground">
          Delete &ldquo;{tokenName}&rdquo;?
        </h2>

        {usageCount > 0 ? (
          <p className="mb-4 text-sm text-muted-foreground">
            This token is referenced in{' '}
            <span className="font-medium text-foreground">{usageCount} place(s)</span>. Deleting it
            will break those references.
          </p>
        ) : (
          <p className="mb-4 text-sm text-muted-foreground">
            This token is not currently used in any slide. It will be permanently removed.
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" size="sm" onClick={onConfirm}>
            {usageCount > 0 ? 'Delete anyway' : 'Delete'}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// SettingsFieldRow helper
// ---------------------------------------------------------------------------

function SettingsFieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-muted-foreground">{label}</label>
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// FolderSettings — root export with FolderDocProvider wrapper
// ---------------------------------------------------------------------------

export function FolderSettings() {
  const { folderId } = useParams<{ folderId: string }>()

  if (folderId === undefined) return null

  return (
    <FolderDocProvider folderId={folderId}>
      <FolderSettingsInner folderId={folderId} />
    </FolderDocProvider>
  )
}
