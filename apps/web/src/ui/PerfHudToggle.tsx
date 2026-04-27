/**
 * ui/PerfHudToggle.tsx
 *
 * Bottom-left chrome button (next to the theme toggle) that opens
 * the live performance HUD. Same visual language as ThemeToggle —
 * single Lucide icon, ghost button, tooltip on hover.
 */

import { Activity } from 'lucide-react'
import { usePerfHud } from '../state/PerfHudContext.js'

export function PerfHudToggle() {
  const { enabled, toggle } = usePerfHud()
  const label = enabled ? 'Performance HUD on' : 'Performance HUD off'
  const nextLabel = enabled ? 'hide it' : 'show it'

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={enabled}
      aria-label={`${label}. Click to ${nextLabel}.`}
      title={`${label} — click to ${nextLabel}`}
      className={[
        'flex h-6 w-6 items-center justify-center rounded-md transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
        enabled
          ? 'bg-emerald-500/15 text-emerald-500 hover:bg-emerald-500/25'
          : 'text-muted-foreground/70 hover:bg-accent hover:text-foreground',
      ].join(' ')}
    >
      <Activity className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  )
}
