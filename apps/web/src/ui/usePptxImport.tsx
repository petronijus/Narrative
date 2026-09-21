/**
 * ui/usePptxImport.tsx
 *
 * Drop a `.pptx` anywhere on a page and get a deck.
 *
 * FoldersHome grew this first; FolderDecks needed the same thing, and a
 * second copy of the drag-counter bookkeeping is exactly the sort of pair
 * that drifts apart. So the whole behaviour lives here once: the hidden file
 * input behind an Import button, the page-level drag handlers, the overlay
 * that appears while a file is over the window, and the folder-picker dialog
 * that runs the upload.
 *
 * The caller decides only what is genuinely page-specific — which folders the
 * file may land in, and where to go afterwards.
 *
 * Usage:
 *   const pptx = usePptxImport({ folders, onCreateFolder, onImported })
 *   return (
 *     <div {...pptx.dropHandlers}>
 *       {pptx.fileInput}
 *       {pptx.overlay}
 *       <Button onClick={pptx.openFilePicker}>Import PPT</Button>
 *       …
 *       {pptx.dialog}
 *     </div>
 *   )
 */

import { useCallback, useRef, useState, type ReactNode } from 'react'
import { FileUp } from 'lucide-react'
import { ImportPptxDialog } from './ImportPptxDialog.js'
import { importPptxViaTus } from '../state/importPptxViaTus.js'
import type { FolderSummary, ImportPptxResult } from '../api/client.js'

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

/**
 * The OOXML presentation MIME is the canonical answer, but some systems —
 * Safari in particular — hand over an empty string or `application/zip` for
 * the same file, so the extension is the fallback rather than the other way
 * round.
 */
export function isPptxFile(file: File): boolean {
  if (file.name.toLowerCase().endsWith('.pptx')) return true
  return file.type === PPTX_MIME
}

export interface UsePptxImportOptions {
  /** Folders the file may be imported into. The first is preselected. */
  folders: FolderSummary[]
  onCreateFolder: (name: string) => Promise<FolderSummary>
  /** Called once the import has finished and its summary has been read. */
  onImported: (result: ImportPptxResult) => void
  /** Surface a rejected file to the page's own error UI. */
  onError?: (message: string) => void
  /** Second line of the drop overlay. */
  hint?: string
}

export interface UsePptxImport {
  /** Spread onto the page's root element. */
  dropHandlers: {
    onDragEnter: (e: React.DragEvent) => void
    onDragLeave: () => void
    onDragOver: (e: React.DragEvent) => void
    onDrop: (e: React.DragEvent) => void
  }
  /** Hidden `<input type="file">`; render it once inside the page. */
  fileInput: ReactNode
  /** The full-window prompt, or null when nothing is being dragged. */
  overlay: ReactNode
  /** The folder picker / progress dialog, or null when idle. */
  dialog: ReactNode
  /** Opens the system file picker — wire to an Import button. */
  openFilePicker: () => void
}

export function usePptxImport({
  folders,
  onCreateFolder,
  onImported,
  onError,
  hint = 'It lands in this folder.',
}: UsePptxImportOptions): UsePptxImport {
  const [pendingPptx, setPendingPptx] = useState<File | null>(null)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  /**
   * dragenter/dragleave fire for every element the pointer crosses, so a
   * plain boolean flickers off the moment the cursor moves between two deck
   * cards. Counting enters against leaves is what keeps the overlay steady.
   */
  const dragDepth = useRef(0)

  const accept = useCallback(
    (file: File) => {
      if (!isPptxFile(file)) {
        onError?.('Only .pptx files can be imported.')
        return
      }
      setPendingPptx(file)
    },
    [onError],
  )

  const dropHandlers = {
    onDragEnter: (e: React.DragEvent) => {
      if (!Array.from(e.dataTransfer.types).includes('Files')) return
      dragDepth.current++
      setDragging(true)
    },
    onDragLeave: () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setDragging(false)
    },
    onDragOver: (e: React.DragEvent) => {
      if (!Array.from(e.dataTransfer.types).includes('Files')) return
      // Without preventDefault the browser navigates to the file instead of
      // firing onDrop.
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      dragDepth.current = 0
      setDragging(false)
      const file = e.dataTransfer.files[0]
      if (file !== undefined) accept(file)
    },
  }

  const fileInput = (
    <input
      ref={inputRef}
      type="file"
      accept={`.pptx,${PPTX_MIME}`}
      className="hidden"
      onChange={(e) => {
        const file = e.target.files?.[0]
        if (file !== undefined) accept(file)
        // Clear so choosing the same file twice still fires onChange.
        e.target.value = ''
      }}
    />
  )

  const overlay = dragging ? (
    <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-background/40 backdrop-blur-xs">
      <div className="rounded-xl border-2 border-dashed border-foreground/40 bg-surface-1/80 px-10 py-8 text-center shadow-xl">
        <FileUp className="mx-auto mb-3 h-8 w-8 text-foreground" aria-hidden="true" />
        <p className="text-sm font-medium text-foreground">Drop a .pptx to import</p>
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      </div>
    </div>
  ) : null

  const dialog =
    pendingPptx === null ? null : (
      <ImportPptxDialog
        file={pendingPptx}
        folders={folders}
        onClose={() => setPendingPptx(null)}
        onCreateFolder={onCreateFolder}
        onImport={(folderId, file, opts) =>
          // Resumable chunked tus upload; the server's onUploadFinish hook
          // runs the deck-import pipeline against the uploaded blob.
          importPptxViaTus({
            file,
            folderId,
            ...(opts.onProgress !== undefined
              ? { onProgress: (p) => opts.onProgress!(p.fraction) }
              : {}),
          })
        }
        onSuccess={(result) => {
          setPendingPptx(null)
          onImported(result)
        }}
      />
    )

  return {
    dropHandlers,
    fileInput,
    overlay,
    dialog,
    openFilePicker: () => inputRef.current?.click(),
  }
}
