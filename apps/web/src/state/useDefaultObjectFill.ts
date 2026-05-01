/**
 * state/useDefaultObjectFill.ts
 *
 * Resolves a default fill / stroke / text color for newly-created
 * objects from the active folder palette. New shapes pick up the
 * folder's "Primary" color (by name match) as a TokenRef so future
 * folder palette changes propagate.
 *
 * Returns helpers that yield a partial spread you can merge into the
 * `init` argument of `createObjectOfType`.
 */

import { useFolderTokensOptional } from './FolderDocProvider.js'
import type { TokenRef } from '@narrative/slide-model'

export function useDefaultObjectFill(): {
  /** Token ref pointing at the folder's Primary color, or undefined. */
  primaryRef: TokenRef | undefined
  /** Spread for shape types that have a fill (rectangle, ellipse, polygon, …). */
  fillDefaults: { fill?: TokenRef }
  /** Spread for line/arrow types where the visible color is the stroke. */
  strokeDefaults: { stroke?: TokenRef }
  /** Spread for text objects where the visible color is `color`. */
  textColorDefaults: { color?: TokenRef }
} {
  const snapshot = useFolderTokensOptional()
  let primaryRef: TokenRef | undefined
  if (snapshot) {
    const primary = Object.values(snapshot.colors).find((c) => c.name === 'Primary')
    if (primary !== undefined) {
      primaryRef = { $token: `colors.${primary.id}` }
    }
  }
  return {
    primaryRef,
    fillDefaults: primaryRef !== undefined ? { fill: primaryRef } : {},
    strokeDefaults: primaryRef !== undefined ? { stroke: primaryRef } : {},
    textColorDefaults: primaryRef !== undefined ? { color: primaryRef } : {},
  }
}
