/**
 * ui/ImportPptxDialog.tsx
 *
 * M28 — Folder picker that runs after the user has selected (or dropped) a
 * `.pptx` to import. Sibling of `NewDeckDialog`: same folder list + create-new
 * UX, different header / CTA, plus a file-info row so the user sees which
 * file they're about to ingest.
 *
 * With a `targetFolder` (the page is already inside a folder) there is
 * nothing to choose: the picker is left out and the import starts as soon as
 * the dialog opens. The dialog still carries the upload progress, the result
 * and the missing-font uploads — only the question is gone.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  FileUp,
  Folder,
  FolderPlus,
  Info,
  Loader2,
  Upload as UploadIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { type FolderSummary, type ImportPptxResult, useApi } from '../api/client.js'
import { IMPORT_KNOWN_LOSSES, relevantIgnoredElements } from '../lib/pptxCompat.js'
import { invalidateFolderFontsCache } from '../state/useFolderFonts.js'

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
  /** Import straight into this folder: no picker, no confirm click. */
  targetFolder?: FolderSummary
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
  targetFolder,
}: ImportPptxDialogProps) {
  const [selectedId, setSelectedId] = useState<string | null>(
    targetFolder?.id ?? folders[0]?.id ?? null,
  )
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
  const api = useApi()
  // Per-family upload state: keyed by the missing family name.
  // `busy` = upload in flight for THIS family, `error` = last error
  // (cleared on retry). When upload succeeds the family moves to
  // `resolvedFamilies` and disappears from the missing list.
  const [familyUploads, setFamilyUploads] = useState<
    Map<string, { busy: boolean; error: string | null }>
  >(new Map())

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
  // Track the folderId used for the import so we know where to POST
  // user-uploaded missing fonts. We can't read `selectedId` directly
  // when "create new folder" was used — `handleConfirm` resolves that
  // case into a real folder id, and we stash it here for the
  // missing-fonts panel.
  const importedFolderIdRef = useRef<string | null>(null)
  // Family names the user has just uploaded through this dialog. Once
  // a family lands here we drop it from `missingFonts` so the row
  // collapses to a "✓ uploaded" state without a full page refresh.
  const [resolvedFamilies, setResolvedFamilies] = useState<Set<string>>(new Set())
  // Lowercased family names already uploaded to the target folder
  // BEFORE this import ran. Fetched once after the deck is created
  // (we don't know which folder until then). Used to filter
  // `missingFonts` so the dialog doesn't ask the user to re-upload a
  // face the folder already has — important when re-importing the
  // same .pptx into a folder where fonts were already added.
  const [preExistingFolderFamilies, setPreExistingFolderFamilies] = useState<Set<string>>(new Set())
  useEffect(() => {
    if (success === null) return
    const folderId = importedFolderIdRef.current
    if (folderId === null) return
    let cancelled = false
    void (async () => {
      try {
        const fonts = await api.listFolderFonts(folderId)
        if (cancelled) return
        setPreExistingFolderFamilies(new Set(fonts.map((f) => f.family.toLowerCase().trim())))
      } catch {
        // Silently leave the set empty — worst case the user sees an
        // upload row for a font they already have, which is annoying
        // but not breaking. 409 collision on the upload handler then
        // treats it as success.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [success, api])
  // Detect which referenced families are "missing" — i.e. NOT a
  // well-known system font and NOT already uploaded by the user.
  //
  // We intentionally do NOT use `document.fonts.check()` here.
  // document.fonts.check returns true for any locally-installed font
  // AND for any @font-face Pixi has registered, even when the
  // referenced URL is broken or the font hasn't actually loaded.
  // That made the original detection silently filter out genuinely
  // missing PPTX fonts (the case the user reported: "advisory fired
  // but no upload UI"). A hard-coded list of fonts that ship on every
  // platform we support is more conservative — we'd rather show an
  // upload row the user can skip than hide a real missing font.
  //
  // Whether a font is "really" available is determined post-upload by
  // FolderFontLoader, not by us.
  const referencedFamilies = useMemo(
    () => normaliseFamilies(success?.referencedFontFamilies ?? []),
    [success],
  )

  const missingFonts = useMemo(() => {
    if (success === null) return [] as string[]
    return referencedFamilies.filter(
      (fam) =>
        !isCommonSystemFont(fam) &&
        !resolvedFamilies.has(fam) &&
        // Don't prompt for fonts the target folder already has.
        !preExistingFolderFamilies.has(fam.toLowerCase().trim()),
    )
  }, [success, referencedFamilies, resolvedFamilies, preExistingFolderFamilies])

  const fontFallbackAdvisory =
    success !== null &&
    success.objectsCreated > 0 &&
    (success.embeddedFontCount ?? 0) === 0 &&
    missingFonts.length === 0
  const hasAnyNotice = importIssues.length > 0 || fontFallbackAdvisory || missingFonts.length > 0
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
      importedFolderIdRef.current = folderId
      setSuccess(result)
    } catch (err) {
      // Server returns a structured body on 4xx; pick out the most useful field.
      const body = (err as { body?: { error?: string } }).body
      setError(body?.error ?? (err instanceof Error ? err.message : 'Import failed'))
      setBusy(false)
      setPhase('idle')
    }
  }

  // A known target folder means the drop (or file pick) WAS the confirmation:
  // start at once. The ref, not state, guards it — refs survive StrictMode's
  // dev double-mount, so the upload cannot be started twice.
  const autoStarted = useRef(false)
  useEffect(() => {
    if (targetFolder === undefined || autoStarted.current) return
    autoStarted.current = true
    void handleConfirm()
    // Runs once per dialog; handleConfirm reads the initial selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * Upload a TTF/OTF file for one of the PPTX-referenced families that
   * the browser couldn't resolve. Goes through the existing folder-
   * font POST endpoint with a `?fontFamily=<override>` so the row
   * binds to the family name the slide content actually references.
   * On success the family is marked "resolved" so the missing list
   * shrinks; the folder-font cache is invalidated so FolderFontLoader
   * re-installs once the user lands on the deck.
   */
  const handleMissingFontUpload = useCallback(
    async (family: string, file: File) => {
      const folderId = importedFolderIdRef.current
      if (folderId === null) return
      setFamilyUploads((prev) => {
        const next = new Map(prev)
        next.set(family, { busy: true, error: null })
        return next
      })
      try {
        await api.uploadFolderFont(folderId, file, { familyOverride: family })
        // Drop the shared folder-fonts cache for this folder so the
        // deck's FolderFontsProvider re-fetches when it mounts after
        // navigation. Without this, the dropdown in the typography
        // inspector + the FolderFontLoader (which actually installs
        // FontFace into document.fonts) silently keep using the stale
        // pre-upload list and the user sees "I uploaded the font but
        // it isn't in the inspector".
        invalidateFolderFontsCache(folderId)
        setResolvedFamilies((prev) => {
          const next = new Set(prev)
          next.add(family)
          return next
        })
        setFamilyUploads((prev) => {
          const next = new Map(prev)
          next.delete(family)
          return next
        })
      } catch (err: unknown) {
        const body = (err as { body?: { error?: string }; status?: number }).body
        const status = (err as { status?: number }).status
        // 409 = postscript-name collision (font already in this folder).
        // Treat that as success — the user's intent is satisfied either
        // way, and the font registry already has the bytes.
        if (status === 409) {
          // Same cache-invalidation reasoning as the success path:
          // the bytes ARE in this folder's font set; the deck just
          // needs to refetch to see them.
          invalidateFolderFontsCache(folderId)
          setResolvedFamilies((prev) => {
            const next = new Set(prev)
            next.add(family)
            return next
          })
          setFamilyUploads((prev) => {
            const next = new Map(prev)
            next.delete(family)
            return next
          })
          return
        }
        const msg = body?.error ?? (err instanceof Error ? err.message : 'Upload failed')
        setFamilyUploads((prev) => {
          const next = new Map(prev)
          next.set(family, { busy: false, error: msg })
          return next
        })
      }
    },
    [api],
  )

  const sizeLabel = formatBytes(file.size)

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Import PowerPoint deck"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/60 backdrop-blur-xs"
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
          {targetFolder !== undefined ? (
            <>
              Importing into <span className="text-foreground">{targetFolder.name}</span>.
            </>
          ) : (
            'Pick a folder for the imported deck or create a new one.'
          )}
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

        {/* Missing-fonts panel — for each PPTX-referenced family that
            the browser couldn't resolve (system, document.fonts, or
            folder registry), offer a file picker that uploads the
            user's .ttf / .otf and binds it to the exact family name
            the slide content references (via familyOverride). */}
        {success !== null && missingFonts.length > 0 && (
          <div className="mb-4 space-y-2">
            <h3 className="flex items-center gap-1.5 text-xs font-medium text-foreground">
              <UploadIcon className="h-3.5 w-3.5 text-amber-500" aria-hidden="true" />
              Missing fonts — upload to keep the original look
            </h3>
            <p className="text-xs text-muted-foreground">
              The deck references {missingFonts.length} font
              {missingFonts.length === 1 ? '' : 's'} that aren’t installed in your browser or this
              folder. Upload a `.ttf` / `.otf` for each and they’ll bind to the right family name
              automatically. You can skip and keep the category fallback.
            </p>
            <ul className="space-y-1.5">
              {missingFonts.map((family) => (
                <MissingFontRow
                  key={family}
                  family={family}
                  state={familyUploads.get(family)}
                  onPick={(file) => void handleMissingFontUpload(family, file)}
                />
              ))}
            </ul>
            {resolvedFamilies.size > 0 && (
              <p className="text-xs text-emerald-500">
                {resolvedFamilies.size} font{resolvedFamilies.size === 1 ? '' : 's'} uploaded.
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

        {/* The folder choice — only when there is one to make. */}
        {targetFolder === undefined && (
          <>
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
          </>
        )}

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
          {success !== null && hasAnyNotice ? (
            // Successful import that needs explicit user dismissal (any
            // mix of compat warnings, font-fallback advisory, or missing
            // font rows the user might still want to upload). The auto-
            // advance is intentionally suppressed in this branch; the
            // user clicks through when they're done acknowledging /
            // uploading. The label flips to "Skip & open deck" when
            // there are still unresolved fonts to remind the user they
            // can upload later — the import itself is complete.
            <Button size="sm" onClick={() => onSuccess(success)} className="btn-brand gap-1.5">
              <FileUp className="h-3.5 w-3.5" aria-hidden="true" />
              {missingFonts.length > 0 ? 'Skip & open deck' : 'Open deck'}
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
                {busy ? 'Importing…' : targetFolder !== undefined ? 'Retry' : 'Import'}
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

/**
 * Trim + dedupe a list of font family names and drop the obvious
 * "system or generic" entries that the browser always provides. We
 * still pass typical web-safe names like Arial through — the
 * referenced-fonts list is meant to flag NAMES THE DECK USED, and
 * even Arial may genuinely be missing in some constrained sandbox
 * environments. The `document.fonts.check` probe filters those out
 * for real, so this just cleans up obvious noise.
 */
/**
 * Names of fonts that ship with every major desktop OS (Windows,
 * macOS, Linux distros via fontconfig). When a PPTX references one
 * of these we don't ask the user to upload — the browser will pick
 * it up natively. Anything else gets surfaced as "missing" so the
 * user can decide to upload or skip. Lower-cased and trimmed before
 * comparison so the lookup matches "ARIAL" / " arial " / "Arial".
 *
 * This is intentionally conservative — better to flag a font that
 * happens to be installed locally (one extra upload row the user
 * skips) than to silently miss a genuinely-absent face.
 */
const COMMON_SYSTEM_FONTS: ReadonlySet<string> = new Set(
  [
    // Cross-platform web-safe
    'arial',
    'arial black',
    'arial narrow',
    'helvetica',
    'helvetica neue',
    'times',
    'times new roman',
    'courier',
    'courier new',
    'georgia',
    'verdana',
    'tahoma',
    'trebuchet ms',
    'lucida sans',
    'lucida grande',
    'lucida console',
    'palatino',
    'palatino linotype',
    'impact',
    // Microsoft Office (shipped on Windows + bundled with macOS Office)
    'calibri',
    'cambria',
    'candara',
    'consolas',
    'constantia',
    'corbel',
    'segoe ui',
    // macOS / iOS native
    'sf pro',
    'sf pro display',
    'sf pro text',
    'sf mono',
    'menlo',
    'monaco',
    // CSS generics
    'sans-serif',
    'serif',
    'monospace',
    'cursive',
    'fantasy',
    'system-ui',
  ].map((s) => s.toLowerCase()),
)

function isCommonSystemFont(family: string): boolean {
  return COMMON_SYSTEM_FONTS.has(family.trim().toLowerCase())
}

function normaliseFamilies(raw: ReadonlyArray<string>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const f of raw) {
    const t = f.trim()
    if (t === '') continue
    if (t.startsWith('+')) continue // OOXML theme placeholder, never a real family.
    if (seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

interface MissingFontRowProps {
  family: string
  state: { busy: boolean; error: string | null } | undefined
  onPick: (file: File) => void
}

/**
 * One row of the missing-fonts panel. Renders the family name + a
 * "Upload" button that opens a file picker. While the upload is in
 * flight the button shows a spinner; on error we surface the message
 * inline so the user can retry without losing context.
 */
function MissingFontRow({ family, state, onPick }: MissingFontRowProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const busy = state?.busy === true
  const error = state?.error ?? null
  return (
    <li className="flex flex-col gap-1 rounded-md border border-border bg-surface-1 px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-foreground" title={family}>
          {family}
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          className="h-7 gap-1 text-xs"
        >
          {busy ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              Uploading…
            </>
          ) : (
            <>
              <UploadIcon className="h-3 w-3" aria-hidden="true" />
              Upload
            </>
          )}
        </Button>
        <input
          ref={inputRef}
          type="file"
          accept=".ttf,.otf,.woff2,font/ttf,font/otf,font/woff2"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) onPick(file)
            // Reset so re-picking the same file fires onChange.
            e.currentTarget.value = ''
          }}
        />
      </div>
      {error !== null && (
        <p role="alert" className="text-xs text-red-500">
          {error}
        </p>
      )}
    </li>
  )
}
