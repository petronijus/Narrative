/**
 * ui/ThemeToggle.tsx
 *
 * 3-state theme toggle (System → Light → Dark) that sits next to the
 * version chip at the bottom-left of every page.
 *
 * Icon reflects the CURRENT setting:
 *   - Monitor  = following system (auto)
 *   - Sun      = forced light
 *   - Moon     = forced dark
 *
 * Clicking cycles through the three. Hover reveals a tooltip so users
 * know what the next state will be.
 */

import { Monitor, Sun, Moon } from 'lucide-react'
import { useTheme, type ThemeMode } from '../state/ThemeContext.js'

const ICONS: Record<ThemeMode, typeof Monitor> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
}

const LABELS: Record<ThemeMode, string> = {
  system: 'System (follow OS)',
  light: 'Light',
  dark: 'Dark',
}

const NEXT: Record<ThemeMode, ThemeMode> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
}

export function ThemeToggle() {
  const { mode, cycle } = useTheme()
  const Icon = ICONS[mode]
  const label = LABELS[mode]
  const nextLabel = LABELS[NEXT[mode]]

  return (
    <button
      type="button"
      onClick={cycle}
      aria-label={`Theme: ${label}. Click to switch to ${nextLabel}.`}
      title={`Theme: ${label} — click for ${nextLabel}`}
      className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/70 hover:bg-accent hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  )
}
