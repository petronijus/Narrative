/**
 * state/useMediaUpload.ts
 *
 * M11: Resumable image upload via tus protocol.
 * M12: Extended for video uploads with transcode polling.
 *
 * Provides:
 *   - MediaUploadContext (React context) — mounted in DeckShell via MediaUploadProvider
 *   - useMediaUpload() hook — access uploads state + startUpload / cancelUpload / retryUpload / dismissUpload
 *
 * Upload lifecycle (image):
 *   startUpload(file) →
 *     client-side MIME validation (image/* | video/*) →
 *     optional dimension probe via createImageBitmap (images only, best-effort) →
 *     tus.Upload.start() →
 *     onProgress: status='uploading', progress 0..1 →
 *     onSuccess (image): status='done', assetId, width, height → trigger onDone callback
 *
 * Upload lifecycle (video, M12):
 *     onSuccess (video): server returns transcodeStatus='pending' via X-Narrative-Transcode-Status →
 *       status='finalizing' (transcode polling starts) →
 *       poll GET /api/media/:assetId/video-info every 2s →
 *       transcodeStatus='done': status='done' → trigger onDone callback
 *       transcodeStatus='failed': status='error', error from transcodeError
 *
 * Cancel: tus.Upload.abort() → status='cancelled'
 *   Note: server-side transcode job cannot be cancelled in M12.
 * Retry: re-creates tus.Upload from stored File reference
 * Dismiss: removes entry from list (only if done/error/cancelled)
 *
 * Auth: Bearer token from useAuth().token in tus request headers.
 * Endpoint: VITE_API_URL/api/uploads (tus protocol)
 * Metadata: deckId, filename, mimetype, width?, height? (tus-js-client encodes as base64)
 *
 * Max file size: 500 MB for video (enforced server-side; drop zone restricts client-side).
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import * as tus from 'tus-js-client'
import { nanoid } from 'nanoid'
import { useAuth } from './AuthContext.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UploadEntry {
  id: string
  filename: string
  sizeBytes: number
  mimeType: string
  status: 'queued' | 'uploading' | 'finalizing' | 'done' | 'error' | 'cancelled'
  progress: number // 0..1
  error?: string
  assetId?: string // set on status='done' (or during finalizing for video)
  width?: number
  height?: number
}

export interface MediaUploadContextValue {
  uploads: ReadonlyArray<UploadEntry>
  /**
   * Starts a resumable upload for a File. Returns the local upload id.
   * image/* and video/* MIME types accepted — others resolve immediately with status='error'.
   * Video files max 500 MB (client-side check; server enforces 413).
   * onDone callback fires once status transitions to 'done'.
   */
  startUpload(file: File, opts?: { onDone?: (entry: UploadEntry) => void }): string
  cancelUpload(id: string): void
  retryUpload(id: string): void
  /** Remove entry from list — only works if status is done/error/cancelled. */
  dismissUpload(id: string): void
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export const MediaUploadContext = createContext<MediaUploadContextValue | null>(null)

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const API_URL = (import.meta.env['VITE_API_URL'] as string | undefined) ?? ''
const UPLOAD_ENDPOINT = `${API_URL}/api/uploads`
const VIDEO_MAX_BYTES = 500 * 1024 * 1024 // 500 MB
const TRANSCODE_POLL_INTERVAL_MS = 2_000

interface MediaUploadProviderProps {
  deckId: string
  children: ReactNode
}

