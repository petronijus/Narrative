/**
 * slide-model/src/stampComponent.ts
 *
 * Stamp a component master onto a slide as detached primitives.
 *
 * Components are no longer "instances" with live overrides — they're
 * a one-shot stamp: deep-clone every object in the master with fresh
 * ids, translate the cluster so its bbox top-left lands at `dropPoint`,
 * push into the slide's objects Y.Array, and walk away. After the stamp,
 * edits to the master have zero effect on the stamped output.
 *
 * Schema of a component master Y.Doc (mirrors extractComponentSnapshot):
 *   doc.getArray('slides') — Y.Array<Y.Map>, exactly one entry
 *     slides[0].objects     — Y.Array<Y.Map>  (master tree)
 */

import * as Y from 'yjs'
import { nanoid } from 'nanoid'
import type { SlideObject } from '@narrative/shared'
import { addObjects, type ObjectsMutationContext } from './mutations.js'

interface BBox {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Read all objects from a component master Y.Doc as plain JS values.
 * Recursively unwraps nested Y.Map / Y.Array / Y.Text — the same walk
 * extractComponentSnapshot does, kept local so this module has no app
 * dependency.
 */
function readMasterObjects(componentDoc: Y.Doc): SlideObject[] {
  const slides = componentDoc.getArray<Y.Map<unknown>>('slides')
  if (slides.length === 0) return []
  const slide = slides.get(0)
  if (slide === undefined) return []
  const objectsArr = slide.get('objects') as Y.Array<Y.Map<unknown>> | undefined
  if (objectsArr === undefined) return []

  const out: SlideObject[] = []
  for (let i = 0; i < objectsArr.length; i++) {
    try {
      const plain = walkYValue(objectsArr.get(i)) as SlideObject | null
      if (plain !== null && typeof plain === 'object' && typeof plain.type === 'string') {
        out.push(plain)
      }
    } catch {
      // Malformed object — skip
    }
  }
  return out
}

function walkYValue(value: unknown): unknown {
  if (value === null) return null
  if (typeof value !== 'object') return value
  if (value instanceof Y.Map) {
    const out: Record<string, unknown> = {}
    value.forEach((v, k) => {
      out[k] = walkYValue(v)
    })
    return out
  }
  if (value instanceof Y.Array) {
    const out: unknown[] = []
    for (let i = 0; i < value.length; i++) {
      out.push(walkYValue(value.get(i)))
    }
    return out
  }
  if (value instanceof Y.Text) return value.toString()
  if (Array.isArray(value)) return value.map(walkYValue)
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = walkYValue(v)
  }
  return out
}

function computeBBox(objects: ReadonlyArray<SlideObject>): BBox {
  if (objects.length === 0) return { x: 0, y: 0, width: 0, height: 0 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const obj of objects) {
    const x = typeof obj.x === 'number' ? obj.x : 0
    const y = typeof obj.y === 'number' ? obj.y : 0
    const w = typeof obj.width === 'number' ? obj.width : 0
    const h = typeof obj.height === 'number' ? obj.height : 0
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x + w > maxX) maxX = x + w
    if (y + h > maxY) maxY = y + h
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/**
 * Stamp a component master onto a slide as detached primitives.
 *
 * Reads the master Y.Doc, deep-clones every object with a fresh id,
 * translates the cloned cluster so its bbox top-left lands at
 * `dropPoint`, then pushes the new objects into the slide's `objects`
 * Y.Array. Returns the new ids in insertion order. The result has no
 * link to the component — editing the master afterwards never affects
 * already-stamped output.
 *
 * Group-id remap: objects with `groupId` matching another stamped
 * object's old id get rewritten to the new id, so group cohesion
 * survives the stamp without leaking into the master's id-space.
 */
export function stampComponent(
  ctx: ObjectsMutationContext,
  componentDoc: Y.Doc,
  dropPoint: { x: number; y: number },
): string[] {
  const masterObjects = readMasterObjects(componentDoc)
  if (masterObjects.length === 0) return []

  const bbox = computeBBox(masterObjects)
  const dx = dropPoint.x - bbox.x
  const dy = dropPoint.y - bbox.y

  // Build the old-id → new-id map up front so we can remap groupId
  // references on the second pass without ordering hazards.
  const idMap = new Map<string, string>()
  for (const obj of masterObjects) {
    if (typeof obj.id === 'string') {
      idMap.set(obj.id, nanoid())
    }
  }

  const stamped: SlideObject[] = masterObjects.map((obj) => {
    const oldId = obj.id
    const newId = (typeof oldId === 'string' ? idMap.get(oldId) : undefined) ?? nanoid()
    const x = typeof obj.x === 'number' ? obj.x + dx : dx
    const y = typeof obj.y === 'number' ? obj.y + dy : dy

    const clone: Record<string, unknown> = { ...(obj as unknown as Record<string, unknown>) }
    clone['id'] = newId
    clone['x'] = x
    clone['y'] = y

    // Remap groupId — preserve grouping among stamped siblings, drop
    // any reference that escapes the stamp (defensive; master should
    // never carry a foreign groupId).
    const groupId = clone['groupId']
    if (typeof groupId === 'string') {
      const remapped = idMap.get(groupId)
      if (remapped !== undefined) {
        clone['groupId'] = remapped
      } else {
        delete clone['groupId']
      }
    }

    return clone as unknown as SlideObject
  })

  addObjects(ctx, stamped)
  return stamped.map((o) => o.id)
}
