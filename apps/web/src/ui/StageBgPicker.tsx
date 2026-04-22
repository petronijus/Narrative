/**
 * ui/StageBgPicker.tsx
 *
 * Local-only control for tinting the editor stage backdrop (area around
 * the artboard). Five neutral-grey presets from the theme dark to theme
 * light, with a reset back to the themed default. State lives in
 * localStorage — NOT synced via Y.Doc.
 */

import { X } from 'lucide-react'
import { useStageBgColor } from '../state/useStageBgColor.js'

// Dark → light neutral greys. Endpoints approximate the theme defaults
// so that the "dark" / "light" swatches match the untinted backdrop in
// each colour scheme.
const SWATCHES = ['#0a0a0a', '#3a3a3a', '#7a7a7a', '#c8c8c8', '#eef0f2'] as const

export function StageBgPicker() {
  const { color, setColor } = useStageBgColor()

  return (
    <div
      className="pointer-events-auto flex items-center gap-1 rounded-md border border-border bg-surface-1/80 p-1 shadow-sm backdrop-blur"
      onPointerDown={(e) => e.stopPropagation()}
    >
      {SWATCHES.map((s) => {
        const active = color !== null && color.toLowerCase() === s
        return (
          <button
            key={s}
            type="button"
            onClick={() => setColor(s)}
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
    </div>
  )
}
