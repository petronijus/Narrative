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

import type { ListNumberFormat, TokenRef } from '@narrative/shared'
import { isTokenRef } from '@narrative/shared'

// ---------------------------------------------------------------------------
// Token snapshot types (plain JSON, not Yjs)
// These mirror the Y.Map layout in the folder Y.Doc.
// ---------------------------------------------------------------------------

export interface ColorTokenSnapshot {
  id: string
  name: string
  /**
   * Hex string, e.g. `#ff0000`, or `#rrggbbaa` with alpha (A4.2d). The
   * colour wherever no variant or surface below applies.
   */
  value: string
  /**
   * Per deck variant (A4.2d, decided 2026-10-12): the value on each value
   * of one axis of the deck's variant (`DeckMeta.variant[axis]`) — one
   * "Text" token dark blue on New Horizon, white on Digital Cobalt.
   */
  byVariant?: { axis: string; values: Record<string, string> }
  /** Per slide surface (a layout's photo tone, a blue band): wins over the variant. */
  bySurface?: Record<string, string>
  /** Made by compiling a style pack (A4.4): which pack and which of its keys. */
  origin?: TokenOrigin
}

/** What made a token or master: a style pack's compile (A4.4), by pack id and key. */
export interface TokenOrigin {
  pack: string
  key: string
}

/** Where a colour is resolved: the deck's variant and the slide's surface (A4.2d). */
export interface TokenResolveContext {
  /** The deck's value per variant axis (`DeckMeta.variant`). */
  variant?: Readonly<Record<string, string>>
  /** The slide's surface (`Slide.layout.surface`). */
  surface?: string
}

/**
 * One nesting level of a text style (A4.2b): what a paragraph at that level
 * takes when it says nothing of its own. As `TextListLevel` on a box, with
 * colours as tokens store them (`#rrggbb` or a colour token reference);
 * linked boxes receive it as `listLevels`.
 */
export interface TextStyleLevel {
  list?: 'bullet' | 'number' | 'none'
  bulletChar?: string
  bulletColor?: string | TokenRef
  bulletScale?: number
  numberFormat?: ListNumberFormat
  indent?: number
  hanging?: number
  spaceBefore?: number
  fontFamily?: string
  fontWeight?: number
  fontSize?: number
  color?: string | TokenRef
  lineSpacing?: number
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
  /** Width, % of normal (`wdth`, A4.2c); linked boxes carry it as `fontStretch`. */
  fontStretch?: number
  lineHeight?: number
  /**
   * Line spacing as PowerPoint means it, × the font's own normal line
   * (A4.2e; Contoso 0.9, Fabrikam 1.1). Exclusive with `lineHeight`.
   */
  lineSpacing?: number
  /** Paragraph alignment of linked boxes (A4.2e). */
  align?: 'left' | 'center' | 'right'
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
  /** Per nesting level (index = paragraph level, ≤ 9): list defaults (A4.2b). */
  levels?: TextStyleLevel[]
  /** Made by compiling a style pack (A4.4). */
  origin?: TokenOrigin
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
export function resolveTokenValue(
  ref: TokenRef,
  tokens: FolderTokensSnapshot,
  ctx?: TokenResolveContext,
): string | null {
  const dotIdx = ref.$token.indexOf('.')
  if (dotIdx === -1) return null
  const category = ref.$token.slice(0, dotIdx)
  const id = ref.$token.slice(dotIdx + 1)
  if (!category || !id) return null

  // Own entries only: an id like "constructor" must not reach Object.prototype.
  if (category === 'colors') {
    if (!Object.hasOwn(tokens.colors, id)) return null
    return colorTokenValue(tokens.colors[id]!, ctx)
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
        return Object.hasOwn(tokens.colors, innerId)
          ? colorTokenValue(tokens.colors[innerId]!, ctx)
          : null
      }
      // Transitive ref into non-colors — guard against cycles, return null.
      return null
    }
    return null
  }

  // effectStyles and unknown categories don't produce a colour value.
  return null
}

/**
 * A colour token's value where it is used: the slide's surface's, else the
 * deck variant's on the token's axis, else its own value (A4.2d).
 */
export function colorTokenValue(token: ColorTokenSnapshot, ctx?: TokenResolveContext): string {
  const surface = ctx?.surface
  if (
    surface !== undefined &&
    token.bySurface !== undefined &&
    Object.hasOwn(token.bySurface, surface)
  )
    return token.bySurface[surface]!
  const by = token.byVariant
  const chosen = by !== undefined ? ctx?.variant?.[by.axis] : undefined
  if (by !== undefined && chosen !== undefined && Object.hasOwn(by.values, chosen))
    return by.values[chosen]!
  return token.value
}

/** Whether a colour token's value depends on where it is used (variant or surface). */
export function isContextualColor(token: ColorTokenSnapshot | undefined): boolean {
  return token !== undefined && (token.byVariant !== undefined || token.bySurface !== undefined)
}

/** `#rrggbb` / `#rrggbbaa` → the colour as 0xRRGGBB and its alpha 0..1; null when not a hex colour. */
export function parseHexColor(value: string): { color: number; alpha: number } | null {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value)
  if (m === null) return null
  return {
    color: parseInt(m[1]!, 16),
    alpha: m[2] === undefined ? 1 : Math.round((parseInt(m[2], 16) / 255) * 1000) / 1000,
  }
}
