/**
 * state/readMasterDoc.ts
 *
 * M16 P6 — UI-side reader for a component master Y.Doc.
 *
 * The renderer agent owns `extractComponentSnapshot.ts` (renderer-tuned
 * snapshot with cached metadata + denormalized fields). This module is
 * scoped to the editor UI's two needs:
 *
 *   1. The "+ Add component" drawer: needs the master's bbox so the
 *      newly-inserted instance has the right initial size.
 *   2. The "Detach instance" command: needs a deep clone of the master's
 *      objects + animations (with stable id mapping) so we can stamp them
 *      onto the slide and remove the instance node.
 *
 * Both operations are read-only, run rarely (user-initiated), and don't
 * need the per-frame caching the renderer's snapshot extractor must do.
 *
 * Schema assumed (what slide-model `writeComponentMaster` writes):
 *   doc.getArray('slides')[0]:
 *     { id: 'master', objects: Y.Array<Y.Map>, animations: Y.Array<Y.Map> }
 */

import * as Y from 'yjs'
import type { SlideObject, AnimationStep } from '@narrative/shared'
import {
  acquireComponentDoc,
  releaseComponentDoc,
  getComponentDoc,
  subscribeToComponentDoc,
} from './componentDocCache.js'

export interface MasterBBox {
  x: number
  y: number
  width: number
  height: number
}

export interface MasterDocSnapshot {
  /** Plain-object copies of the master's leaf objects (groups expanded by yMapToPlainObject). */
  objects: SlideObject[]
  /** Plain-object copies of the master's animations array. */
  animations: AnimationStep[]
  /** Bounding box of all objects, computed from x/y/width/height. */
  bbox: MasterBBox
}

/**
 * Reads the master slide from a component Y.Doc and returns a serialisable
 * snapshot. Returns null when the doc is empty (sync hasn't landed yet).
 */
export function readMasterDoc(doc: Y.Doc): MasterDocSnapshot | null {
  const slides = doc.getArray<Y.Map<unknown>>('slides')
  if (slides.length === 0) return null

  // Find the master slide. `writeComponentMaster` always sets id='master'
  // on slot 0; defensively scan in case future code reorders.
  let master: Y.Map<unknown> | null = null
  for (let i = 0; i < slides.length; i++) {
    const s = slides.get(i)
    if (s.get('id') === 'master') {
      master = s
      break
    }
  }
  if (master === null) {
    // Fallback: take slot 0 — the master doc only ever has one slide.
    master = slides.get(0)
  }
  if (master === null) return null

  const objects: SlideObject[] = []
  const objectsArr = master.get('objects') as Y.Array<Y.Map<unknown>> | undefined
  if (objectsArr !== undefined) {
    for (let i = 0; i < objectsArr.length; i++) {
      try {
        // Deep-walk every value so the returned tree is fully plain JS.
        // The previous shallow yMapToPlainObject left nested Y.Map /
        // Y.Array / Y.Text references in place, which crashed
        // detach-instance: shoving a Y type that's already integrated
        // in the master doc into the slide doc tries to re-integrate
        // it → Yjs `_prelimContent === null` → `forEach` of null at
        // _YMap._integrate. Walking to plain (Y.Text → string) makes
        // detach + bbox readers safe under all object shapes.
        const plain = deepPlainFromYMap(objectsArr.get(i))
        if (typeof plain['type'] !== 'string') continue
        objects.push(plain as unknown as SlideObject)
      } catch {
        // Malformed object — skip rather than aborting the whole snapshot.
      }
    }
  }

  const animations: AnimationStep[] = []
  const animationsArr = master.get('animations') as Y.Array<Y.Map<unknown>> | undefined
  if (animationsArr !== undefined) {
    for (let i = 0; i < animationsArr.length; i++) {
      try {
        // Animation maps don't carry a SlideObject `type` discriminator, so
        // we can't reuse yMapToPlainObject (which requires it). Inline a
        // shallow Y.Map → plain object conversion. Animations are flat
        // structures (id, objectId, trigger, duration, easing, ...); no
        // nested Y.Arrays, so a shallow walk is sufficient.
        const yMap = animationsArr.get(i)
        const plain: Record<string, unknown> = {}
        for (const [k, v] of yMap.entries()) {
          plain[k] = v
        }
        animations.push(plain as unknown as AnimationStep)
      } catch {
        // skip
      }
    }
  }

  return { objects, animations, bbox: computeBBox(objects) }
}

/**
 * Recursive Y → plain conversion. Mirrors the local walker in
 * extractComponentSnapshot.ts; kept inline so this UI module doesn't
 * have to depend on the renderer-side snapshot extractor.
 *
 * Y.Text → string is intentional: Y.Text is a shared CRDT type and
 * cannot be re-attached to another doc. Detach reconstructs Y.Text
 * for text-object bodies on insert via addObject's string promotion.
 */
