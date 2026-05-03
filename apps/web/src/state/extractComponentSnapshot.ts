/**
 * state/extractComponentSnapshot.ts
 *
 * M16 P6 — Reads a component master Y.Doc and produces a plain-object
 * snapshot the renderer can feed straight into the per-type renderer
 * registry.
 *
 * Schema (mirrors writeComponentMasterTree.ts):
 *   doc.getArray('slides') — Y.Array<Y.Map>, exactly one entry for components
 *     slides[0].objects     — Y.Array<Y.Map>  (master tree)
 *     slides[0].animations  — Y.Array<Y.Map>  (master animations)
 *
 * The walker is intentionally local rather than reusing
 * `packages/slide-model/src/bindings.ts:yMapToPlainObject` because that
 * helper is shallow — it only flattens top-level keys and leaves nested
 * Y.Map / Y.Array in place. A deep walker is needed so SlideObjects with
 * nested fields (gradient stops, group children, path points) hand back
 * fully plain JS values to the renderer.
 *
 * Memoisation:
 *   Each Y.Doc is keyed in a WeakMap by its current state vector. When the
 *   doc hasn't changed between calls, the cached snapshot is returned by
 *   reference — the renderer's diff against the previous snapshot then
 *   sees identity equality and short-circuits work.
 */

import * as Y from 'yjs'
import type { SlideObject, AnimationStep } from '@narrative/shared'

export interface ComponentBBox {
  x: number
  y: number
  width: number
  height: number
}

export interface ComponentSnapshot {
  objects: SlideObject[]
  animations: AnimationStep[]
  bbox: ComponentBBox
}

interface CacheRecord {
  /** Y.encodeStateVector result captured at extraction time. */
  stateVector: Uint8Array
  snapshot: ComponentSnapshot | null
}

const cache = new WeakMap<Y.Doc, CacheRecord>()

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Walk a component master doc into a plain-object snapshot. Returns null
 * when the doc has not yet received its first sync from the server (no
 * slides yet) — the renderer treats that as "keep the placeholder".
 */
export function extractComponentSnapshot(doc: Y.Doc): ComponentSnapshot | null {
  const sv = Y.encodeStateVector(doc)
  const cached = cache.get(doc)
  if (cached !== undefined && stateVectorsEqual(cached.stateVector, sv)) {
    return cached.snapshot
  }

  const snapshot = computeSnapshot(doc)
  cache.set(doc, { stateVector: sv, snapshot })
  return snapshot
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function stateVectorsEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function computeSnapshot(doc: Y.Doc): ComponentSnapshot | null {
  const slides = doc.getArray<Y.Map<unknown>>('slides')
  if (slides.length === 0) return null

  const slide = slides.get(0)
  if (slide === undefined) return null

  const objectsArr = slide.get('objects') as Y.Array<Y.Map<unknown>> | undefined
  const animationsArr = slide.get('animations') as Y.Array<Y.Map<unknown>> | undefined

  const objects: SlideObject[] = []
  if (objectsArr !== undefined) {
    for (let i = 0; i < objectsArr.length; i++) {
      try {
        const yMap = objectsArr.get(i)
        const plain = walkYValue(yMap) as SlideObject | null
        if (plain !== null && typeof plain === 'object' && typeof plain.type === 'string') {
          objects.push(plain)
        }
      } catch (err) {
        // Malformed object — skip rather than crash the whole instance.
        // Surface in dev so master corruption isn't invisible.
        if (import.meta.env['DEV']) {
          console.warn('[extractComponentSnapshot] skipping malformed object at index', i, err)
        }
      }
    }
  }

  const animations: AnimationStep[] = []
  if (animationsArr !== undefined) {
    for (let i = 0; i < animationsArr.length; i++) {
      try {
        const plain = walkYValue(animationsArr.get(i)) as AnimationStep | null
        if (plain !== null && typeof plain === 'object') {
          animations.push(plain)
        }
      } catch (err) {
        if (import.meta.env['DEV']) {
          console.warn(
            '[extractComponentSnapshot] skipping malformed animation step at index',
            i,
            err,
          )
        }
      }
    }
  }

  const bbox = computeBoundingBox(objects)
  return { objects, animations, bbox }
}

/**
 * Recursive Y.* → plain conversion.
 *   Y.Map  → Record<string, unknown>
 *   Y.Array → unknown[]
 *   Y.Text → its toString() (the renderer's text path re-wraps as needed)
 *   primitives → pass through
 *
 * Mirrors the inverse of `writeComponentMasterTree.ts:plainToYValue`.
 */
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
  if (value instanceof Y.Text) {
    return value.toString()
  }
  // Plain object / array (defensive — shouldn't happen given writer schema).
  if (Array.isArray(value)) {
    return value.map(walkYValue)
  }
  // Last-resort shallow copy of POJO keys.
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = walkYValue(v)
  }
  return out
}

function computeBoundingBox(objects: SlideObject[]): ComponentBBox {
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
