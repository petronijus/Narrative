/**
 * ui/usePptxDropIntoDeck.ts
 *
 * Drop a `.pptx` onto the slides panel and its slides land where the
 * indicator was pointing — between two thumbnails, not at the end of the
 * deck.
 *
 * Why this is separate from the panel's own drag: reordering slides is a
 * POINTER gesture (pointerdown/move/up, because it re-indents horizontally
 * at the same time), while a file coming from the OS arrives as HTML5 drag
 * events. The two never meet — `dragover` doesn't fire for the pointer
 * gesture and `pointermove` doesn't fire for the file drag — so they are
 * two independent state machines that happen to draw the same indicator.
 *
 * Why this is separate from `usePptxImport`: that hook is the page-level
 * "drop anywhere → make a new deck" flow, with a folder picker dialog and a
 * full-window overlay. Here the deck is already known, the target is an
 * index inside it, and a modal would cover the very thumbnails the user is
 * aiming between. So the progress lives in the list as a placeholder row.
 *
 * Ordering: uploads run one at a time, in drop order. Two files dropped at
 * index 3 must end up as [first, second] there, and the second one's index
 * has to move by however many slides the first turned out to contain —
 * a count nobody knows until the server answers.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { nanoid } from 'nanoid'
import { importPptxViaTus } from '../state/importPptxViaTus.js'
import { dragHasFiles, isLegacyPptFile, isPptxFile, pptxRejectionReason } from '../lib/pptxFiles.js'

/** One dropped file's trip from the disk into the deck. */
export interface PptxImportJob {
  id: string
  filename: string
  /** Index its first slide is headed for, in the deck as it stands now. */
  insertAt: number
  status: 'uploading' | 'importing' | 'error'
  /** 0..1 while uploading; meaningless once the server takes over. */
  progress: number
  /** Set when status is 'error'. Shown in the placeholder row. */
  error?: string
}

export interface UsePptxDropIntoDeckOptions {
  deckId: string | undefined
  /** The list element the rows live in — used to turn a pointer Y into an
   *  insertion index. */
  listRef: React.RefObject<HTMLElement | null>
  /** Current slide count; the index when the pointer is past the last row. */
  slideCount: number
  /** No drop target at all for viewers. */
  disabled?: boolean
  /** Fired once slides have landed, with the index the first one took. The
   *  panel uses it to select what was just imported. */
  onImported?: (insertedAt: number, slideCount: number) => void
}

export interface UsePptxDropIntoDeck {
  /** Spread onto the list element. */
  dropHandlers: {
    onDragEnter: (e: React.DragEvent) => void
    onDragOver: (e: React.DragEvent) => void
    onDragLeave: (e: React.DragEvent) => void
    onDrop: (e: React.DragEvent) => void
  }
  /** Index the drop indicator sits at, or null when nothing is over the
   *  panel. `slideCount` means "below the last slide". */
  indicatorAt: number | null
  /** In-flight and failed imports, oldest first. */
  jobs: PptxImportJob[]
  /** Clear a finished-in-error job the user has read. */
  dismiss: (id: string) => void
}

