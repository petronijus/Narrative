/**
 * pdf-export-queue.ts
 *
 * The BullMQ queue of deck PDF exports (docs/plans/performance.md, R1: no
 * HTTP request waits for a PDF). The server adds a job when someone asks for
 * a PDF and answers at once with its id; its own worker runs the job —
 * rendering the slides through the render worker's queue (`render`), in jobs
 * of at most 20, then the pages into one file stored in the bucket — and the
 * editor or the agent polls the job for its progress and its link.
 *
 * On the media Redis like `render`, so a job survives a server restart: a
 * job left running by a process that stopped is picked up again by the next
 * one (BullMQ's stalled-job check) and starts over.
 */

export const PDF_EXPORT_QUEUE = 'pdf-export'

/** A slide of the deck: by id, or by 0-based position. */
export type PdfExportSlideRef = { id: string } | { index: number }

export interface PdfExportJobData {
  /** Who asked: the only one who may read the job, and whose access each render checks. */
  userId: string
  deckId: string
  slides: PdfExportSlideRef[] | 'all'
  includeSkipped: boolean
  /** How the finished file is handed over: a presigned link, or the bytes inline (≤ 8 MiB). */
  delivery: 'url' | 'base64'
}

/** What the job reports while it runs (BullMQ progress). */
export interface PdfExportProgress {
  /** Pages rendered so far. */
  done: number
  /** Pages the file will have. */
  total: number
}

/** A finished job: where its file is stored, and what it holds. */
export interface PdfExportJobResult {
  key: string
  /** The download name (the deck's title). */
  filename: string
  pages: number
  leftOut: number
  sizeBytes: number
  failedLoads: number
  failedFonts: string[]
}

/**
 * A failed job's reason as the queue stores it (a string): the service
 * error's code, HTTP status and message, so whoever polls the job hears what
 * the request would have answered.
 */
export interface PdfExportFailure {
  code: string
  status: number
  message: string
}

const FAILURE_PREFIX = 'pdf-export-failure:'

export function pdfExportFailureMessage(failure: PdfExportFailure): string {
  return FAILURE_PREFIX + JSON.stringify(failure)
}

/** The failure a job's reason carries; a reason this module did not write is an internal error. */
export function parsePdfExportFailure(reason: string | undefined): PdfExportFailure {
  if (reason?.startsWith(FAILURE_PREFIX) === true) {
    try {
      const f = JSON.parse(reason.slice(FAILURE_PREFIX.length)) as Partial<PdfExportFailure>
      if (
        typeof f.code === 'string' &&
        typeof f.status === 'number' &&
        typeof f.message === 'string'
      )
        return { code: f.code, status: f.status, message: f.message }
    } catch {
      // Fall through.
    }
  }
  return { code: 'failed', status: 503, message: 'The PDF export failed' }
}