export function MediaUploadProvider({ deckId, children }: MediaUploadProviderProps) {
  const { token } = useAuth()

  const [uploads, setUploads] = useState<UploadEntry[]>([])
  // tus.Upload instances keyed by local upload id (for abort/retry)
  const tusUploadsRef = useRef<Map<string, tus.Upload>>(new Map())
  // Original File references keyed by local upload id (for retry after cancel)
  const filesRef = useRef<Map<string, File>>(new Map())
  // onDone callbacks keyed by local upload id
  const onDoneCallbacksRef = useRef<Map<string, (entry: UploadEntry) => void>>(new Map())
  // Transcode poll interval IDs keyed by local upload id
  const transPollTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  function upsertEntry(id: string, patch: Partial<UploadEntry>) {
    setUploads((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)))
  }

  /**
   * Probe image dimensions from a File without sending any bytes to the server.
   * Returns null on any failure (e.g. browser doesn't support createImageBitmap for that type).
   * The server always re-probes authoritatively; this is only for tus metadata.
   */
  async function probeImageDimensions(
    file: File,
  ): Promise<{ width: number; height: number } | null> {
    try {
      const bitmap = await createImageBitmap(file)
      const result = { width: bitmap.width, height: bitmap.height }
      bitmap.close()
      return result
    } catch {
      return null
    }
  }

  /**
   * Starts polling GET /api/media/:assetId/video-info every TRANSCODE_POLL_INTERVAL_MS.
   * Resolves to 'done' or 'failed', then fires onDone callback.
   * Polling stops when entry is cancelled externally (timer cleared in cancelUpload).
   */
  function startTranscodePoll(id: string, assetId: string) {
    const getToken = () => token

    async function poll() {
      try {
        const url = `${API_URL}/api/media/${assetId}/video-info`
        const headers: Record<string, string> = {}
        const tok = getToken()
        if (tok !== null) headers['Authorization'] = `Bearer ${tok}`

        const res = await fetch(url, { headers })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON shape unknown at compile time
        const data = (await res.json()) as any

        const status: string = data.transcodeStatus ?? 'pending'

        if (status === 'done') {
          transPollTimersRef.current.delete(id)
          setUploads((prev) => {
            const entry = prev.find((e) => e.id === id)
            if (entry === undefined) return prev

            const patch: Partial<UploadEntry> = { status: 'done', progress: 1 }
            if (typeof data.width === 'number') patch.width = data.width
            if (typeof data.height === 'number') patch.height = data.height

            const done: UploadEntry = { ...entry, ...patch }
            const cb = onDoneCallbacksRef.current.get(id)
            if (cb !== undefined) {
              Promise.resolve()
                .then(() => cb(done))
                .catch(() => undefined)
            }
            return prev.map((e) => (e.id === id ? done : e))
          })
        } else if (status === 'failed') {
          transPollTimersRef.current.delete(id)
          const errorMsg: string =
            typeof data.transcodeError === 'string' ? data.transcodeError : 'Transcode failed'
          upsertEntry(id, { status: 'error', error: errorMsg })
        } else {
          // pending | processing — schedule next poll
          const timer = setTimeout(() => {
            void poll()
          }, TRANSCODE_POLL_INTERVAL_MS)
          transPollTimersRef.current.set(id, timer)
        }
      } catch (err) {
        // Network error during poll — retry after interval
        const timer = setTimeout(() => {
          void poll()
        }, TRANSCODE_POLL_INTERVAL_MS)
        transPollTimersRef.current.set(id, timer)
        console.warn('[useMediaUpload] transcode poll error', err)
      }
    }

    void poll()
  }

  /**
   * Create and start a tus.Upload instance for the given file + entry id.
   * Shared between initial startUpload and retryUpload.
   */
  function createAndStartTusUpload(
    id: string,
    file: File,
    dims: { width?: number; height?: number } = {},
  ) {
    const metadata: Record<string, string> = {
      deckId,
      filename: file.name,
      mimetype: file.type,
    }
    if (dims.width !== undefined) metadata['width'] = String(dims.width)
    if (dims.height !== undefined) metadata['height'] = String(dims.height)

    const headers: Record<string, string> = {}
    if (token !== null) {
      headers['Authorization'] = `Bearer ${token}`
    }

    const isVideo = file.type.startsWith('video/')

    // Capture assetId from the response header (set by server on the final PATCH).
    let capturedAssetId: string | undefined

    const upload = new tus.Upload(file, {
      endpoint: UPLOAD_ENDPOINT,
      retryDelays: [0, 1000, 3000, 5000],
      chunkSize: 5 * 1024 * 1024, // 5 MB chunks
      metadata,
      headers,
      onProgress(bytesSent: number, bytesTotal: number) {
        const progress = bytesTotal > 0 ? bytesSent / bytesTotal : 0
        upsertEntry(id, { status: 'uploading', progress })
      },
      onAfterResponse(_req: tus.HttpRequest, res: tus.HttpResponse) {
        // Server sets X-Narrative-Asset-Id on the final PATCH response.
        const assetId = res.getHeader('X-Narrative-Asset-Id')
        if (assetId === undefined || assetId === '') return

        capturedAssetId = assetId

        const rawWidth = res.getHeader('X-Narrative-Width')
        const rawHeight = res.getHeader('X-Narrative-Height')
        const parsedWidth = rawWidth !== undefined ? parseInt(rawWidth, 10) : NaN
        const parsedHeight = rawHeight !== undefined ? parseInt(rawHeight, 10) : NaN

        // For video: go to 'finalizing' (transcode pending), skip immediate 'done'.
        const patch: Partial<UploadEntry> = { status: 'finalizing', assetId }
        if (!isNaN(parsedWidth)) patch.width = parsedWidth
        if (!isNaN(parsedHeight)) patch.height = parsedHeight
        upsertEntry(id, patch)
      },
      onSuccess() {
        if (isVideo && capturedAssetId !== undefined) {
          // Video: stay in 'finalizing', start polling transcode status.
          // onDone fires once transcode completes (via startTranscodePoll).
          // Entry already has status='finalizing' from onAfterResponse.
          startTranscodePoll(id, capturedAssetId)
          // Clean up tus reference
          tusUploadsRef.current.delete(id)
          return
        }

        // Image (or video without assetId — shouldn't happen but handle gracefully).
        setUploads((prev) => {
          const entry = prev.find((e) => e.id === id)
          if (entry === undefined) return prev
          const done: UploadEntry = { ...entry, status: 'done', progress: 1 }
          const cb = onDoneCallbacksRef.current.get(id)
          if (cb !== undefined) {
            Promise.resolve()
              .then(() => cb(done))
              .catch(() => undefined)
          }
          return prev.map((e) => (e.id === id ? done : e))
        })
        tusUploadsRef.current.delete(id)
      },
      onError(error: Error) {
        upsertEntry(id, {
          status: 'error',
          error: error.message,
        })
        tusUploadsRef.current.delete(id)
      },
    })

    tusUploadsRef.current.set(id, upload)
    upsertEntry(id, { status: 'uploading' })
    upload.start()
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  const startUpload = useCallback(
    (file: File, opts?: { onDone?: (entry: UploadEntry) => void }): string => {
      const id = nanoid()
      const isImage = file.type.startsWith('image/')
      const isVideo = file.type.startsWith('video/')

      // Client-side MIME validation
      if (!isImage && !isVideo) {
        const errorEntry: UploadEntry = {
          id,
          filename: file.name,
          sizeBytes: file.size,
          mimeType: file.type,
          status: 'error',
          progress: 0,
          error: 'Unsupported file type — only images and videos are accepted',
        }
        setUploads((prev) => [...prev, errorEntry])
        if (opts?.onDone !== undefined) {
          opts.onDone(errorEntry)
        }
        return id
      }

      // Client-side video size check (500 MB)
      if (isVideo && file.size > VIDEO_MAX_BYTES) {
        const errorEntry: UploadEntry = {
          id,
          filename: file.name,
          sizeBytes: file.size,
          mimeType: file.type,
          status: 'error',
          progress: 0,
          error: 'Video file too large — maximum 500 MB',
        }
        setUploads((prev) => [...prev, errorEntry])
        if (opts?.onDone !== undefined) {
          opts.onDone(errorEntry)
        }
        return id
      }

      // Register initial entry
      const initialEntry: UploadEntry = {
        id,
        filename: file.name,
        sizeBytes: file.size,
        mimeType: file.type,
        status: 'queued',
        progress: 0,
      }
      setUploads((prev) => [...prev, initialEntry])
      filesRef.current.set(id, file)
      if (opts?.onDone !== undefined) {
        onDoneCallbacksRef.current.set(id, opts.onDone)
      }

      if (isImage) {
        // Probe dimensions then start upload
        probeImageDimensions(file)
          .then((dims) => {
            createAndStartTusUpload(id, file, dims ?? {})
          })
          .catch(() => {
            createAndStartTusUpload(id, file, {})
          })
      } else {
        // Video: no client-side dimension probe (codec-dependent, not readable via ImageBitmap)
        createAndStartTusUpload(id, file, {})
      }

      return id
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- createAndStartTusUpload stable via closure over refs
    [deckId, token],
  )

  const cancelUpload = useCallback((id: string) => {
    // Abort tus upload if in progress
    const upload = tusUploadsRef.current.get(id)
    if (upload !== undefined) {
      upload.abort(true).catch(() => undefined)
      tusUploadsRef.current.delete(id)
    }
    // Clear any transcode poll timer
    // Note: server-side transcode job cannot be cancelled in M12 — it runs to completion.
    const timer = transPollTimersRef.current.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      transPollTimersRef.current.delete(id)
    }
    upsertEntry(id, { status: 'cancelled' })
  }, [])

  const retryUpload = useCallback(
    (id: string) => {
      const file = filesRef.current.get(id)
      if (file === undefined) return

      // Clear any existing transcode poll timer
      const timer = transPollTimersRef.current.get(id)
      if (timer !== undefined) {
        clearTimeout(timer)
        transPollTimersRef.current.delete(id)
      }

      // Reset entry to queued, then probe dims and start.
      setUploads((prev) =>
        prev.map((e) => {
          if (e.id !== id) return e
          const { error: _dropped, ...rest } = e
          return { ...rest, status: 'queued' as const, progress: 0 }
        }),
      )

      const isImage = file.type.startsWith('image/')
      if (isImage) {
        probeImageDimensions(file)
          .then((dims) => {
            createAndStartTusUpload(id, file, dims ?? {})
          })
          .catch(() => {
            createAndStartTusUpload(id, file, {})
          })
      } else {
        createAndStartTusUpload(id, file, {})
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [deckId, token],
  )

  const dismissUpload = useCallback((id: string) => {
    setUploads((prev) => {
      const entry = prev.find((e) => e.id === id)
      if (entry === undefined) return prev
      if (
        entry.status === 'uploading' ||
        entry.status === 'queued' ||
        entry.status === 'finalizing'
      )
        return prev
      return prev.filter((e) => e.id !== id)
    })
    // Clean up references
    filesRef.current.delete(id)
    onDoneCallbacksRef.current.delete(id)
    const timer = transPollTimersRef.current.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      transPollTimersRef.current.delete(id)
    }
  }, [])

  const value = useMemo<MediaUploadContextValue>(
    () => ({ uploads, startUpload, cancelUpload, retryUpload, dismissUpload }),
    [uploads, startUpload, cancelUpload, retryUpload, dismissUpload],
  )

  return <MediaUploadContext.Provider value={value}>{children}</MediaUploadContext.Provider>
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useMediaUpload(): MediaUploadContextValue {
  const ctx = useContext(MediaUploadContext)
  if (ctx === null) {
    throw new Error('useMediaUpload must be used within MediaUploadProvider')
  }
  return ctx
}
