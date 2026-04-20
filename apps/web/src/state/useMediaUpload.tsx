/**
 * state/useMediaUpload.ts
 *
 * M11: Resumable image upload via tus protocol.
 *
 * Provides:
 *   - MediaUploadContext (React context) — mounted in DeckShell via MediaUploadProvider
 *   - useMediaUpload() hook — access uploads state + startUpload / cancelUpload / retryUpload / dismissUpload
 *
 * Upload lifecycle:
 *   startUpload(file) →
 *     client-side MIME validation (image/* only) →
 *     optional dimension probe via createImageBitmap (best-effort, server re-probes authoritatively) →
 *     tus.Upload.start() →
 *     onProgress: status='uploading', progress 0..1 →
 *     onSuccess: read X-Narrative-Asset-Id from final PATCH response via onAfterResponse →
 *       status='done', assetId, width, height →
 *       trigger onDone callback →
 *     onError: status='error'
 *
 * Cancel: tus.Upload.abort() → status='cancelled'
 * Retry: re-creates tus.Upload from stored File reference
 * Dismiss: removes entry from list (only if done/error/cancelled)
 *
 * Auth: Bearer token from useAuth().token in tus request headers.
 * Endpoint: VITE_API_URL/api/uploads (tus protocol)
 * Metadata: deckId, filename, mimetype, width?, height? (tus-js-client encodes as base64)
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
  status: 'queued' | 'uploading' | 'finalizing' | 'done' | 'error' | 'cancelled'
  progress: number // 0..1
  error?: string
  assetId?: string // set on status='done'
  width?: number
  height?: number
}

export interface MediaUploadContextValue {
  uploads: ReadonlyArray<UploadEntry>
  /**
   * Starts a resumable upload for a File. Returns the local upload id.
   * Only image/* MIME types accepted — others resolve immediately with status='error'.
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
        // tus-js-client calls this after every response, so we check if assetId is present.
        // getHeader() returns string | undefined (not string | null).
        const assetId = res.getHeader('X-Narrative-Asset-Id')
        if (assetId === undefined || assetId === '') return

        const rawWidth = res.getHeader('X-Narrative-Width')
        const rawHeight = res.getHeader('X-Narrative-Height')
        const parsedWidth = rawWidth !== undefined ? parseInt(rawWidth, 10) : NaN
        const parsedHeight = rawHeight !== undefined ? parseInt(rawHeight, 10) : NaN

        // Build patch without optional keys set to undefined (exactOptionalPropertyTypes)
        const patch: Partial<UploadEntry> = { status: 'finalizing', assetId }
        if (!isNaN(parsedWidth)) patch.width = parsedWidth
        if (!isNaN(parsedHeight)) patch.height = parsedHeight
        upsertEntry(id, patch)
      },
      onSuccess() {
        // Entry should already have assetId from onAfterResponse if the server set the header.
        // Transition to 'done' regardless and fire onDone.
        setUploads((prev) => {
          const entry = prev.find((e) => e.id === id)
          if (entry === undefined) return prev
          const done: UploadEntry = { ...entry, status: 'done', progress: 1 }
          // Fire callback outside setState
          const cb = onDoneCallbacksRef.current.get(id)
          if (cb !== undefined) {
            // Defer to next microtask so we don't mutate state inside setState
            Promise.resolve()
              .then(() => cb(done))
              .catch(() => undefined)
          }
          return prev.map((e) => (e.id === id ? done : e))
        })
        // Clean up tus upload reference (keep file for potential retry)
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

      // Client-side MIME validation
      if (!file.type.startsWith('image/')) {
        const errorEntry: UploadEntry = {
          id,
          filename: file.name,
          sizeBytes: file.size,
          status: 'error',
          progress: 0,
          error: 'Unsupported file type — only images are accepted',
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
        status: 'queued',
        progress: 0,
      }
      setUploads((prev) => [...prev, initialEntry])
      filesRef.current.set(id, file)
      if (opts?.onDone !== undefined) {
        onDoneCallbacksRef.current.set(id, opts.onDone)
      }

      // Probe dimensions then start upload
      probeImageDimensions(file)
        .then((dims) => {
          createAndStartTusUpload(id, file, dims ?? {})
        })
        .catch(() => {
          createAndStartTusUpload(id, file, {})
        })

      return id
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- createAndStartTusUpload stable via closure over refs
    [deckId, token],
  )

  const cancelUpload = useCallback((id: string) => {
    const upload = tusUploadsRef.current.get(id)
    if (upload !== undefined) {
      upload.abort(true).catch(() => undefined)
      tusUploadsRef.current.delete(id)
    }
    upsertEntry(id, { status: 'cancelled' })
  }, [])

  const retryUpload = useCallback(
    (id: string) => {
      const file = filesRef.current.get(id)
      if (file === undefined) return

      // Reset entry to queued, then probe dims and start.
      // We must not set error: undefined with exactOptionalPropertyTypes — instead spread
      // the entry (which may have error) and then delete the key via patch without the field.
      setUploads((prev) =>
        prev.map((e) => {
          if (e.id !== id) return e
          const { error: _dropped, ...rest } = e
          return { ...rest, status: 'queued' as const, progress: 0 }
        }),
      )

      probeImageDimensions(file)
        .then((dims) => {
          createAndStartTusUpload(id, file, dims ?? {})
        })
        .catch(() => {
          createAndStartTusUpload(id, file, {})
        })
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