export function usePptxDropIntoDeck({
  deckId,
  listRef,
  slideCount,
  disabled = false,
  onImported,
}: UsePptxDropIntoDeckOptions): UsePptxDropIntoDeck {
  const [indicatorAt, setIndicatorAt] = useState<number | null>(null)
  const [jobs, setJobs] = useState<PptxImportJob[]>([])
  /**
   * dragenter/dragleave fire for every element the pointer crosses, so a
   * plain boolean flickers off the moment the cursor moves between two
   * rows. Counting enters against leaves is what keeps the indicator steady.
   */
  const dragDepth = useRef(0)
  /** Serialises the queue: each drop chains onto whatever is still running. */
  const queueRef = useRef<Promise<void>>(Promise.resolve())

  // Read from event handlers and from a promise that resolves long after the
  // render that started it, so both are mirrored into refs — and mirrored in
  // an effect rather than during render, which React's rules forbid.
  const slideCountRef = useRef(slideCount)
  const onImportedRef = useRef(onImported)
  useEffect(() => {
    slideCountRef.current = slideCount
    onImportedRef.current = onImported
  }, [slideCount, onImported])

  /**
   * Which gap in the list the pointer is nearest. Rows are measured live
   * rather than derived from a fixed row height: the panel's rows collapse
   * to zero height when their outline parent is collapsed, and a collapsed
   * run must not be able to swallow the drop position.
   */
  const indexFromPointer = useCallback(
    (clientY: number): number => {
      const list = listRef.current
      if (list === null) return slideCountRef.current
      // `[data-slide-index]` and not `children`: the list also holds the
      // placeholder rows of imports still running, and counting those would
      // shift every index by however many files are in flight.
      const rows = Array.from(list.querySelectorAll<HTMLElement>('[data-slide-index]'))
      for (let i = 0; i < rows.length; i++) {
        const rect = rows[i]!.getBoundingClientRect()
        // Zero-height rows (collapsed subtree) can't win: their midpoint is
        // their top edge, so the comparison below skips past them.
        if (rect.height === 0) continue
        if (clientY < rect.top + rect.height / 2) return i
      }
      return rows.length
    },
    [listRef],
  )

  const runJob = useCallback(
    async (job: PptxImportJob, file: File, targetDeckId: string): Promise<void> => {
      try {
        const result = await importPptxViaTus({
          file,
          deckId: targetDeckId,
          insertAt: job.insertAt,
          onProgress: (p) => {
            setJobs((prev) =>
              prev.map((j) =>
                j.id === job.id
                  ? { ...j, progress: p.fraction, status: p.fraction >= 1 ? 'importing' : j.status }
                  : j,
              ),
            )
          },
        })
        // Everything still queued was positioned against a deck that did not
        // yet contain these slides, so anything at or after this insertion
        // point moves down by however many arrived.
        setJobs((prev) =>
          prev
            .filter((j) => j.id !== job.id)
            .map((j) =>
              j.insertAt >= result.insertedAt
                ? { ...j, insertAt: j.insertAt + result.appendedSlides }
                : j,
            ),
        )
        onImportedRef.current?.(result.insertedAt, result.appendedSlides)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Import failed'
        setJobs((prev) =>
          prev.map((j) => (j.id === job.id ? { ...j, status: 'error', error: message } : j)),
        )
      }
    },
    [],
  )

  const enqueue = useCallback(
    (files: File[], at: number): void => {
      if (deckId === undefined || deckId === '') return
      for (const file of files) {
        const reason = pptxRejectionReason(file)
        const job: PptxImportJob = reason
          ? {
              id: nanoid(8),
              filename: file.name,
              insertAt: at,
              status: 'error',
              progress: 0,
              error: reason,
            }
          : { id: nanoid(8), filename: file.name, insertAt: at, status: 'uploading', progress: 0 }
        setJobs((prev) => [...prev, job])
        if (reason !== null) continue
        // Chain, don't race: the queue is what keeps two files dropped
        // together in the order they were dropped.
        queueRef.current = queueRef.current.then(() => runJob(job, file, deckId))
      }
    },
    [deckId, runJob],
  )

  const dropHandlers = {
    onDragEnter: (e: React.DragEvent) => {
      if (disabled || !dragHasFiles(e.dataTransfer)) return
      dragDepth.current++
      setIndicatorAt(indexFromPointer(e.clientY))
    },
    onDragOver: (e: React.DragEvent) => {
      if (disabled || !dragHasFiles(e.dataTransfer)) return
      // Without preventDefault the browser navigates to the file instead of
      // firing onDrop.
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      setIndicatorAt(indexFromPointer(e.clientY))
    },
    onDragLeave: (e: React.DragEvent) => {
      if (disabled || !dragHasFiles(e.dataTransfer)) return
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setIndicatorAt(null)
    },
    onDrop: (e: React.DragEvent) => {
      if (disabled || !dragHasFiles(e.dataTransfer)) return
      e.preventDefault()
      // Stop the page-level pptx drop (FolderDecks / FoldersHome style) from
      // also claiming this file and making a second, separate deck out of it.
      e.stopPropagation()
      dragDepth.current = 0
      const at = indexFromPointer(e.clientY)
      setIndicatorAt(null)
      // Only presentations are this panel's business. A drag of ten holiday
      // photos is not a failed import, so it is ignored rather than refused
      // — the canvas has its own drop zone for those. A legacy `.ppt` IS
      // this panel's business: it is what the user meant, and it earns a
      // row saying why it can't be read.
      const files = Array.from(e.dataTransfer.files)
      const presentations = files.filter((f) => isPptxFile(f) || isLegacyPptFile(f))
      if (presentations.length === 0) return
      enqueue(presentations, at)
    },
  }

  const dismiss = useCallback((id: string) => {
    setJobs((prev) => prev.filter((j) => j.id !== id))
  }, [])

  return { dropHandlers, indicatorAt, jobs, dismiss }
}
