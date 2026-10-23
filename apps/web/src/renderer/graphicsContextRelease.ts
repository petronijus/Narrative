/**
 * renderer/graphicsContextRelease.ts — a Graphics destroyed with options
 * lets go of the context it made for itself (performance.md → E8).
 *
 * A `new Graphics()` creates its own GraphicsContext (`_ownedContext`), and
 * pixi.js 8's `Graphics.destroy(options)` destroys it only when called
 * with no options at all (`if (this._ownedContext && !options)`), or with
 * `context: true`. Destroying a tree — `container.destroy({ children: true })`,
 * which hands the same options to every child — therefore leaves every
 * Graphics' own context alive: still in its renderer's `_managedContexts`
 * (GraphicsContextSystem) with its GPU batches and buffers, held until
 * Pixi's GC unloads it a minute after its last draw, and for good where the
 * GC is off (present mode, Canvas.tsx `gc={false}`). Measured: an image
 * object (its placeholder and mask) left two contexts behind on every
 * slide switch — 386 more live contexts after 198 switches of the 100-slide
 * deck, never fewer (memory.slide.switch; heap snapshots).
 *
 * The rule here: when the Graphics still owns the context it made (nobody
 * took it with a shallow `clone()`, which drops the ownership), destroying
 * the Graphics destroys that context too, whatever the options — unless the
 * caller said `context: false`. Nothing in this app shares a context
 * between Graphics (no `new GraphicsContext()`, no `.context =`), so no
 * context still drawn elsewhere is destroyed. A small addition next to
 * Pixi's own destroy, not a copy of it; upstream it belongs in
 * `Graphics.destroy`.
 */

import { Graphics } from 'pixi.js'

const PATCHED = Symbol.for('narrative.graphicsOwnedContextRelease')

interface ContextLike {
  destroyed: boolean
  destroy(options?: unknown): void
}

interface GraphicsInternals {
  _ownedContext?: ContextLike | null
}

type DestroyFn = (this: Graphics, options?: unknown) => void

/** Install once per page (idempotent): every renderer's Graphics then release their own contexts. */
export function releaseOwnedGraphicsContexts(): void {
  const proto = (Graphics as { prototype?: unknown } | undefined)?.prototype as
    { destroy?: DestroyFn; [PATCHED]?: true } | undefined
  // A test's stand-in for pixi.js may have no Graphics class.
  if (proto === undefined || typeof proto.destroy !== 'function' || proto[PATCHED] === true) return
  const destroy: DestroyFn = proto.destroy
  proto.destroy = function (this: Graphics, options?: unknown): void {
    const owned = (this as unknown as GraphicsInternals)._ownedContext ?? null
    destroy.call(this, options)
    if (owned === null || owned.destroyed) return
    const keep =
      typeof options === 'object' &&
      options !== null &&
      (options as { context?: unknown }).context === false
    if (!keep) owned.destroy()
  }
  proto[PATCHED] = true
}
