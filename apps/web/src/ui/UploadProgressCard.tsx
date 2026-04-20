/**
 * ui/UploadProgressCard.tsx
 *
 * M11: Per-upload progress card shown in the bottom-right of the editor.
 * M12: Extended for video transcode "Processing…" state.
 *
 * Shows:
 *   - Filename (truncated)
 *   - Progress bar + percentage (while uploading)
 *   - "Processing… (transcoding video)" with indeterminate spinner (status='finalizing' for video)
 *   - Cancel button (while uploading)
 *   - Error state: message + retry + dismiss buttons
 *   - Done state: auto-dismiss after 2 s (manual dismiss also available)
 *   - Cancelled state: manual dismiss
 */

import { useEffect } from 'react'
import type { UploadEntry } from '../state/useMediaUpload.js'
import { useMediaUpload } from '../state/useMediaUpload.js'

interface UploadProgressCardProps {
  entry: UploadEntry
}

export function UploadProgressCard({ entry }: UploadProgressCardProps) {
  const { cancelUpload, retryUpload, dismissUpload } = useMediaUpload()

  // Auto-dismiss completed uploads after 2 s
  useEffect(() => {
    if (entry.status !== 'done') return
    const timer = setTimeout(() => {
      dismissUpload(entry.id)
    }, 2000)
    return () => clearTimeout(timer)
  }, [entry.status, entry.id, dismissUpload])

  const isActive =
    entry.status === 'uploading' || entry.status === 'queued' || entry.status === 'finalizing'
  const percent = Math.round(entry.progress * 100)

  // Determine if this is a video transcode wait
  const isVideoTranscoding = entry.status === 'finalizing' && entry.mimeType?.startsWith('video/')

  // Status label
  let statusLabel: string
  switch (entry.status) {
    case 'queued':
      statusLabel = 'Queued…'
      break
    case 'uploading':
      statusLabel = `${percent}%`
      break
    case 'finalizing':
      statusLabel = isVideoTranscoding ? 'Processing…' : 'Finalizing…'
      break
    case 'done':
      statusLabel = 'Done'
      break
    case 'error':
      statusLabel = 'Failed'
      break
    case 'cancelled':
      statusLabel = 'Cancelled'
      break
  }

  return (
    <div
      role="status"
      aria-label={`Upload ${entry.filename}: ${statusLabel}`}
      className={[
        'flex flex-col gap-1.5 rounded-lg border px-3 py-2.5 shadow-lg w-64',
        'bg-gray-900 text-gray-200',
        entry.status === 'error' ? 'border-red-700' : 'border-gray-700',
      ].join(' ')}
    >
      {/* Header row */}
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium text-gray-100 flex-1" title={entry.filename}>
          {entry.filename}
        </span>
        <span
          className={[
            'text-xs font-semibold shrink-0',
            entry.status === 'done'
              ? 'text-green-400'
              : entry.status === 'error'
                ? 'text-red-400'
                : entry.status === 'cancelled'
                  ? 'text-gray-500'
                  : 'text-gray-300',
          ].join(' ')}
        >
          {statusLabel}
        </span>
      </div>

      {/* Progress bar or transcoding spinner — only while active */}
      {isActive && !isVideoTranscoding && (
        <div
          className="h-1.5 w-full rounded-full bg-gray-700 overflow-hidden"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full rounded-full bg-blue-500 transition-all duration-200"
            style={{ width: `${entry.status === 'finalizing' ? 100 : percent}%` }}
          />
        </div>
      )}

      {/* Indeterminate spinner for video transcoding */}
      {isVideoTranscoding && (
        <div className="flex items-center gap-2" role="status" aria-label="Transcoding video">
          {/* Spinning circle */}
          <div className="h-3 w-3 animate-spin rounded-full border-2 border-gray-600 border-t-blue-400 shrink-0" />
          <span className="text-xs text-gray-400">Transcoding video…</span>
        </div>
      )}

      {/* Error message */}
      {entry.status === 'error' && entry.error !== undefined && (
        <p className="text-xs text-red-400 truncate" title={entry.error}>
          {entry.error}
        </p>
      )}

      {/* Action buttons */}
      <div className="flex gap-1.5 mt-0.5">
        {isActive && (
          <button
            type="button"
            onClick={() => cancelUpload(entry.id)}
            className="rounded px-2 py-0.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 transition-colors"
            aria-label={`Cancel upload of ${entry.filename}`}
          >
            Cancel
          </button>
        )}

        {entry.status === 'error' && (
          <>
            <button
              type="button"
              onClick={() => retryUpload(entry.id)}
              className="rounded px-2 py-0.5 text-xs text-blue-400 hover:bg-gray-800 hover:text-blue-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 transition-colors"
              aria-label={`Retry upload of ${entry.filename}`}
            >
              Retry
            </button>
            <button
              type="button"
              onClick={() => dismissUpload(entry.id)}
              className="rounded px-2 py-0.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 transition-colors"
              aria-label={`Dismiss upload error for ${entry.filename}`}
            >
              Dismiss
            </button>
          </>
        )}

        {entry.status === 'cancelled' && (
          <button
            type="button"
            onClick={() => dismissUpload(entry.id)}
            className="rounded px-2 py-0.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 transition-colors"
            aria-label={`Dismiss cancelled upload ${entry.filename}`}
          >
            Dismiss
          </button>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// UploadProgressStack — renders all in-flight + recent uploads
// ---------------------------------------------------------------------------

/**
 * Fixed bottom-right stack of upload progress cards.
 * Mount once in the editor shell (not in PresentLayout).
 */
export function UploadProgressStack() {
  const { uploads } = useMediaUpload()

  if (uploads.length === 0) return null

  return (
    <div
      className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none"
      aria-label="Upload progress"
      aria-live="polite"
    >
      {uploads.map((entry) => (
        <div key={entry.id} className="pointer-events-auto">
          <UploadProgressCard entry={entry} />
        </div>
      ))}
    </div>
  )
}
