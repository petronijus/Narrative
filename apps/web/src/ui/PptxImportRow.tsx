/**
 * ui/PptxImportRow.tsx
 *
 * The placeholder a dropped `.pptx` leaves in the slides panel while it
 * uploads and imports — sitting at the exact index its slides are going to
 * take, so the deck visibly makes room for them rather than rearranging
 * itself under the user when the server answers.
 *
 * It is also where a refusal is reported (a legacy `.ppt`, a parse failure,
 * a lost connection). There is no toast system in this app, and a modal
 * would cover the thumbnails the user was aiming between, so the error
 * stays in the gap it belongs to until dismissed.
 */

import { FileUp, X } from 'lucide-react'
import type { PptxImportJob } from './usePptxDropIntoDeck.js'

interface PptxImportRowProps {
  job: PptxImportJob
  onDismiss: (id: string) => void
}

export function PptxImportRow({ job, onDismiss }: PptxImportRowProps) {
  const isError = job.status === 'error'
  const percent = Math.round(job.progress * 100)

  return (
    <div className="mx-2" data-testid="pptx-import-row" data-status={job.status}>
      <div
        className={[
          'flex flex-col justify-center gap-1.5 rounded border-2 border-dashed px-2.5 py-2',
          isError
            ? 'border-red-500/50 bg-red-500/5'
            : 'border-blue-400/50 bg-blue-400/5 animate-pulse',
        ].join(' ')}
        style={{ aspectRatio: '16/9', width: '100%' }}
      >
        <div className="flex items-start gap-1.5">
          <FileUp
            className={[
              'mt-px h-3.5 w-3.5 flex-shrink-0',
              isError ? 'text-red-400' : 'text-blue-300',
            ].join(' ')}
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground/90">
            {job.filename}
          </span>
          {isError && (
            <button
              type="button"
              onClick={() => onDismiss(job.id)}
              aria-label={`Dismiss import error for ${job.filename}`}
              className="-mr-0.5 flex-shrink-0 rounded p-0.5 text-muted-foreground hover:bg-white/10 hover:text-foreground"
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          )}
        </div>

        {isError ? (
          <p className="text-[10px] leading-snug text-red-300">{job.error}</p>
        ) : (
          <>
            <p className="text-[10px] text-muted-foreground">
              {job.status === 'uploading' ? `Uploading… ${percent}%` : 'Importing slides…'}
            </p>
            {/* Determinate while bytes are moving; once they have all landed
                the server is parsing and there is nothing honest left to
                measure, so the bar sits full and the label carries the
                state. */}
            <div className="h-1 w-full overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-blue-400 transition-[width] duration-200"
                style={{ width: job.status === 'uploading' ? `${percent}%` : '100%' }}
              />
            </div>
          </>
        )}
      </div>
    </div>
  )
}
