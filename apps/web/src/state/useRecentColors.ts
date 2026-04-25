/**
 * state/useRecentColors.ts
 *
 * P11: Ring-buffer of the last 12 distinct colors the user has picked in
 * any color input across the Inspector / StageBgPicker. Backed by
 * localStorage so the list survives page reloads and is shared across
 * tabs within the same browser.
 *
 * Colors are stored as 6-digit lowercase hex strings (#rrggbb).
 */

import { useCallback, useState } from 'react'

const STORAGE_KEY = 'narrative:recentColors'
const MAX_COLORS = 12

function readFromStorage(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((c): c is string => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c))
  } catch {
    return []
  }
}

function writeToStorage(colors: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(colors))
  } catch {
    // storage unavailable — silently ignore
  }
}

/**
 * Push a hex color into the ring buffer.
 * Deduplicates (moves existing entry to front), then trims to MAX_COLORS.
 * Returns the new array.
 */
function pushColor(current: string[], hex: string): string[] {
  const normalized = hex.toLowerCase()
  const filtered = current.filter((c) => c.toLowerCase() !== normalized)
  const next = [normalized, ...filtered].slice(0, MAX_COLORS)
  writeToStorage(next)
  return next
}

export interface UseRecentColorsReturn {
  /** Up to 12 recent colors as #rrggbb strings, most-recent first. */
  colors: string[]
  /**
   * Push a color into the recent list. Call this when the user commits
   * a color change (e.g. on input `change` or after the eyedropper picks).
   * Deduplicates automatically.
   */
  push: (hex: string) => void
}

/**
 * Hook — returns the current recent-colors list and a stable `push`
 * function. Each component instance reads from the same localStorage key;
 * changes made in one instance are NOT automatically reflected in other
 * mounted instances during the same render (cross-tab sync is out of scope).
 */
export function useRecentColors(): UseRecentColorsReturn {
  const [colors, setColors] = useState<string[]>(() => readFromStorage())

  const push = useCallback((hex: string) => {
    if (!/^#[0-9a-f]{6}$/i.test(hex)) return
    setColors((prev) => pushColor(prev, hex))
  }, [])

  return { colors, push }
}
