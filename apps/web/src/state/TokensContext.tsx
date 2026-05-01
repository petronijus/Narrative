/**
 * state/TokensContext.tsx
 *
 * M16 P2 — Renderer-facing synchronous token resolver.
 *
 * Provides a `resolve(value): string` helper that accepts either a literal
 * hex colour (as a number or hex string) or a TokenRef, and returns a CSS hex
 * string suitable for Pixi.  Unresolved refs return `'transparent'` so the
 * renderer keeps painting without crashing.
 *
 * Wiring:
 *   - `TokensProvider` wraps the editor canvas tree. It subscribes to
 *     `FolderDocContext` for the live token snapshot and rebuilds the resolver
 *     on every change.
 *   - The renderer (reconciler / object renderers) calls `useTokensResolve()`
 *     to obtain the `resolve` function, then calls it per colour field at
 *     render time.
 *
 * Design notes:
 *   - The `resolve` function is stable between renders when the token snapshot
 *     hasn't changed (same reference equality on `tokens`).
 *   - Hex number colours (e.g. 0xff0000) are converted to `#rrggbb` format.
 *   - TokenRef strings are resolved via `resolveTokenValue`.
 *   - Fallback for unresolved: `'transparent'`.
 */

import { createContext, useContext, useMemo } from 'react'
import { isTokenRef, resolveTokenValue } from '@narrative/slide-model'
import type { TokenRef, FolderTokensSnapshot } from '@narrative/slide-model'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hexNumberToCss(n: number): string {
  return '#' + (n & 0xffffff).toString(16).padStart(6, '0')
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export type ResolveColour = (value: number | TokenRef | string | undefined | null) => string

export interface TokensContextValue {
  /**
   * Synchronously resolves a colour value to a CSS hex string.
   * - `number` → `#rrggbb`
   * - `string` (already hex) → returned as-is
   * - `TokenRef` → resolved from folder tokens, fallback `'transparent'`
   * - `undefined` / `null` → `'transparent'`
   */
  resolve: ResolveColour
}

const defaultResolve: ResolveColour = (value) => {
  if (value === undefined || value === null) return 'transparent'
  if (typeof value === 'number') return hexNumberToCss(value)
  if (typeof value === 'string') return value
  // TokenRef without a snapshot — return transparent
  return 'transparent'
}

export const TokensContext = createContext<TokensContextValue>({
  resolve: defaultResolve,
})

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

interface TokensProviderProps {
  tokens: FolderTokensSnapshot | null
  children: React.ReactNode
}

/**
 * Wraps children with a memoized resolver built from the current token snapshot.
 * If `tokens` is null (no folder doc available), the resolver falls back to
 * literal hex conversion and returns `'transparent'` for all TokenRefs.
 */
export function TokensProvider({ tokens, children }: TokensProviderProps) {
  const value = useMemo((): TokensContextValue => {
    const resolve: ResolveColour = (value) => {
      if (value === undefined || value === null) return 'transparent'
      if (typeof value === 'number') return hexNumberToCss(value)
      if (typeof value === 'string') return value
      if (isTokenRef(value)) {
        if (!tokens) return 'transparent'
        return resolveTokenValue(value, tokens) ?? 'transparent'
      }
      return 'transparent'
    }
    return { resolve }
  }, [tokens])

  return <TokensContext.Provider value={value}>{children}</TokensContext.Provider>
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Returns the synchronous colour resolver from the nearest TokensProvider.
 * Falls back to the default resolver (literal hex only) if not inside a provider.
 */
export function useTokensResolve(): ResolveColour {
  return useContext(TokensContext).resolve
}
