/**
 * slide-model/src/tokens.ts
 *
 * M16 P2 — Design token resolver.
 *
 * Re-exports TokenRef + isTokenRef from @narrative/shared (where the type
 * widening on slide objects is defined) and adds:
 *   - Plain-JSON snapshot types for the folder Y.Doc token maps.
 *   - `resolveTokenValue(ref, snapshot)` — pure resolver.
 *
 * The resolver is dependency-free beyond @narrative/shared so it works in
 * the renderer, the inspector, and server-side code identically.
 *
 * Transitive resolution is capped at depth 2 to prevent cycles:
 *   textStyle.color may itself be a TokenRef into colors — we resolve once;
 *   we do NOT follow a colors entry that is also a TokenRef (which would be
 *   structurally invalid anyway, but we guard for safety).
 */

export type { TokenRef } from '@narrative/shared'
export { isTokenRef } from '@narrative/shared'

import type { TokenRef } from '@narrative/shared'
import { isTokenRef } from '@narrative/shared'

// ---------------------------------------------------------------------------
// Token snapshot types (plain JSON, not Yjs)
// These mirror the Y.Map layout in the folder Y.Doc.
// ---------------------------------------------------------------------------

export interface ColorTokenSnapshot {
  id: string
  name: string
  /** Hex string, e.g. `#ff0000`. */
  value: string
}

export interface TextStyleTokenSnapshot {
  id: string
  name: string
  family?: string
  weight?: number
  size?: number
  /**
   * The smallest size, in px, a box of this style may be shrunk to when its
   * autofit is `shrink` (A4.2); linked boxes carry it as `minFontSize`.
   */
  minSize?: number
  lineHeight?: number
  letterSpacing?: number
  /**
   * Colour for this text style.
   * May be a hex string or a TokenRef referencing a color token.
   */
  color?: string | TokenRef
  /** CSS text-transform — uppercase / lowercase / capitalize / none. */
  textTransform?: 'none' | 'uppercase' | 'lowercase' | 'capitalize'
  /** Vertical space inserted ABOVE each paragraph, in px. Default 0. */
  paragraphSpaceBefore?: number
  /** Vertical space inserted BELOW each paragraph, in px. Default 0. */
  paragraphSpaceAfter?: number
  /**
   * True for the seeded "minimum set" text styles (Title, Body, Caption…)
   * that ship with every new folder. Builtins guarantee that the editor
   * always has a "Body" style to seed new text objects from, so the UI
   * blocks deletion of these entries. Renaming / restyling is allowed.
   */
  builtin?: boolean
}

export interface EffectStyleTokenSnapshot {
  id: string
  name: string
  kind: 'shadow' | 'blur'
  params: Record<string, unknown>
}

export interface FolderTokensSnapshot {
  colors: Record<string, ColorTokenSnapshot>
  textStyles: Record<string, TextStyleTokenSnapshot>
  effectStyles: Record<string, EffectStyleTokenSnapshot>
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Resolves a `TokenRef` to a hex colour string, given a plain snapshot of
 * the folder tokens (as returned by `useFolderTokens()`).
 *
 * Resolution rules:
 * - `colors.<id>` → returns `token.value` (hex string).
 * - `textStyles.<id>` → returns the text style's `color` field, resolved
 *   transitively once.  If `color` is itself a `TokenRef` (depth 2), it is
 *   resolved from `colors` and returned.  Depth 3+ would require a cycle-
 *   prone walk — we simply return `null` for safety.
 * - `effectStyles` and unknown categories → return `null`.
 * - Missing token id → return `null`.
 *
 * @param ref     The TokenRef to resolve.
 * @param tokens  Plain JSON snapshot from `useFolderTokens()`.
 * @returns       A hex colour string (e.g. `"#ff0000"`) or `null`.
 */
export function resolveTokenValue(ref: TokenRef, tokens: FolderTokensSnapshot): string | null {
  const dotIdx = ref.$token.indexOf('.')
  if (dotIdx === -1) return null
  const category = ref.$token.slice(0, dotIdx)
  const id = ref.$token.slice(dotIdx + 1)
  if (!category || !id) return null

  // Own entries only: an id like "constructor" must not reach Object.prototype.
  if (category === 'colors') {
    if (!Object.hasOwn(tokens.colors, id)) return null
    return tokens.colors[id]!.value
  }

  if (category === 'textStyles') {
    if (!Object.hasOwn(tokens.textStyles, id)) return null
    const { color } = tokens.textStyles[id]!
    if (color === undefined) return null
    if (typeof color === 'string') return color
    // color is a TokenRef — resolve transitively (depth 2, no further recursion)
    if (isTokenRef(color)) {
      const innerDot = color.$token.indexOf('.')
      if (innerDot === -1) return null
      const innerCat = color.$token.slice(0, innerDot)
      const innerId = color.$token.slice(innerDot + 1)
      if (innerCat === 'colors') {
        return Object.hasOwn(tokens.colors, innerId) ? tokens.colors[innerId]!.value : null
      }
      // Transitive ref into non-colors — guard against cycles, return null.
      return null
    }
    return null
  }

  // effectStyles and unknown categories don't produce a colour value.
  return null
}
