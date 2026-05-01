/**
 * state/useDefaultObjectFill.ts
 *
 * Resolves a default fill / stroke / text color for newly-created
 * objects from the active folder palette. New shapes pick up the
 * folder's "Primary" color as a literal hex (not a TokenRef) so the
 * user can immediately edit the value with the color picker without
 * having to unlink first.
 */

import { useFolderTokensOptional } from './FolderDocProvider.js'

function hexToNumber(hex: string): number {
  const clean = hex.startsWith('#') ? hex.slice(1) : hex
  const n = Number.parseInt(clean, 16)
  return Number.isNaN(n) ? 0xffffff : n
}

export function useDefaultObjectFill(): {
  /** Folder Primary color as a 0xRRGGBB number, or undefined. */
  primaryHex: number | undefined
  /** Spread for shape types that have a fill (rectangle, ellipse, polygon, …). */
  fillDefaults: { fill?: number }
  /** Spread for line/arrow types where the visible color is the stroke. */
  strokeDefaults: { stroke?: number }
  /** Spread for text objects where the visible color is `color`. */
  textColorDefaults: { color?: number }
} {
  const snapshot = useFolderTokensOptional()
  let primaryHex: number | undefined
  if (snapshot) {
    const primary = Object.values(snapshot.colors).find((c) => c.name === 'Primary')
    if (primary !== undefined && typeof primary.value === 'string') {
      primaryHex = hexToNumber(primary.value)
    }
  }
  return {
    primaryHex,
    fillDefaults: primaryHex !== undefined ? { fill: primaryHex } : {},
    strokeDefaults: primaryHex !== undefined ? { stroke: primaryHex } : {},
    textColorDefaults: primaryHex !== undefined ? { color: primaryHex } : {},
  }
}
