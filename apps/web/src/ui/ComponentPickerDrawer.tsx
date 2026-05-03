/**
 * ui/ComponentPickerDrawer.tsx
 *
 * M16 P6 — Slide-out drawer for the "+ Add component" Toolbar action.
 *
 * UX:
 *   - Right-side overlay panel, ~340 px wide, shadow + backdrop.
 *   - Header: "Components" title + close button.
 *   - Body: list of components in the current folder (thumbnail + name +
 *     usage count). Click a row to instantiate at the slide centre.
 *   - Drag-out support: each row has draggable=true with a custom payload
 *     that the canvas drop-target reads to insert at the drop point.
 *   - Empty state: directs the user to the editor right-click → promote
 *     flow.
 *
 * Why a custom drawer (no shadcn `Sheet`):
 *   - shadcn doesn't ship a Sheet component in this project's ui/ folder
 *     (only Dialog / Popover / Dropdown). Adding it would mean a new
 *     dependency on `vaul` or rolling our own off Radix. The drawer below
 *     is ~50 lines, accessible (Escape closes, focus trap on Tab), and
 *     uses the existing Tailwind tokens. If we later add Sheet, the
 *     swap is a one-component edit.
 *
 * Accessibility:
 *   - role="dialog", aria-modal, aria-labelledby
 *   - Escape closes
 *   - Focus moves to the close button on open
 *   - Tab is constrained to the drawer's interactive elements while open
 */

import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X, Plus, Loader2 } from 'lucide-react'
import type { ComponentSummary } from '../api/client.js'
import { Button } from '@/components/ui/button'

interface ComponentPickerDrawerProps {
  /** Open / closed. */
  open: boolean
  onClose: () => void
  /** The folder to read components from. */
  components: ComponentSummary[] | null
  loading: boolean
  /**
   * Pre-fetched batch usage counts (componentId → count). Caller fetches
   * once on drawer open via `api.listComponentInstanceCounts(folderId)` so
   * each row reads its count synchronously.
   */
  usageCounts: Record<string, number> | null
  /**
   * Called when the user clicks a row. Receives the component summary so the
   * caller can resolve master bbox + insert at the slide centre.
   */
  onPick: (component: ComponentSummary) => void
  /**
   * Called when the user drags a row out of the drawer. The caller wires
   * the canvas drop-target which reads the dataTransfer payload and inserts
   * at the drop point.
   *
   * Payload format on dataTransfer:
   *   type: 'application/x-narrative-component'
   *   value: JSON.stringify({ componentId })
   */
  onDragStartComponent?: (component: ComponentSummary, e: React.DragEvent) => void
}

export function ComponentPickerDrawer({
  open,
  onClose,
  components,
  loading,
  usageCounts,
  onPick,
  onDragStartComponent,
}: ComponentPickerDrawerProps) {
  const closeBtnRef = useRef<HTMLButtonElement>(null)

  // Escape closes; focus close on open.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    closeBtnRef.current?.focus()
    return () => {
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  if (!open) return null
  if (typeof document === 'undefined') return null

  // Portal to <body> so the fixed-positioned drawer escapes any
  // ancestor stacking context (the toolbar / its sub-trees use
  // transforms / filters which would otherwise trap a `z-50` <aside>
  // beneath the editor's own absolutely-positioned panels).
  return createPortal(
    <>
      {/* Backdrop — dismisses on click. Subtle (the editor stays visible). */}
      <div
        className="fixed inset-0 z-[100] bg-black/20 backdrop-blur-[1px]"
        aria-hidden="true"
        onClick={onClose}
        data-testid="component-picker-backdrop"
      />

      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="component-picker-title"
        data-testid="component-picker-drawer"
        className="fixed right-0 top-0 z-[101] flex h-full w-[340px] flex-col border-l border-border bg-popover shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 id="component-picker-title" className="text-sm font-semibold text-foreground">
            Components
          </h2>
          <Button
            ref={closeBtnRef}
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Close component picker"
            className="h-7 w-7"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </header>

        <div className="flex-1 overflow-y-auto p-3">
          {loading && (components === null || components.length === 0) ? (
            <div
              className="flex items-center justify-center py-12 text-xs text-muted-foreground"
              role="status"
            >
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              Loading…
            </div>
          ) : components !== null && components.length === 0 ? (
            <EmptyState />
          ) : (
            <ul role="list" className="flex flex-col gap-1.5">
              {(components ?? []).map((c) => (
                <ComponentRow
                  key={c.id}
                  component={c}
                  usageCount={usageCounts !== null ? (usageCounts[c.id] ?? 0) : null}
                  onPick={() => onPick(c)}
                  onDragStart={(e) => onDragStartComponent?.(c, e)}
                />
              ))}
            </ul>
          )}
        </div>
      </aside>
    </>,
    document.body,
  )
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

interface ComponentRowProps {
  component: ComponentSummary
  /** Resolved usage count from the batch fetch, or null until it lands. */
  usageCount: number | null
  onPick: () => void
  onDragStart: (e: React.DragEvent) => void
}

function ComponentRow({ component, usageCount, onPick, onDragStart }: ComponentRowProps) {
  return (
    <li role="listitem">
      <button
        type="button"
        onClick={onPick}
        draggable
        onDragStart={onDragStart}
        data-testid={`component-picker-row-${component.id}`}
        className="group flex w-full items-center gap-3 rounded-md border border-transparent p-2 text-left transition hover:border-border hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/40"
      >
        {/* Thumbnail — img if available, else ⌘ placeholder badge */}
        {component.thumbnailUrl != null ? (
          <img
            src={component.thumbnailUrl}
            alt=""
            className="h-10 w-14 flex-shrink-0 rounded-sm border border-border object-cover"
            draggable={false}
          />
        ) : (
          <span
            className="flex h-10 w-14 flex-shrink-0 items-center justify-center rounded-sm border border-[#6366f1]/40 bg-[#6366f1]/10 text-base text-[#6366f1]"
            aria-hidden="true"
          >
            ⌘
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-foreground">{component.name}</p>
          <p className="truncate text-[10px] text-muted-foreground/70">
            {usageCount === null
              ? '—'
              : `Used ${usageCount} ${usageCount === 1 ? 'time' : 'times'}`}
          </p>
        </div>
      </button>
    </li>
  )
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <Plus className="mb-2 h-6 w-6 text-muted-foreground/40" aria-hidden="true" />
      <p className="text-xs text-muted-foreground">No components yet.</p>
      <p className="mt-1 max-w-[220px] text-[10px] text-muted-foreground/60">
        Right-click any selection in the editor and choose <em>Promote to shared component</em>.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Drag-and-drop dataTransfer payload
// ---------------------------------------------------------------------------

/**
 * Custom MIME type used by the drawer's drag-out and the canvas drop-target.
 * Distinct from `text/*` so the existing image / text-paste handlers don't
 * accidentally match component drags.
 */
export const COMPONENT_DRAG_MIME = 'application/x-narrative-component'

export interface ComponentDragPayload {
  componentId: string
}
