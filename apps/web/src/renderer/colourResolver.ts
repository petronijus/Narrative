/**
 * renderer/colourResolver.ts
 *
 * M16 P2 — Bridge between React TokensContext and the non-React Pixi renderer.
 *
 * The renderer is a pure TS module (no React hooks) — it cannot call
 * `useTokensResolve()` directly. Instead a React component installs a
 * resolver callback here, and the object renderers call `resolveColour()`
 * when they need to convert a `number | TokenRef` field to a Pixi-compatible
 * `number`.
 *
 * Lifecycle:
 *   - `ColourResolverInstaller` (components/FolderTokensBridge.tsx), mounted
 *     inside the folder's `TokensProvider` by DeckShell (editor + present)
 *     and by the component master editor, calls `setColourResolver(fn)` in
 *     an effect whenever the folder token snapshot changes: the empty
 *     placeholder first, then the folder document once it has synced, then
 *     again on every live token edit (another member changing the palette).
 *     It calls `setColourResolver(null)` once, on unmount.
 *   - The resolver is an INPUT of the render, like the slide's objects: an
 *     object painted before the folder's tokens arrived holds the fallback
 *     colour, and nothing in its Yjs data changes when they do. So every
 *     change is broadcast to `subscribeColourResolver` listeners with the
 *     previous and the next resolver:
 *       - `SceneGraph` (editor and present canvas) repaints the mounted
 *         objects whose token colours resolve differently under the two
 *         (`tokenColoursDiffer`), through each renderer's `repaintColours`;
 *       - `useSlideThumbnails` re-renders the thumbnails of the slides that
 *         hold such objects (the first one is uploaded as the deck preview).
 *   - The React effect ordering does not matter: an object mounted after the
 *     change resolves with the new resolver anyway.
 *
 * Fallback: when no resolver is installed (before the installer's first
 * effect, a canvas outside any folder) `resolveColour` returns 0 for
 * TokenRefs and passes numbers through. This is intentionally black —
 * objects that reference an unresolved token appear "missing" rather than
 * showing stale colours.
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

/** Where a colour is painted: the surface of the slide being drawn (A4.2d). */
export interface ColourContext {
  surface?: string
}

export type ColourResolverFn = (
  value: number | TokenRef | string | undefined | null,
  ctx?: ColourContext,
) => string

/** A change of the installed resolver, as `subscribeColourResolver` reports it. */
export interface ColourResolverChange {
  /** The resolver everything painted so far was resolved with. */
  prev: ColourResolverFn | null
  /** The resolver `resolveColour` uses from now on. */
  next: ColourResolverFn | null
}

type ColourResolverListener = (change: ColourResolverChange) => void

/** The resolver installed by the folder bridge (it knows the tokens and the deck's variant). */
let _base: ColourResolverFn | null = null
/** The surface of the slide the canvas shows (A4.2d), set by the canvas. */
let _surface: string | undefined = undefined
/** What `resolveColour` uses: the installed resolver bound to the surface. */
let _resolver: ColourResolverFn | null = null
const _listeners = new Set<ColourResolverListener>()

function bindSurface(
  base: ColourResolverFn | null,
  surface: string | undefined,
): ColourResolverFn | null {
  if (base === null) return null
  if (surface === undefined) return base
  return (value, ctx) => base(value, { surface, ...ctx })
}

function swap(next: ColourResolverFn | null): void {
  const change: ColourResolverChange = { prev: _resolver, next }
  _resolver = next
  // Snapshot: a listener may unsubscribe (a canvas unmounting) mid-loop.
  for (const listener of [..._listeners]) listener(change)
}

/**
 * Install (or remove) the token-to-colour resolver and tell every
 * subscriber, so what was painted with the previous one gets repainted.
 * Installing the resolver that is already installed is a no-op.
 * Pass `null` to uninstall (on unmount).
 */
export function setColourResolver(fn: ColourResolverFn | null): void {
  if (fn === _base) return
  _base = fn
  swap(bindSurface(fn, _surface))
}

/**
 * The surface of the slide the canvas shows (its layout's, A4.2d): colour
 * tokens with a value for it resolve to that value. A change repaints what
 * it affects, as a new resolver does.
 */
export function setRenderingSurface(surface: string | undefined): void {
  if (surface === _surface) return
  _surface = surface
  swap(bindSurface(_base, surface))
}

/**
 * Run `fn` resolving colours on `surface` without telling anyone: for a
 * renderer that paints another slide than the canvas shows (thumbnails),
 * whose colours are read while it mounts.
 */
export function withRenderingSurface<T>(surface: string | undefined, fn: () => T): T {
  const saved = _resolver
  _resolver = bindSurface(_base, surface)
  try {
    return fn()
  } finally {
    _resolver = saved
  }
}

