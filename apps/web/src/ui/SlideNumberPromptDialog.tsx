/**
 * ui/SlideNumberPromptDialog.tsx
 *
 * Shown the first time the user marks a text box as a page-number
 * field in the current deck. Suggests the two recommended workflows
 * (apply the dedicated "Footnotes and pages" text style, or promote
 * the text into a reusable "Page number" component) plus a "Leave as
 * is" escape hatch. The flag is always toggled regardless of the
 * choice — the modal only adds extra setup.
 */

import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import { Hash, Component as ComponentIcon, Type, X } from 'lucide-react'

interface SlideNumberPromptDialogProps {
  open: boolean
  /** Disable the "Apply text style" CTA when no matching folder style exists. */
  textStyleAvailable: boolean
  onApplyTextStyle: () => void
  onCreateComponent: () => void
  onLeaveAsIs: () => void
  onCancel: () => void
}

export function SlideNumberPromptDialog({
  open,
  textStyleAvailable,
  onApplyTextStyle,
  onCreateComponent,
  onLeaveAsIs,
  onCancel,
}: SlideNumberPromptDialogProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCancel()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onCancel])

  if (!open) return null
  if (typeof document === 'undefined') return null

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[200] bg-black/40 backdrop-blur-xs"
        aria-hidden="true"
        onClick={onCancel}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="slide-number-prompt-title"
        className="fixed left-1/2 top-1/2 z-[201] w-[460px] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-popover p-5 shadow-2xl"
      >
        <header className="mb-4 flex items-start gap-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Hash className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="slide-number-prompt-title" className="text-sm font-semibold text-foreground">
              Page number set
            </h2>
            <p className="text-xs text-muted-foreground">
              For better editing, it is recommended to apply a shared text style or to turn this
              text into a reusable component.
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel"
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>

        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={onApplyTextStyle}
            disabled={!textStyleAvailable}
            className="flex items-start gap-2 rounded-md border border-input bg-surface-1 p-3 text-left text-sm hover:border-ring hover:bg-accent/40 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Type className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
            <span className="flex-1">
              <span className="block font-medium text-foreground">
                Apply &ldquo;Footnotes and pages&rdquo; text style
              </span>
              <span className="block text-xs text-muted-foreground">
                {textStyleAvailable
                  ? 'Links this text box to the shared style so future edits to the preset cascade.'
                  : 'No folder text style named "Footnotes and pages" found.'}
              </span>
            </span>
          </button>

          <button
            type="button"
            onClick={onCreateComponent}
            className="flex items-start gap-2 rounded-md border border-input bg-surface-1 p-3 text-left text-sm hover:border-ring hover:bg-accent/40"
          >
            <ComponentIcon className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
            <span className="flex-1">
              <span className="block font-medium text-foreground">
                Create &ldquo;Page number&rdquo; component
              </span>
              <span className="block text-xs text-muted-foreground">
                Promotes this text into a reusable master so the same field can be placed on any
                slide and styled in one place.
              </span>
            </span>
          </button>

          <button
            type="button"
            onClick={onLeaveAsIs}
            className="flex items-start gap-2 rounded-md border border-input bg-surface-1 p-3 text-left text-sm hover:border-ring hover:bg-accent/40"
          >
            <span className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="flex-1">
              <span className="block font-medium text-foreground">Leave as is</span>
              <span className="block text-xs text-muted-foreground">
                Keep the page-number flag on this text box without any extra bindings.
              </span>
            </span>
          </button>
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </>,
    document.body,
  )
}
