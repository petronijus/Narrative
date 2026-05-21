/**
 * ui/ExportPptxDialog.tsx
 *
 * Pre-export compatibility checklist. Scans the deck for features that
 * won't survive a `.pptx` round-trip (font embedding, video playback
 * options, etc.) and gives the user a chance to decide whether to
 * proceed. Sibling of `ImportPptxDialog`: same styling chrome, same
 * busy-spinner UX, just different content.
 */

import { useMemo, useState } from 'react'
import { AlertTriangle, FileDown, Info, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { scanDeckForExportCompat, type CompatWarning } from '../lib/pptxCompat.js'
import type { Slide } from '@narrative/shared'

interface ExportPptxDialogProps {
  /** Plain-JSON snapshot of every slide in the deck. The scanner runs
   *  synchronously over this; the caller is responsible for producing it
   *  via `listSlides()` before opening the dialog. */
  slides: Slide[]
  /** Triggered when the user clicks "Export". The dialog stays open and
   *  shows the spinner until this resolves; rejection becomes a banner. */
  onExport: () => Promise<void>
  onClose: () => void
}

export function ExportPptxDialog({ slides, onExport, onClose }: ExportPptxDialogProps) {
  const warnings = useMemo(() => scanDeckForExportCompat(slides), [slides])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleConfirm = async () => {
    setError(null)
    setBusy(true)
    try {
      await onExport()
      // Parent decides what to do after — usually closing the dialog or
      // navigating. We leave `busy` true so the spinner persists until
      // the parent dismounts the dialog.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed')
      setBusy(false)
    }
  }

  const lossy = warnings.filter((w) => w.severity === 'lossy')
  const simplified = warnings.filter((w) => w.severity === 'simplified')

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Export to PowerPoint"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !busy) onClose()
      }}
      tabIndex={-1}
    >
      <div className="panel w-[520px] max-h-[80vh] overflow-y-auto rounded-xl border border-border p-5 shadow-xl">
        <h2 className="mb-1 text-sm font-semibold text-foreground">Export to PowerPoint</h2>
        <p className="mb-4 text-xs text-muted-foreground">
          Most of your deck will round-trip cleanly. Below is what won’t survive the conversion to
          `.pptx` — review and decide whether to proceed.
        </p>

        {warnings.length === 0 ? (
          <div
            role="status"
            className="mb-4 flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-foreground"
          >
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" aria-hidden="true" />
            <span>
              No compatibility issues detected. The exported file should match your deck closely.
            </span>
          </div>
        ) : (
          <div className="mb-4 space-y-3">
            {lossy.length > 0 && (
              <WarningGroup
                heading="Will not be preserved"
                icon={<AlertTriangle className="h-3.5 w-3.5 text-amber-500" aria-hidden="true" />}
                warnings={lossy}
              />
            )}
            {simplified.length > 0 && (
              <WarningGroup
                heading="Will be simplified"
                icon={<Info className="h-3.5 w-3.5 text-sky-400" aria-hidden="true" />}
                warnings={simplified}
              />
            )}
          </div>
        )}

        {error !== null && (
          <p role="alert" className="mb-3 text-xs text-destructive-foreground">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => void handleConfirm()}
            disabled={busy}
            className="btn-brand gap-1.5"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <FileDown className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {busy ? 'Exporting…' : 'Export anyway'}
          </Button>
        </div>
      </div>
    </div>
  )
}

interface WarningGroupProps {
  heading: string
  icon: React.ReactNode
  warnings: CompatWarning[]
}

function WarningGroup({ heading, icon, warnings }: WarningGroupProps) {
  return (
    <section>
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-medium text-foreground">
        {icon}
        {heading}
      </h3>
      <ul className="space-y-2">
        {warnings.map((w) => (
          <li
            key={w.id}
            className="rounded-md border border-border bg-surface-1 px-3 py-2 text-xs text-muted-foreground"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium text-foreground">{w.title}</span>
              {w.count > 1 && (
                <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground/70">
                  ×{w.count}
                </span>
              )}
            </div>
            <p className="mt-1 leading-relaxed">{w.detail}</p>
          </li>
        ))}
      </ul>
    </section>
  )
}
