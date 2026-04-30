/**
 * renderer/filterEffects.ts
 *
 * P5c: install / tune / remove a DropShadowFilter + BlurFilter on a Pixi
 * Container based on the object's `shadow` + `blur` schema fields. Called
 * from every object renderer's mount / update / applyPatch paths so the
 * behaviour is uniform across rect / ellipse / polygon / text / image.
 *
 * We re-use existing filter instances when possible — new BlurFilter /
 * DropShadowFilter allocations are non-trivial (shader compile, render
 * target) and getting hammered on every slider tick would visibly lag.
 */

import { BlurFilter, type Container, type Filter } from 'pixi.js'
import { DropShadowFilter } from 'pixi-filters'
import type { ShadowStyle } from '@narrative/shared'

interface FilterSlots {
  blur?: BlurFilter
  blurPx?: number
  shadow?: DropShadowFilter
  shadowData?: ShadowStyle
  /**
   * Pending rAF handle when filter install/update has been deferred.
   * Cancelled by destroyFilterEffects so teardown doesn't race with a
   * scheduled install targeting an already-destroyed container.
   */
  pendingFrame?: number
  /** The last (shadow, blur) target requested — applied on the scheduled frame. */
  pendingShadow?: ShadowStyle
  pendingShadowPresent?: boolean
  pendingBlurPx?: number
}

const FILTER_TAG = Symbol('filterSlots')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asAny = (n: Container): any => n

function getSlots(container: Container): FilterSlots {
  const existing = asAny(container)[FILTER_TAG] as FilterSlots | undefined
  if (existing !== undefined) return existing
  const fresh: FilterSlots = {}
  asAny(container)[FILTER_TAG] = fresh
  return fresh
}

function rebuildFilterList(container: Container): void {
  const slots = getSlots(container)
  const list: Filter[] = []
  if (slots.shadow !== undefined) list.push(slots.shadow)
  if (slots.blur !== undefined) list.push(slots.blur)
  container.filters = list.length > 0 ? list : null
}

/**
 * Install / update DropShadow + Blur filters on a container.
 *
 * Why this is deferred via requestAnimationFrame:
 * Attaching a filter during a container's mount — i.e. before the Pixi
 * renderer has rendered its first frame that includes this container —
 * intermittently crashes in `FilterSystem._applyFiltersToTexture` with
 * `BindGroup.setResource (reading '2')`. The renderer's filter pipeline
 * (renderTargetSystem + bindGroupSystem + filterSystem) warms its
 * internal state during the first render. If our mount path hands it a
 * filtered container before that warm-up finishes, the fallback
 * BindGroup has a null slot and the shader blow up on the first draw.
 *
 * Deferring the filter attachment until the NEXT rAF tick:
 *   1. Lets the first render go through without filters (plain scene),
 *      which warms the renderer.
 *   2. Attaches the filters right afterwards, at which point the
 *      bind-group layout is ready.
 *
 * Cost: one frame without shadow/blur on newly mounted objects. Totally
 * invisible to users. Not deferring is a crash.
 */
export function applyFilterEffects(
  container: Container,
  shadow: ShadowStyle | undefined,
  blur: number | undefined,
): void {
  const slots = getSlots(container)

  if (shadow !== undefined) {
    slots.pendingShadow = { ...shadow }
    slots.pendingShadowPresent = true
  } else {
    slots.pendingShadowPresent = false
  }
  slots.pendingBlurPx = blur ?? 0

  if (slots.pendingFrame !== undefined) return

  slots.pendingFrame = requestAnimationFrame(() => {
    delete slots.pendingFrame
    const nextShadow = slots.pendingShadowPresent ? slots.pendingShadow : undefined
    const nextBlur = slots.pendingBlurPx
    installFilterEffectsNow(container, nextShadow, nextBlur)
  })
}

