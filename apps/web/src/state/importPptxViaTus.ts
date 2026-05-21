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
 * returns the standard `ImportPptxResult` JSON in the final PATCH's
 * response body — same shape the synchronous POST returned.
 */

import * as tus from 'tus-js-client'
import type { ImportPptxResult } from '../api/client.js'

const API_URL = (import.meta.env['VITE_API_URL'] as string | undefined) ?? ''
const UPLOAD_ENDPOINT = `${API_URL}/api/uploads`
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

export interface ImportPptxProgress {
  /** 0..1 fraction of bytes uploaded. */
  fraction: number
  /** Bytes sent so far. */
  bytesSent: number
  /** Total bytes (== file size). */
  bytesTotal: number
}

export interface ImportPptxOptions {
  file: File
  folderId: string
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
export function importPptxViaTus(opts: ImportPptxOptions): Promise<ImportPptxResult> {
  const { file, folderId, onProgress, signal } = opts
  return new Promise<ImportPptxResult>((resolve, reject) => {
    let resultFromBody: ImportPptxResult | null = null

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
        folderId,
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
          const parsed = JSON.parse(bodyText) as Partial<ImportPptxResult>
          if (typeof parsed.deckId === 'string' && parsed.deckId.length > 0) {
            resultFromBody = parsed as ImportPptxResult
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
