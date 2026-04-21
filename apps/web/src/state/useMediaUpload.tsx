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
  useEffect,
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
  // Synchronous mirror of `uploads` — needed because setUploads runs its updater
  // asynchronously (and twice in Strict Mode). Consumers that need a definitive
  // snapshot (e.g. dispatching onDone after a status transition) read from here.
  const uploadsMapRef = useRef<Map<string, UploadEntry>>(new Map())
  // tus.Upload instances keyed by local upload id (for abort/retry)
  const tusUploadsRef = useRef<Map<string, tus.Upload>>(new Map())
  // Original File references keyed by local upload id (for retry after cancel)
  const filesRef = useRef<Map<string, File>>(new Map())
  // onDone callbacks keyed by local upload id
  const onDoneCallbacksRef = useRef<Map<string, (entry: UploadEntry) => void>>(new Map())
  // Transcode poll interval IDs keyed by local upload id
  const transPollTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  // Keep the synchronous mirror in sync with committed state (runs once per
  // commit, not per Strict Mode double-invocation of the updater).
  useEffect(() => {
    const m = new Map<string, UploadEntry>()
    for (const e of uploads) m.set(e.id, e)
    uploadsMapRef.current = m
  }, [uploads])

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
          // Consume the onDone callback before the state update so React's
          // Strict Mode double-invoked updater can't schedule cb() twice.
          const cb = onDoneCallbacksRef.current.get(id)
          onDoneCallbacksRef.current.delete(id)

          const patch: Partial<UploadEntry> = { status: 'done', progress: 1 }
          if (typeof data.width === 'number') patch.width = data.width
          if (typeof data.height === 'number') patch.height = data.height

          setUploads((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)))

          if (cb !== undefined) {
            const prev = uploadsMapRef.current.get(id)
            if (prev !== undefined) {
              const finalEntry: UploadEntry = { ...prev, ...patch }
              Promise.resolve()
                .then(() => cb(finalEntry))
                .catch(() => undefined)
            }
          }
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
      'content-type': file.type,
    }
    if (dims.width !== undefined) metadata['width'] = String(dims.width)
    if (dims.height !== undefined) metadata['height'] = String(dims.height)

    const headers: Record<string, string> = {}
    if (token !== null) {
      headers['Authorization'] = `Bearer ${token}`
    }

    const isVideo = file.type.startsWith('video/')

    // Capture values from the final PATCH response body — needed to build the
    // onDone entry synchronously without reading state (which may be stale/batched).
    let capturedAssetId: string | undefined
    let capturedWidth: number | undefined
    let capturedHeight: number | undefined

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
        // The final PATCH response body is a JSON payload from onUploadFinish
        // ({ assetId, storageKey, mimeType, sizeBytes, width?, height?, transcodeStatus? }).
        // We read from the body instead of response headers because @tus/server
        // hardcodes Access-Control-Expose-Headers, so custom X-Narrative-* headers
        // are stripped by the browser in CORS mode.
        const bodyText = (res as unknown as { getBody?: () => string }).getBody?.()
        if (!bodyText) return
        let parsed: {
          assetId?: string
          width?: number
          height?: number
        } | null = null
        try {
          parsed = JSON.parse(bodyText)
        } catch {
          return
        }
        const assetId = parsed?.assetId
        if (typeof assetId !== 'string' || assetId === '') return

        capturedAssetId = assetId
        if (typeof parsed?.width === 'number') capturedWidth = parsed.width
        if (typeof parsed?.height === 'number') capturedHeight = parsed.height

        const patch: Partial<UploadEntry> = { status: 'finalizing', assetId }
        if (capturedWidth !== undefined) patch.width = capturedWidth
        if (capturedHeight !== undefined) patch.height = capturedHeight
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
        // Consume the callback before the state update. React Strict Mode
        // double-invokes the setUploads updater in dev; deleting from the ref
        // map up front guarantees at-most-once onDone dispatch.
        const cb = onDoneCallbacksRef.current.get(id)
        onDoneCallbacksRef.current.delete(id)

        setUploads((prev) =>
          prev.map((e) =>
            e.id === id
              ? {
                  ...e,
                  status: 'done' as const,
                  progress: 1,
                  ...(capturedAssetId !== undefined ? { assetId: capturedAssetId } : {}),
                  ...(capturedWidth !== undefined ? { width: capturedWidth } : {}),
                  ...(capturedHeight !== undefined ? { height: capturedHeight } : {}),
                }
              : e,
          ),
        )

        if (cb !== undefined) {
          const finalEntry: UploadEntry = {
            id,
            filename: file.name,
            sizeBytes: file.size,
            mimeType: file.type,
            status: 'done',
            progress: 1,
            ...(capturedAssetId !== undefined ? { assetId: capturedAssetId } : {}),
            ...(capturedWidth !== undefined ? { width: capturedWidth } : {}),
            ...(capturedHeight !== undefined ? { height: capturedHeight } : {}),
          }
          Promise.resolve()
            .then(() => cb(finalEntry))
            .catch(() => undefined)
        }
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