function installFilterEffectsNow(
  container: Container,
  shadow: ShadowStyle | undefined,
  blur: number | undefined,
): void {
  if (container.destroyed) return
  const slots = getSlots(container)

  // Always replace filter instances instead of mutating existing ones —
  // Pixi v8's filter pipeline caches bind-group layouts against a
  // filter's identity; mutating `.color` / `.blur` / `.offset` on a
  // live instance desyncs those bind groups and the next render crashes
  // in BindGroup.setResource. Allocating a fresh filter is cheap.
  const shadowChanged = shadowStyleDifferent(slots.shadowData, shadow)
  const blurChanged =
    slots.blurPx !== (blur ?? 0) || (blur === undefined) !== (slots.blur === undefined)

  if (shadowChanged) {
    if (slots.shadow !== undefined) {
      slots.shadow.destroy()
      delete slots.shadow
      delete slots.shadowData
    }
    if (shadow !== undefined) {
      const blurPx = Math.max(0, shadow.blur)
      const filter = new DropShadowFilter({
        color: shadow.color,
        alpha: shadow.opacity,
        blur: blurPx,
        offset: { x: shadow.offsetX, y: shadow.offsetY },
        // `quality` = number of blur passes. 4 already gives a clean
        // gaussian for small blurs; for very wide blurs the kernel
        // hits its sample limit and the shadow looks chunky / banded.
        // Bumping to 6 above blur ~24 px doubles the effective kernel
        // without exploding cost (still O(quality * width)).
        quality: blurPx > 24 ? 6 : 4,
      })
      // Render the filter at the device's native resolution so the
      // shadow's blurred texture isn't 1:1-sampled then upscaled by
      // the canvas — the upsample is what makes big shadows look
      // pixelated. Cap at 2 so a 3x DPR display doesn't quadruple
      // the texture cost for marginal visual gain.
      filter.resolution = Math.min(2, window.devicePixelRatio || 1)
      slots.shadow = filter
      slots.shadowData = { ...shadow }
    }
  }

  if (blurChanged) {
    if (slots.blur !== undefined) {
      slots.blur.destroy()
      delete slots.blur
      delete slots.blurPx
    }
    const blurPx = blur ?? 0
    if (blurPx > 0) {
      const filter = new BlurFilter({
        strength: blurPx,
        quality: blurPx > 24 ? 6 : 4,
      })
      filter.resolution = Math.min(2, window.devicePixelRatio || 1)
      slots.blur = filter
      slots.blurPx = blurPx
    }
  }

  if (shadowChanged || blurChanged) rebuildFilterList(container)
}

function shadowStyleDifferent(a: ShadowStyle | undefined, b: ShadowStyle | undefined): boolean {
  if (a === b) return false
  if (a === undefined || b === undefined) return true
  return (
    a.color !== b.color ||
    a.blur !== b.blur ||
    a.offsetX !== b.offsetX ||
    a.offsetY !== b.offsetY ||
    a.opacity !== b.opacity
  )
}

/**
 * Patch variant — apply only the fields that appear in the patch, keep the
 * untouched filter slot as-is. Handy for renderers whose `applyPatch` path
 * doesn't cache the full object data on the container.
 */
export function patchFilterEffects(
  container: Container,
  hasShadowKey: boolean,
  nextShadow: ShadowStyle | undefined,
  hasBlurKey: boolean,
  nextBlur: number | undefined,
): void {
  const slots = getSlots(container)
  applyFilterEffects(
    container,
    hasShadowKey ? nextShadow : slots.shadowData,
    hasBlurKey ? nextBlur : slots.blurPx,
  )
}

/**
 * Strip filter instances from a container tree. Used by the thumbnail
 * renderer: DropShadowFilter + BlurFilter crash Pixi's offscreen render
 * path ("Cannot read properties of null (reading '2')" inside
 * FilterSystem._applyFiltersToTexture) because the filters assume the
 * main renderer's bind-group layout. Thumbnails trade fidelity (no shadow
 * / blur) for a render that actually completes.
 */
export function stripFilterEffectsTree(container: Container): void {
  if (container.filters !== null) container.filters = null
  for (const child of container.children) {
    stripFilterEffectsTree(child as Container)
  }
}

export function destroyFilterEffects(container: Container): void {
  const slots = asAny(container)[FILTER_TAG] as FilterSlots | undefined
  if (slots === undefined) return
  if (slots.pendingFrame !== undefined) {
    cancelAnimationFrame(slots.pendingFrame)
    delete slots.pendingFrame
  }
  slots.shadow?.destroy()
  slots.blur?.destroy()
  delete asAny(container)[FILTER_TAG]
  container.filters = null
}
