/**
 * ui/ImportPptxDialog.tsx
 *
 * M28 — Folder picker that runs after the user has selected (or dropped) a
 * `.pptx` to import. Sibling of `NewDeckDialog`: same folder list + create-new
 * UX, different header / CTA, plus a file-info row so the user sees which
 * file they're about to ingest.
 */

import { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  FileUp,
  Folder,
  FolderPlus,
  Info,
  Loader2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { FolderSummary, ImportPptxResult } from '../api/client.js'
import { IMPORT_KNOWN_LOSSES, relevantIgnoredElements } from '../lib/pptxCompat.js'

interface ImportPptxDialogProps {
  file: File
  folders: FolderSummary[]
  /** Performs the import. Resolves with the server's summary so the dialog
   *  can show it briefly before navigating. Rejects with `{ body: { error } }`
   *  on 4xx so we surface the actual server message. The dialog passes a
   *  callback shape so the implementation can drive a percentage bar — the
   *  tus path reports per-chunk progress; the legacy synchronous fetch
   *  implementation can ignore it. */
  onImport: (
    folderId: string,
    file: File,
    opts: { onProgress?: (fraction: number) => void },
  ) => Promise<ImportPptxResult>
  onCreateFolder: (name: string) => Promise<FolderSummary>
  /** Called after the success summary has been on-screen long enough to be
   *  read — typically the parent navigates to the new deck here. */
  onSuccess: (result: ImportPptxResult) => void
  onClose: () => void
}

/** How long the "Imported N slides…" message stays visible before we
 *  invoke onSuccess. Long enough to register, short enough not to annoy. */
const SUCCESS_DISPLAY_MS = 1_400

export function ImportPptxDialog({
  file,
  folders,
  onImport,
  onCreateFolder,
  onSuccess,
  onClose,
}: ImportPptxDialogProps) {
  const [selectedId, setSelectedId] = useState<string | null>(folders[0]?.id ?? null)
  const [creatingNew, setCreatingNew] = useState(false)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<ImportPptxResult | null>(null)
  // Upload progress (0..1). Tracked separately from `busy` so the bar can
  // render while bytes flow; the post-upload server processing step (parse
  // + DB writes) lives between the last byte and `success`, during which
  // the progress fraction stays at 1 and the label flips to "Processing…".
  const [progress, setProgress] = useState(0)
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'processing'>('idle')
  const newNameInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (creatingNew) newNameInputRef.current?.focus()
  }, [creatingNew])

  // Auto-advance from "success" → onSuccess (navigation) after a short
  // pause, BUT only when the import was clean (no unsupported elements
  // detected). When the parser flagged content that couldn't come
  // through (charts, smartart, etc.) we pause and require the user to
  // dismiss the warnings explicitly — they should know what changed
  // before they land on the deck.
  const importIssues = success === null ? [] : relevantIgnoredElements(success.ignoredElements)
  // Surface the "fonts weren't embedded" advisory whenever a deck with
  // content was imported but `<p:embeddedFontLst>` was empty. We can't
  // tell at this point whether the deck actually references custom
  // fonts (the API doesn't return the family list), but in practice
  // decks without embedded fonts are the ones that benefit from the
  // category-fallback explanation. Cheap to surface; cheaper to dismiss.
  const fontFallbackAdvisory =
    success !== null && success.objectsCreated > 0 && (success.embeddedFontCount ?? 0) === 0
  const hasAnyNotice = importIssues.length > 0 || fontFallbackAdvisory
  useEffect(() => {
    if (success === null) return
    if (hasAnyNotice) return
    const t = setTimeout(() => onSuccess(success), SUCCESS_DISPLAY_MS)
    return () => clearTimeout(t)
  }, [success, hasAnyNotice, onSuccess])

  const handleConfirm = async () => {
    setError(null)
    setBusy(true)
    setProgress(0)
    setPhase('uploading')
    try {
      let folderId = selectedId
      if (creatingNew) {
        const trimmed = newName.trim()
        if (trimmed === '') {
          setError('Folder name cannot be empty.')
          setBusy(false)
          setPhase('idle')
          return
        }
        const created = await onCreateFolder(trimmed)
        folderId = created.id
      }
      if (folderId == null) {
        setError('Pick a folder first.')
        setBusy(false)
        setPhase('idle')
        return
      }
      const result = await onImport(folderId, file, {
        onProgress: (fraction) => {
          setProgress(fraction)
          if (fraction >= 1) setPhase('processing')
        },
      })
      // Leave `busy` true so the inputs stay disabled while the success
      // panel is showing — it's not "interactive" any more.
      setSuccess(result)
    } catch (err) {
      // Server returns a structured body on 4xx; pick out the most useful field.
      const body = (err as { body?: { error?: string } }).body
      setError(body?.error ?? (err instanceof Error ? err.message : 'Import failed'))
      setBusy(false)
      setPhase('idle')
    }
  }

  const sizeLabel = formatBytes(file.size)

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Import PowerPoint deck"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !busy) onClose()
      }}
      tabIndex={-1}
    >
      <div className="panel w-[460px] rounded-xl border border-border p-5 shadow-xl">
        <h2 className="mb-1 text-sm font-semibold text-foreground">Import PowerPoint</h2>
        <p className="mb-4 text-xs text-muted-foreground">
          Pick a folder for the imported deck or create a new one.
        </p>

        {/* Success summary — replaces the form once the import resolves.
            We keep showing the file + dialog chrome so the transition isn't
            jarring, but the actions area becomes a static message. */}
        {success !== null && (
          <div
            role="status"
            aria-live="polite"
            className="mb-4 flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-foreground"
          >
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                Imported {success.slideCount} slide{success.slideCount === 1 ? '' : 's'}.
              </p>
              <p className="mt-0.5 text-muted-foreground">
                {success.objectsCreated} object{success.objectsCreated === 1 ? '' : 's'} created
                {success.embeddedFontCount !== undefined && success.embeddedFontCount > 0
                  ? ` · ${success.embeddedFontCount} embedded font${
                      success.embeddedFontCount === 1 ? '' : 's'
                    } imported`
                  : ''}
                {success.skipped.images > 0 ? ` · ${success.skipped.images} image(s) skipped` : ''}
                {success.skipped.unknownShapes > 0
                  ? ` · ${success.skipped.unknownShapes} unsupported shape(s) skipped`
                  : ''}
                {success.skipped.fonts !== undefined && success.skipped.fonts > 0
                  ? ` · ${success.skipped.fonts} font${
                      success.skipped.fonts === 1 ? '' : 's'
                    } couldn’t be parsed`
                  : ''}
                {!hasAnyNotice ? '. Opening deck…' : '.'}
              </p>
            </div>
          </div>
        )}

        {/* Import compatibility warnings — surface the categories the
            parser flagged plus the static known-losses for each so the
            user can investigate after opening the deck. */}
        {success !== null && hasAnyNotice && (
          <div className="mb-4 space-y-2">
            <h3 className="flex items-center gap-1.5 text-xs font-medium text-foreground">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-500" aria-hidden="true" />
              Some content couldn’t come through
            </h3>
            <ul className="space-y-2">
              {IMPORT_KNOWN_LOSSES.filter((entry) => {
                if (entry.id === 'unembeddedFonts') return fontFallbackAdvisory
                return matchesIgnoredCategory(entry.id, importIssues)
              }).map((entry) => (
                <li
                  key={entry.id}
                  className="rounded-md border border-border bg-surface-1 px-3 py-2 text-xs text-muted-foreground"
                >
                  <p className="font-medium text-foreground">{entry.title}</p>
                  <p className="mt-1 leading-relaxed">{entry.detail}</p>
                </li>
              ))}
            </ul>
            {/* If the parser flagged a tag that doesn't map to a known
                category we still want to surface it generically. */}
            {importIssues.some((t) => !KNOWN_TAGS_BY_CATEGORY.has(t)) && (
              <p className="flex items-start gap-1.5 rounded-md border border-border bg-surface-1 px-3 py-2 text-xs text-muted-foreground">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>
                  Additional unsupported elements were skipped:{' '}
                  <code className="text-foreground/80">
                    {importIssues.filter((t) => !KNOWN_TAGS_BY_CATEGORY.has(t)).join(', ')}
                  </code>
                  .
                </span>
              </p>
            )}
          </div>
        )}

        {/* File summary */}
        <div className="mb-4 flex items-center gap-2 rounded-md border border-border bg-surface-1 px-3 py-2">
          <FileUp className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-foreground" title={file.name}>
              {file.name}
            </p>
            <p className="text-xs text-muted-foreground">{sizeLabel}</p>
          </div>
        </div>

        {/* Folder list */}
        <div className="max-h-64 overflow-y-auto rounded-md border border-border">
          {folders.length === 0 && !creatingNew && (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              No folders yet. Create one below.
            </p>
          )}
          {folders.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => {
                setSelectedId(f.id)
                setCreatingNew(false)
              }}
              className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                !creatingNew && selectedId === f.id
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
              }`}
            >
              <Folder className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="flex-1 truncate">{f.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground/70">
                {f.deckCount} {f.deckCount === 1 ? 'deck' : 'decks'}
              </span>
            </button>
          ))}
        </div>

        {/* Create-new-folder row */}
        <div className="mt-3">
          {creatingNew ? (
            <div className="flex items-center gap-2 rounded-md border border-border-strong bg-surface-1 px-2 py-1.5">
              <FolderPlus
                className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <input
                ref={newNameInputRef}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !busy) {
                    e.preventDefault()
                    void handleConfirm()
                  }
                }}
                placeholder="New folder name"
                maxLength={200}
                className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none"
                aria-label="New folder name"
              />
              <button
                type="button"
                onClick={() => {
                  setCreatingNew(false)
                  setNewName('')
                }}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setCreatingNew(true)}
              className="flex w-full items-center gap-2 rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground hover:border-border-strong hover:text-foreground transition-colors"
            >
              <FolderPlus className="h-3.5 w-3.5" aria-hidden="true" />
              Create new folder
            </button>
          )}
        </div>

        {/* Upload progress + processing status. Visible while bytes are
            in flight (`uploading`) and during the post-upload server-side
            parse step (`processing`). Hidden in the idle state and once
            the success panel takes over. */}
        {(phase === 'uploading' || phase === 'processing') && success === null && (
          <div className="mt-3" aria-live="polite">
            <div className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
              <span>
                {phase === 'uploading'
                  ? `Uploading… ${Math.round(progress * 100)}%`
                  : 'Processing…'}
              </span>
              {phase === 'uploading' && (
                <span className="text-[10px] tracking-wide">
                  {formatBytes(Math.round(progress * file.size))} / {formatBytes(file.size)}
                </span>
              )}
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-1">
              <div
                className="h-full bg-primary transition-[width] duration-150 ease-linear"
                style={{
                  width: phase === 'processing' ? '100%' : `${Math.round(progress * 100)}%`,
                }}
              />
            </div>
          </div>
        )}

        {error !== null && <p className="mt-3 text-xs text-destructive-foreground">{error}</p>}

        {/* Actions */}
        <div className="mt-5 flex justify-end gap-2">
          {success !== null && importIssues.length > 0 ? (
            // Successful import that needs explicit user dismissal — single
            // CTA jumps to the deck.
            <Button size="sm" onClick={() => onSuccess(success)} className="btn-brand gap-1.5">
              <FileUp className="h-3.5 w-3.5" aria-hidden="true" />
              Open deck
            </Button>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => void handleConfirm()}
                disabled={busy || (!creatingNew && selectedId == null)}
                className="btn-brand gap-1.5"
              >
                {busy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <FileUp className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                {busy ? 'Importing…' : 'Import'}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Map parser-flagged tag names → which `IMPORT_KNOWN_LOSSES` category
 * they belong to. The compat scanner already surfaces a curated subset
 * via `relevantIgnoredElements`, so this lookup just figures out which
 * static panel entry to highlight for each flagged tag.
 */
const KNOWN_TAGS_BY_CATEGORY: ReadonlyMap<string, string> = new Map([
  ['a:chart', 'charts'],
  ['c:chart', 'charts'],
  ['a:smartArt', 'smartArt'],
  ['p:oleObj', 'oleEmbed'],
  ['p:OLEObject', 'oleEmbed'],
  ['mc:AlternateContent', 'oleEmbed'],
  ['p:bldOver', 'complexTiming'],
  ['p:tnLst', 'complexTiming'],
])

function matchesIgnoredCategory(categoryId: string, ignored: string[]): boolean {
  return ignored.some((tag) => KNOWN_TAGS_BY_CATEGORY.get(tag) === categoryId)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