/** The resolver `resolveColour` currently uses (null = none installed). */
export function getColourResolver(): ColourResolverFn | null {
  return _resolver
}

/**
 * Be told whenever the resolver changes. Returns the unsubscribe function.
 * Listeners run synchronously inside `setColourResolver`.
 */
export function subscribeColourResolver(listener: ColourResolverListener): () => void {
  _listeners.add(listener)
  return () => {
    _listeners.delete(listener)
  }
}

// ---------------------------------------------------------------------------
// Public API used by object renderers
// ---------------------------------------------------------------------------

/**
 * `resolveColour` against an explicit resolver instead of the installed one.
 * CSS hex → number conversion: strips the leading `#` and parses as base-16.
 */
export function resolveColourWith(
  resolver: ColourResolverFn | null,
  value: number | TokenRef | undefined | null,
): number {
  if (value === undefined || value === null) return 0
  if (typeof value === 'number') return value
  if (!isTokenRef(value)) return 0

  if (resolver === null) return 0

  const css = resolver(value)
  if (css === 'transparent') return 0
  // CSS hex string → number. Strip leading '#' and parse the colour's six
  // digits (a token may carry alpha as two more, A4.2d: `resolveAlpha`).
  const stripped = (css.startsWith('#') ? css.slice(1) : css).slice(0, 6)
  const parsed = parseInt(stripped, 16)
  return isNaN(parsed) ? 0 : parsed
}

/**
 * The alpha a colour token carries (`#rrggbbaa`, A4.2d), 0..1: 1 for a
 * literal colour, a token without alpha or an unresolved one. Renderers
 * multiply it into the field's own alpha.
 */
export function resolveAlphaWith(
  resolver: ColourResolverFn | null,
  value: number | TokenRef | undefined | null,
): number {
  if (value === undefined || value === null || typeof value === 'number') return 1
  if (!isTokenRef(value) || resolver === null) return 1
  const m = /^#?[0-9a-f]{6}([0-9a-f]{2})$/i.exec(resolver(value))
  return m === null ? 1 : Math.round((parseInt(m[1]!, 16) / 255) * 1000) / 1000
}

/** `resolveAlphaWith` against the installed resolver. */
export function resolveAlpha(value: number | TokenRef | undefined | null): number {
  return resolveAlphaWith(_resolver, value)
}

/**
 * Resolves a `number | TokenRef` colour field to a Pixi-compatible `number`.
 *
 * - If the value is already a `number`, it is returned as-is.
 * - If the value is a `TokenRef` and a resolver is installed, the resolver
 *   converts it to a CSS hex string which is then parsed to a number.
 * - If no resolver is installed or the ref is unresolved, returns 0.
 * - If the value is undefined/null, returns 0.
 */
export function resolveColour(value: number | TokenRef | undefined | null): number {
  return resolveColourWith(_resolver, value)
}

// ---------------------------------------------------------------------------
// Which objects a resolver change affects
// ---------------------------------------------------------------------------

/**
 * Whether any token colour reachable from `value` resolves differently under
 * `prev` and `next` — i.e. whether something painted from `value` with
 * `prev` is now stale.
 *
 * Walks plain objects and arrays (a slide object's own fields, a table's
 * `rows` / `defaults` / cell borders, a `shadow`), not class instances: a
 * `Y.Text` body holds no token refs (run colours are literal numbers).
 * Objects without a single token ref — most of a slide — answer false
 * without calling either resolver. Stops at the first difference.
 *
 * `options.skip` leaves out the named top-level fields — SceneGraph asks
 * about an object's `shadow` (filterEffects paints it) separately from the
 * rest (the object renderer paints that), so a token shadow alone does not
 * re-rasterise a text.
 */
export function tokenColoursDiffer(
  value: unknown,
  prev: ColourResolverFn | null,
  next: ColourResolverFn | null,
  options?: { skip?: readonly string[] },
): boolean {
  if (prev === next) return false
  const skip = options?.skip
  if (skip === undefined || skip.length === 0 || !isPlainRecord(value)) {
    return differs(value, prev, next)
  }
  for (const key in value) {
    if (skip.includes(key)) continue
    if (differs(value[key], prev, next)) return true
  }
  return false
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

function differs(
  value: unknown,
  prev: ColourResolverFn | null,
  next: ColourResolverFn | null,
): boolean {
  if (typeof value !== 'object' || value === null) return false
  if (isTokenRef(value))
    return (
      resolveColourWith(prev, value) !== resolveColourWith(next, value) ||
      resolveAlphaWith(prev, value) !== resolveAlphaWith(next, value)
    )
  if (Array.isArray(value)) {
    for (const item of value) if (differs(item, prev, next)) return true
    return false
  }
  if (!isPlainRecord(value)) return false
  for (const key in value) {
    if (differs(value[key], prev, next)) return true
  }
  return false
}
