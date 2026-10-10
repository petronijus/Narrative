/**
 * state/importPptxViaTus.ts
 *
 * Client-side pptx import via tus. Mirrors the media-upload tus call
 * (`useMediaUpload`) but tailored for the import flow:
 *
 *   - Single-shot promise: resolve with the deck info, reject on
 *     failure. No queue, no per-deck context — the dialog renders it
 *     once and unmounts after success.
 *   - Progress callback for the percentage bar.
 *   - Cookies (`narrative_session`) ride along via `withCredentials`,
 *     same as the media uploader.
 *
 * The server-side `onUploadFinish` (in `apps/server/src/media/tus.ts`)
 * branches on the pptx MIME, reads the freshly-uploaded blob back from
 * MinIO, runs the deck-import pipeline, deletes the temp blob, and
 * returns the standard result JSON in the final PATCH's response body —
 * the same shape the synchronous POST returned.
 *
 * Two targets, one transport:
 *   - `{ folderId }` creates a NEW deck in that folder (FoldersHome /
 *     FolderDecks drop, and the Import button).
 *   - `{ deckId, insertAt? }` inserts the slides into an OPEN deck at that
 *     index (the slides panel's drop), or appends when the index is
 *     omitted.
 *
 * Both go through tus rather than a plain POST because only tus reports
 * upload progress and survives a dropped connection — a 200 MB deck over
 * hotel wifi has to be resumable, and the panel wants a percentage to put
 * in its placeholder row.
 */

import { API_BASE } from '../lib/endpoints.js'
import * as tus from 'tus-js-client'
import type { AppendPptxResult, ImportPptxResult } from '../api/client.js'

const UPLOAD_ENDPOINT = `${API_BASE}/api/uploads`
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

export interface ImportPptxProgress {
  /** 0..1 fraction of bytes uploaded. */
  fraction: number
  /** Bytes sent so far. */
  bytesSent: number
  /** Total bytes (== file size). */
  bytesTotal: number
}

/** Where the slides are to land. Exactly one of the two shapes. */
export type PptxTarget =
  | { folderId: string; deckId?: never; insertAt?: never }
  | {
      deckId: string
      folderId?: never
      /** Index the first imported slide takes, in the deck's pre-insert
       *  array. Omitted → append at the end. The server clamps: by the time
       *  a chunked upload finishes, the deck may have fewer slides than when
       *  the drop happened. */
      insertAt?: number
    }

export interface ImportPptxOptions {
  file: File
  /** Called repeatedly during upload — UI uses it to render a % bar. */
  onProgress?: (p: ImportPptxProgress) => void
  /** Signal returned by an outer AbortController. Aborting cancels the
   *  in-flight tus upload (no resume possible after abort). */
  signal?: AbortSignal
}

/**
 * Run a chunked, resumable pptx upload. Resolves with the deck info
 * (deckId, slide count, etc.) once the server has finished parsing and
 * persisted the deck. Rejects with an `Error` whose message comes from
 * the tus error body for HTTP-level failures (415, 413, 403, etc.) or
 * from the final response JSON for parse failures (400).
 */
export function importPptxViaTus(
  opts: ImportPptxOptions & { folderId: string },
): Promise<ImportPptxResult>
export function importPptxViaTus(
  opts: ImportPptxOptions & { deckId: string; insertAt?: number },
): Promise<AppendPptxResult>
export function importPptxViaTus(
  opts: ImportPptxOptions & PptxTarget,
): Promise<ImportPptxResult | AppendPptxResult> {
  const { file, folderId, deckId, insertAt, onProgress, signal } = opts
  return new Promise<ImportPptxResult | AppendPptxResult>((resolve, reject) => {
    let resultFromBody: ImportPptxResult | AppendPptxResult | null = null

    const upload = new tus.Upload(file, {
      endpoint: UPLOAD_ENDPOINT,
      retryDelays: [0, 1000, 3000, 5000],
      chunkSize: 5 * 1024 * 1024,
      // Cross-origin in dev → cookies sent only with this flag. Same
      // shape as useMediaUpload uses.
      ...({ withCredentials: true } as Record<string, unknown>),
      metadata: {
        filename: file.name,
        filetype: file.type || PPTX_MIME,
        mimeType: file.type || PPTX_MIME,
        'content-type': file.type || PPTX_MIME,
        // The binding the server authorises against and dispatches on:
        // folderId → create a deck, deckId → insert into one. Metadata, not
        // a custom header — browser CORS strips `X-Narrative-*`.
        ...(folderId !== undefined ? { folderId } : {}),
        ...(deckId !== undefined ? { deckId } : {}),
        ...(insertAt !== undefined ? { insertAt: String(insertAt) } : {}),
      },
      onProgress(bytesSent: number, bytesTotal: number) {
        if (!onProgress) return
        const fraction = bytesTotal > 0 ? bytesSent / bytesTotal : 0
        onProgress({ fraction, bytesSent, bytesTotal })
      },
      onAfterResponse(_req: tus.HttpRequest, res: tus.HttpResponse) {
        // The final PATCH body carries the ImportPptxResult JSON. Capture
        // it here so onSuccess can resolve with the right value — by the
        // time onSuccess fires, the response isn't available any more.
        const bodyText = (res as unknown as { getBody?: () => string }).getBody?.()
        if (!bodyText) return
        try {
          const parsed = JSON.parse(bodyText) as Partial<ImportPptxResult | AppendPptxResult>
          if (typeof parsed.deckId === 'string' && parsed.deckId.length > 0) {
            resultFromBody = parsed as ImportPptxResult | AppendPptxResult
          }
        } catch {
          // Non-JSON body → ignore; onError will fire if the upload itself failed.
        }
      },
      onSuccess() {
        if (resultFromBody === null) {
          reject(new Error('pptx import completed but server did not return a deck id'))
          return
        }
        resolve(resultFromBody)
      },
      onError(err: Error | tus.DetailedError) {
        // tus.DetailedError carries originalRequest + originalResponse. The
        // server's status_code + body from onUploadCreate / onUploadFinish
        // land on originalResponse — use the body as the error message
        // whenever it's available so the user sees "Folder not found" /
        // "Forbidden" / etc. instead of a generic "tus error".
        const detailed = err as tus.DetailedError
        const respBody =
          detailed.originalResponse !== undefined && detailed.originalResponse !== null
            ? detailed.originalResponse.getBody()
            : ''
        const message = typeof respBody === 'string' && respBody.length > 0 ? respBody : err.message
        reject(new Error(message))
      },
    })

    if (signal !== undefined) {
      const onAbort = (): void => {
        void upload.abort()
        reject(new Error('Upload cancelled'))
      }
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    upload.start()
  })
}
