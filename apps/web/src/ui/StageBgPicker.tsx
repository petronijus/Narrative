/**
 * ui/StageBgPicker.tsx
 *
 * Local-only control for tinting the editor stage backdrop (area around
 * the artboard). Collapsed default shows a brush trigger; clicking it
 * opens a popover with five neutral-grey swatches and a reset button.
 * Outside click or Escape closes the popover. State lives in
 * localStorage — NOT synced via Y.Doc.
 */

import { useEffect, useRef, useState } from 'react'
import { Paintbrush, X } from 'lucide-react'
import { useStageBgColor } from '../state/useStageBgColor.js'

// Dark → light neutral greys. Endpoints approximate the theme defaults
// so that the "dark" / "light" swatches match the untinted backdrop in
// each colour scheme.
const SWATCHES = ['#0a0a0a', '#3a3a3a', '#7a7a7a', '#c8c8c8', '#eef0f2'] as const

export function StageBgPicker() {
  const { color, setColor } = useStageBgColor()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // Close on outside click + Escape.
  useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      if (rootRef.current === null) return
      if (e.target instanceof Node && rootRef.current.contains(e.target)) return
      setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    // Listen on capture so we win before the editor's backdrop handler.
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const pick = (c: string) => {
    setColor(c)
  }

  return (
    <div
      ref={rootRef}
      className="pointer-events-auto flex items-center gap-1 rounded-md border border-border bg-surface-1/80 p-1 shadow-sm backdrop-blur"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Stage color"
        aria-expanded={open}
        title="Stage color"
        className={
          'flex h-6 w-6 items-center justify-center rounded transition ' +
          (open
            ? 'bg-surface-2 text-foreground'
            : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground')
        }
      >
        <Paintbrush className="h-3.5 w-3.5" />
      </button>
      {open && (
        <>
          {SWATCHES.map((s) => {
            const active = color !== null && color.toLowerCase() === s
            return (
              <button
                key={s}
                type="button"
                onClick={() => pick(s)}
                aria-label={`Stage color ${s}`}
                title={s}
                className={
                  'h-5 w-5 rounded-full border transition ' +
                  (active
                    ? 'border-foreground shadow-[0_0_0_2px_hsl(var(--background))_inset]'
                    : 'border-border hover:border-border-strong')
                }
                style={{ background: s }}
              />
            )
          })}
          <button
            type="button"
            onClick={() => setColor(null)}
            disabled={color === null}
            aria-label="Reset to theme default"
            title="Reset to theme default"
            className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition hover:bg-surface-2 hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        </>
      )}
    </div>
  )
}
