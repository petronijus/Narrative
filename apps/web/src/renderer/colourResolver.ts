/**
 * renderer/colourResolver.ts
 *
 * M16 P2 — Bridge between React TokensContext and the non-React Pixi renderer.
 *
 * The renderer is a pure TS module (no React hooks) — it cannot call
 * `useTokensResolve()` directly.  Instead, the Canvas component installs a
 * resolver callback here after mounting, and the object renderers call
 * `resolveColour()` when they need to convert a `number | TokenRef` field
 * to a Pixi-compatible `number`.
 *
 * Lifecycle:
 *   - Canvas.tsx calls `setColourResolver(fn)` after mounting and on every
 *     token-snapshot change.
 *   - Canvas.tsx calls `setColourResolver(null)` on unmount.
 *
 * Fallback: when no resolver is installed (initial render, present mode
 * without a folder doc) `resolveColour` returns 0 for TokenRefs and passes
 * numbers through.  This is intentionally transparent black — objects that
 * reference an unresolved token appear "missing" rather than showing stale
 * colours.
 *
 * Note: this is the only legitimate per-module mutable state in the renderer.
 * It mirrors the pattern used by `imageFillLoader.ts` which also maintains
 * per-module cache state to bridge React ↔ Pixi boundaries.
 */

import { isTokenRef } from '@narrative/slide-model'
import type { TokenRef } from '@narrative/shared'

// ---------------------------------------------------------------------------
// Resolver singleton
// ---------------------------------------------------------------------------

type ColourResolverFn = (value: number | TokenRef | string | undefined | null) => string

let _resolver: ColourResolverFn | null = null

/**
 * Install (or remove) the token-to-colour resolver.
 * Called by Canvas.tsx after mounting and on every token-snapshot update.
 * Pass `null` to uninstall (e.g. on unmount).
 */
export function setColourResolver(fn: ColourResolverFn | null): void {
  _resolver = fn
}

// ---------------------------------------------------------------------------
// Public API used by object renderers
// ---------------------------------------------------------------------------

/**
 * Resolves a `number | TokenRef` colour field to a Pixi-compatible `number`.
 *
 * - If the value is already a `number`, it is returned as-is.
 * - If the value is a `TokenRef` and a resolver is installed, the resolver
 *   converts it to a CSS hex string which is then parsed to a number.
 * - If no resolver is installed or the ref is unresolved, returns 0.
 * - If the value is undefined/null, returns 0.
 *
 * CSS hex → number conversion: strips the leading `#` and parses as base-16.
 */
export function resolveColour(value: number | TokenRef | undefined | null): number {
  if (value === undefined || value === null) return 0
  if (typeof value === 'number') return value
  if (!isTokenRef(value)) return 0

  if (_resolver === null) return 0

  const css = _resolver(value)
  if (css === 'transparent') return 0
  // CSS hex string → number. Strip leading '#' and parse as hex int.
  const stripped = css.startsWith('#') ? css.slice(1) : css
  const parsed = parseInt(stripped, 16)
  return isNaN(parsed) ? 0 : parsed
}
