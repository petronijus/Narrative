/**
 * renderer/pixiBindGroupPatch.ts
 *
 * Pixi v8 has a race that crashes the renderer during ordinary frames on
 * scenes with filters:
 *
 *   Cannot read properties of null (reading '2')
 *       at BindGroup.setResource
 *       at FilterSystem._applyFiltersToTexture
 *       at FilterSystem.pop
 *       at FilterPipe.execute
 *
 * Why it fires:
 *   `BindGroup.onResourceChange` calls `this.destroy()` whenever ANY
 *   resource it holds reports `destroyed === true`. `destroy()` sets
 *   `this.resources = null`. `FilterSystem` reuses
 *   `_globalFilterBindGroup` across frames, so if a texture referenced
 *   by the global filter bind group gets destroyed between frames
 *   (image-fill texture churn, filter swap, scene rebuild), the bind
 *   group self-destructs and the next frame crashes in `setResource`
 *   because `this.resources[index]` dereferences null.
 *
 * This module monkey-patches `BindGroup.prototype.setResource` to
 * detect the null-resources state and lazily re-initialise an empty
 * resources object before continuing. Equivalent to re-running the
 * constructor's one-liner without losing the BindGroup's identity —
 * the cheapest possible recovery and it keeps FilterSystem working
 * because its cached `_globalFilterBindGroup` reference stays valid.
 *
 * Install once at app bootstrap (Canvas.tsx, before Application.init).
 */

import { BindGroup } from 'pixi.js'

interface MutableBindGroupProto {
  setResource: (this: MutableBindGroupProto, resource: unknown, index: number) => void
  resources: Record<number, unknown> | null
}

let installed = false

export function installPixiBindGroupPatch(): void {
  if (installed) return
  installed = true

  const proto = BindGroup.prototype as unknown as MutableBindGroupProto
  const original = proto.setResource
  proto.setResource = function patchedSetResource(
    this: MutableBindGroupProto,
    resource: unknown,
    index: number,
  ): void {
    // Lazy re-init after a self-destruct triggered by a held resource
    // reporting `destroyed`. Keeps the BindGroup identity so every
    // holder (FilterSystem._globalFilterBindGroup especially) stays
    // valid across frames.
    if (this.resources === null) {
      this.resources = Object.create(null) as Record<number, unknown>
    }
    original.call(this, resource, index)
  }
}