function deepPlainFromYMap(yMap: Y.Map<unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  yMap.forEach((v, k) => {
    out[k] = walkY(v)
  })
  return out
}

function walkY(value: unknown): unknown {
  if (value === null) return null
  if (typeof value !== 'object') return value
  if (value instanceof Y.Map) return deepPlainFromYMap(value)
  if (value instanceof Y.Array) {
    const out: unknown[] = []
    for (let i = 0; i < value.length; i++) out.push(walkY(value.get(i)))
    return out
  }
  if (value instanceof Y.Text) return value.toString()
  if (Array.isArray(value)) return value.map(walkY)
  // POJO — copy keys (defensive; legacy plain values pass through).
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = walkY(v)
  }
  return out
}

/**
 * Computes the axis-aligned bounding box of a flat list of objects with
 * x/y/width/height fields. Returns a zero-size box at origin for empty
 * input (callers should treat that as "use default size").
 */
export function computeBBox(objects: SlideObject[]): MasterBBox {
  if (objects.length === 0) return { x: 0, y: 0, width: 0, height: 0 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const o of objects) {
    minX = Math.min(minX, o.x)
    minY = Math.min(minY, o.y)
    maxX = Math.max(maxX, o.x + o.width)
    maxY = Math.max(maxY, o.y + o.height)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/**
 * Lower-level variant of {@link readMasterBbox} returning the full master
 * bbox (x, y, width, height). The picker insertion paths need {x, y} to
 * place the instance at the master's authored slide-space position; a
 * "reset position" button needs the same. Existing callers that only
 * cared about width/height kept the ergonomic {width, height} variant.
 */
export async function readMasterFullBbox(
  componentId: string,
  timeoutMs = 3000,
): Promise<MasterBBox | null> {
  acquireComponentDoc(componentId)
  try {
    const tryRead = (): MasterBBox | null => {
      const doc = getComponentDoc(componentId)
      if (doc === null) return null
      const snap = readMasterDoc(doc)
      if (snap === null) return null
      if (snap.bbox.width <= 0 || snap.bbox.height <= 0) return null
      return snap.bbox
    }
    const fast = tryRead()
    if (fast !== null) return fast
    return await new Promise<MasterBBox | null>((resolve) => {
      let settled = false
      const finish = (value: MasterBBox | null): void => {
        if (settled) return
        settled = true
        try {
          unsub()
        } catch {
          // ignore
        }
        window.clearTimeout(timer)
        resolve(value)
      }
      const unsub = subscribeToComponentDoc(componentId, () => {
        const bbox = tryRead()
        if (bbox !== null) finish(bbox)
      })
      const timer = window.setTimeout(() => finish(null), timeoutMs)
    })
  } finally {
    releaseComponentDoc(componentId)
  }
}

/**
 * Acquire a master doc and resolve to its bbox, awaiting first sync if
 * the doc hasn't yet received its initial state from the server. Used by
 * the picker insertion paths so the inserted instance carries the master's
 * native size on the *first* insert (before P9 the synchronous read fell
 * back to 400×300 because the cache was cold; second insert worked because
 * the linger window had retained the synced doc).
 *
 * Always releases its acquire pair, even on timeout / rejection. Callers
 * that need to keep the doc loaded should re-acquire after this resolves.
 *
 * Returns null on timeout when the doc never reaches a non-empty bbox —
 * the caller should fall back to a default size and the instance will
 * be re-fitted by the renderer once the master finally syncs.
 */
export async function readMasterBbox(
  componentId: string,
  timeoutMs = 3000,
): Promise<MasterBBox | null> {
  acquireComponentDoc(componentId)
  try {
    // Fast path — cache already warm from a sibling instance / prior insert.
    const tryRead = (): MasterBBox | null => {
      const doc = getComponentDoc(componentId)
      if (doc === null) return null
      const snap = readMasterDoc(doc)
      if (snap === null) return null
      if (snap.bbox.width <= 0 || snap.bbox.height <= 0) return null
      return snap.bbox
    }
    const fast = tryRead()
    if (fast !== null) return fast

    // Slow path — wait for the cache's listener to fire on first sync.
    return await new Promise<MasterBBox | null>((resolve) => {
      let settled = false
      const finish = (value: MasterBBox | null): void => {
        if (settled) return
        settled = true
        try {
          unsub()
        } catch {
          // ignore
        }
        window.clearTimeout(timer)
        resolve(value)
      }
      const unsub = subscribeToComponentDoc(componentId, () => {
        const bbox = tryRead()
        if (bbox !== null) finish(bbox)
      })
      const timer = window.setTimeout(() => finish(null), timeoutMs)
    })
  } finally {
    releaseComponentDoc(componentId)
  }
}
