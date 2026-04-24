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

export function applyFilterEffects(
  container: Container,
  shadow: ShadowStyle | undefined,
  blur: number | undefined,
): void {
  const slots = getSlots(container)

  // P5c: always replace filter instances instead of mutating existing ones.
  // Pixi v8's filter pipeline caches bind-group layouts against a filter's
  // identity; mutating `.color` / `.blur` / `.offset` on a live instance
  // desyncs those bind groups and the next render crashes in
  // BindGroup.setResource with a null deref. Allocating a fresh filter is
  // cheap compared to the uniform-update bug.
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
      slots.shadow = new DropShadowFilter({
        color: shadow.color,
        alpha: shadow.opacity,
        blur: Math.max(0, shadow.blur),
        offset: { x: shadow.offsetX, y: shadow.offsetY },
        quality: 4,
      })
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
      slots.blur = new BlurFilter({ strength: blurPx, quality: 4 })
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
  slots.shadow?.destroy()
  slots.blur?.destroy()
  delete asAny(container)[FILTER_TAG]
  container.filters = null
}
