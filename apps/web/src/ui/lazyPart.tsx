/**
 * ui/lazyPart.tsx — a part of a page (a dialog, an overlay, a panel) whose
 * code loads after the page's first paint (docs/plans/performance.md → L2).
 *
 * Built on `lazyRoute`, so a part behaves like a route page when its chunk
 * fails: `RouteLoadError`, the route boundary's Retry / Reload card, and the
 * same cache-busting retry. What a part adds:
 *
 *   - **its own Suspense boundary.** A part suspending under the route's
 *     boundary would swap the whole editor for the "Loading editor" spinner.
 *     The fallback is `null` or a placeholder with the part's exact layout
 *     (the notes panel's frame), so nothing around it moves when it arrives;
 *   - **`preload()`**, for idle time or an intent (a hover, a shortcut), so
 *     the user's first use does not wait for the network. A part that was
 *     preloaded renders in the same commit, like an eager import;
 *   - **`lazyDialog`**: a dialog that is always rendered with an `open`
 *     prop loads on its first open (or a preload) instead of with the page,
 *     and stays mounted after that so its close animation still runs.
 */

import { Suspense, useState, type ComponentType } from 'react'
import { lazyRoute } from './lazyRoute.js'

/** A lazily loaded component that can be loaded ahead of time. */
export type LazyPart<P extends object> = ComponentType<P> & {
  /** Start loading the part's code (once); resolves when it arrived or failed. */
  preload(): Promise<void>
}

/**
 * A part loaded on its first render. `load` must be a literal `import('./…')`
 * so Vite splits the chunk; `pick` takes the named export. `Fallback`, if
 * given, renders with the part's props while the code is in flight — it must
 * take the part's space exactly, or the page shifts when the part arrives.
 */
export function lazyPart<M, P extends object>(
  load: () => Promise<M>,
  pick: (module: M) => ComponentType<P>,
  Fallback?: ComponentType<P>,
): LazyPart<P> {
  const Inner = lazyRoute(load, pick)
  function Part(props: P) {
    return (
      <Suspense fallback={Fallback !== undefined ? <Fallback {...props} /> : null}>
        <Inner {...props} />
      </Suspense>
    )
  }
  Part.preload = Inner.preload
  return Part
}

/**
 * A dialog rendered all the time with an `open` prop: nothing (no code, no
 * DOM) until it first opens, the dialog from then on. Opening it before the
 * preload finished shows it as soon as its code arrives.
 */
export function lazyDialog<M, P extends { open: boolean }>(
  load: () => Promise<M>,
  pick: (module: M) => ComponentType<P>,
): LazyPart<P> {
  const Inner = lazyPart(load, pick)
  function Dialog(props: P) {
    const [opened, setOpened] = useState(props.open)
    // Remember the first open during render (not in an effect): the dialog
    // mounts in the same commit the prop turned true.
    if (props.open && !opened) setOpened(true)
    return opened || props.open ? <Inner {...props} /> : null
  }
  Dialog.preload = Inner.preload
  return Dialog
}

/**
 * Preload `parts` once the browser is idle (or after `fallbackMs` where
 * `requestIdleCallback` is missing — Safari). Returns the cancel.
 */
export function preloadWhenIdle(
  parts: readonly { preload(): Promise<void> }[],
  fallbackMs = 1500,
): () => void {
  const run = () => {
    for (const part of parts) void part.preload()
  }
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(run, { timeout: 4000 })
    return () => window.cancelIdleCallback(id)
  }
  const id = window.setTimeout(run, fallbackMs)
  return () => window.clearTimeout(id)
}
