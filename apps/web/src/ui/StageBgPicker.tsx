/**
 * ui/StageBgPicker.tsx
 *
 * Tiny floating control in the editor stage corner. Lets the user pick
 * a custom colour for the area around the artboard — useful when slide
 * objects dragged outside the artboard would blend with the default
 * theme backdrop (e.g. black text on dark surround).
 *
 * State lives in localStorage via `useStageBgColor`. Not synced via Y.Doc.
 */

import { useRef } from 'react'
import { Paintbrush, X } from 'lucide-react'
import { useStageBgColor } from '../state/useStageBgColor.js'

export function StageBgPicker() {
  const { color, setColor } = useStageBgColor()
  const inputRef = useRef<HTMLInputElement>(null)

  const openPicker = () => {
    inputRef.current?.click()
  }

  return (
    <div
      className="pointer-events-auto flex items-center gap-1 rounded-md border border-border bg-surface-1/80 p-1 shadow-sm backdrop-blur"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={openPicker}
        className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition hover:bg-surface-2 hover:text-foreground"
        title="Stage color"
        aria-label="Pick stage background color"
      >
        <Paintbrush className="h-3.5 w-3.5" />
      </button>
      <div
        className="h-5 w-5 rounded border border-border"
        style={{ background: color ?? 'transparent' }}
        aria-hidden="true"
      />
      {color !== null && (
        <button
          type="button"
          onClick={() => setColor(null)}
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition hover:bg-surface-2 hover:text-foreground"
          title="Reset to theme default"
          aria-label="Reset stage color"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
      <input
        ref={inputRef}
        type="color"
        value={color ?? '#1a1d24'}
        onChange={(e) => setColor(e.target.value)}
        className="h-0 w-0 opacity-0"
        tabIndex={-1}
        aria-hidden="true"
      />
    </div>
  )
}
