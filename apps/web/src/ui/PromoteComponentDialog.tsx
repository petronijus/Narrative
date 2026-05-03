/**
 * ui/PromoteComponentDialog.tsx
 *
 * Modal dialog used by EditorContextMenu's Promote-to-Component flow.
 * Replaces the native window.prompt — gives us proper styling, focus
 * management, Escape-to-cancel, and a primary "Promote" CTA that's
 * disabled until the user types a non-empty name.
 *
 * Mounted lazily by the menu (not always in the tree). Portal'd to
 * document.body so it escapes whatever stacking context the menu's
 * Radix portal lives in.
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import { Component as ComponentIcon, X } from 'lucide-react'

interface PromoteComponentDialogProps {
  /** Whether the dialog is open. Caller controls. */
  open: boolean
  /** Initial name suggestion — defaults to "Untitled component". */
  initialName?: string
  /** Called when the user confirms with a non-empty trimmed name. */
  onConfirm: (name: string) => void
  /** Called when the user cancels (Escape, click outside, X button). */
  onCancel: () => void
}

export function PromoteComponentDialog({
  open,
  initialName = 'Untitled component',
  onConfirm,
  onCancel,
}: PromoteComponentDialogProps) {
  const [name, setName] = useState(initialName)
  const inputRef = useRef<HTMLInputElement>(null)

  // Reset draft when re-opened so a previous cancel doesn't leak in.
  useEffect(() => {
    if (open) setName(initialName)
  }, [open, initialName])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCancel()
      }
    }
    document.addEventListener('keydown', onKey)
    // Focus + select-all on open so the user can immediately type to
    // overwrite the suggested name.
    const t = window.setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
    return () => {
      document.removeEventListener('keydown', onKey)
      window.clearTimeout(t)
    }
  }, [open, onCancel])

  if (!open) return null
  if (typeof document === 'undefined') return null

  const trimmed = name.trim()
  const canConfirm = trimmed !== ''

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (canConfirm) onConfirm(trimmed)
  }

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[200] bg-black/40 backdrop-blur-sm"
        aria-hidden="true"
        onClick={onCancel}
        data-testid="promote-component-backdrop"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="promote-component-title"
        className="fixed left-1/2 top-1/2 z-[201] w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-popover p-5 shadow-2xl"
        data-testid="promote-component-dialog"
      >
        <header className="mb-4 flex items-center gap-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <ComponentIcon className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="promote-component-title" className="text-sm font-semibold text-foreground">
              Promote to shared component
            </h2>
            <p className="text-xs text-muted-foreground">
              The selection becomes a master that can be reused across decks in this folder.
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

        <form onSubmit={handleSubmit}>
          <label htmlFor="promote-component-name" className="text-xs text-muted-foreground">
            Component name
          </label>
          <input
            id="promote-component-name"
            ref={inputRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            className="mt-1 w-full rounded-md border border-input bg-surface-1 px-2 py-1.5 text-sm text-foreground focus:border-ring focus:outline-none"
            autoComplete="off"
            spellCheck={false}
          />
          <div className="mt-5 flex items-center justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={!canConfirm}
              className="btn-brand gap-1.5"
              data-testid="promote-component-confirm"
            >
              Promote
            </Button>
          </div>
        </form>
      </div>
    </>,
    document.body,
  )
}
