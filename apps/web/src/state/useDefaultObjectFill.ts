/**
 * state/useDefaultObjectFill.ts
 *
 * Resolves a default fill / stroke / text color for newly-created
 * objects from the active folder palette. New shapes pick up the
 * folder's "Primary" color as a literal hex (not a TokenRef) so the
 * user can immediately edit the value with the color picker without
 * having to unlink first.
 *
 * Text bodies are NOT auto-bound to any folder text style — new text
 * blocks start unlinked, with the registry defaults (black, system
 * font). The author opts into a preset (e.g. "Body") explicitly via
 * the Inspector's text-style picker.
 */

import { useFolderTokensOptional } from './FolderDocProvider.js'

function hexToNumber(hex: string): number {
  const clean = hex.startsWith('#') ? hex.slice(1) : hex
  const n = Number.parseInt(clean, 16)
  return Number.isNaN(n) ? 0xffffff : n
}

export interface TextDefaults {
  color?: number
  fontFamily?: string
  fontWeight?: number
  fontSize?: number
  lineHeight?: number
  letterSpacing?: number
  /** Vertical gap above each paragraph, in px. */
  paragraphSpaceBefore?: number
  /** Vertical gap below each paragraph, in px. */
  paragraphSpaceAfter?: number
  /** Visual case transform sourced from the linked text style. */
  textTransform?: 'none' | 'uppercase' | 'lowercase' | 'capitalize'
  /**
   * Folder text style id to link the new text object to. When set, the
   * Inspector's "Text style" preset shows the folder style by name
   * (e.g. "Body") instead of falling back to "Custom" — and edits to
   * the underlying token propagate to this object automatically.
   */
  textStyleId?: string
}

export function useDefaultObjectFill(): {
  /** Folder Primary color as a 0xRRGGBB number, or undefined. */
  primaryHex: number | undefined
  /** Spread for shape types that have a fill (rectangle, ellipse, polygon, …). */
  fillDefaults: { fill?: number }
  /** Spread for line/arrow types where the visible color is the stroke. */
  strokeDefaults: { stroke?: number }
  /**
   * Spread for text objects. Always just `color: black` — new text
   * starts unlinked from any folder text style.
   */
  textColorDefaults: TextDefaults
} {
  const snapshot = useFolderTokensOptional()
  let primaryHex: number | undefined
  if (snapshot) {
    const primary = Object.values(snapshot.colors).find((c) => c.name === 'Primary')
    if (primary !== undefined && typeof primary.value === 'string') {
      primaryHex = hexToNumber(primary.value)
    }
  }

  const textColorDefaults: TextDefaults = { color: 0x000000 }

  return {
    primaryHex,
    fillDefaults: primaryHex !== undefined ? { fill: primaryHex } : {},
    strokeDefaults: primaryHex !== undefined ? { stroke: primaryHex } : {},
    textColorDefaults,
  }
}
