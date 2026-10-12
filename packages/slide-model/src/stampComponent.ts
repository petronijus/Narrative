/**
 * slide-model/src/stampComponent.ts
 *
 * Stamp a component master onto a slide as detached primitives.
 *
 * Components are no longer "instances" with live overrides — they're
 * a one-shot stamp: deep-clone every object in the master with fresh
 * ids, translate the cluster so its bbox top-left lands at `dropPoint`,
 * push into the slide's objects Y.Array, and walk away. After the stamp,
 * edits to the master have no effect on the stamped output until
 * `restampComponent` (./restampComponent.ts) re-applies the master: every
 * stamped object records where it came from (`component`, A4.1).
 *
 * Schema of a component master Y.Doc (mirrors extractComponentSnapshot):
 *   doc.getArray('slides') — Y.Array<Y.Map>, exactly one entry
 *     slides[0].objects     — Y.Array<Y.Map>  (master tree)
 *     slides[0].animations  — Y.Array<Y.Map>  (NOT copied by a stamp — see
 *                             `stampComponent`)
 *
 * Rich text is lossless end to end: the master is read with every Y.Text
 * body captured as a `_richTextOps` delta (text objects and table cells),
 * and `insertObjectsWithRichText` — also used by `writeComponentMaster`,
 * the writer of a new master — replays those deltas onto the
 * freshly-integrated Y.Texts.
 */

import * as Y from 'yjs'
import { nanoid } from 'nanoid'
import type { AnimationStep, SlideObject, TableCell } from '@narrative/shared'
import { LOCAL_ORIGIN, type ObjectsMutationContext } from './mutations.js'
import { plainObjectToYMap } from './bindings.js'
import { animationStepToYMap } from './animationBindings.js'
import { RICH_TEXT_OPS_KEY, richTextOpsOf, type RichTextOps } from './components.js'

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
 * dependency. A Y.Text under key `text` (a text object's body, a table
 * cell's body) is read as its string PLUS a `_richTextOps` delta on the
 * same record, so no formatting is lost.
 */
export function readMasterObjects(componentDoc: Y.Doc): SlideObject[] {
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
      if (k === 'text' && v instanceof Y.Text) out[RICH_TEXT_OPS_KEY] = richTextOpsOf(v)
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

export function computeBBox(objects: ReadonlyArray<SlideObject>): BBox {
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
 * `dropPoint` (a crop, `imageRect`, moves with its frame), then pushes the
 * new objects into the slide's `objects` Y.Array. Returns the new ids in
 * insertion order. Editing the master afterwards never affects
 * already-stamped output by itself; every copy records its provenance —
 * `component: { id: componentId, objectId, instance, origin }`, one fresh
 * `instance` per stamp and `origin` where the master object stood — so
 * `restampComponent` can re-apply the master later. A master object's own
 * `component` (a master links to nothing) is never copied.
 *
 * Group-id remap — group cohesion survives the stamp without leaking into
 * the master's id-space, and two stamps of one component never share a
 * group:
 *   - a `groupId` equal to another stamped object's old id (legacy
 *     group-object model) is rewritten to that object's new id;
 *   - a group token (what `groupObjects` writes — a nanoid that is not an
 *     object id) shared by two or more stamped objects becomes ONE fresh
 *     token per stamp, shared by those copies (as `duplicateObjects` does);
 *   - anything else (a group of one, a foreign reference) is dropped.
 *
 * Rich text (inline runs + paragraph attributes) of text objects and
 * table cells is carried over exactly. The master's `animations` are
 * NOT stamped: the stamp copies objects only.
 *
 * One `doc.transact(..., LOCAL_ORIGIN)` → one undo step.
 */
export function stampComponent(
  ctx: ObjectsMutationContext,
  componentDoc: Y.Doc,
  dropPoint: { x: number; y: number },
  componentId: string,
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

  // Fresh token per multi-member group token, minted per stamp.
  const membersPerGroup = new Map<string, number>()
  for (const obj of masterObjects) {
    const g = (obj as { groupId?: unknown }).groupId
    if (typeof g === 'string' && g !== '') membersPerGroup.set(g, (membersPerGroup.get(g) ?? 0) + 1)
  }
  const tokenMap = new Map<string, string>()
  for (const [g, count] of membersPerGroup) {
    if (count >= 2 && !idMap.has(g)) tokenMap.set(g, nanoid())
  }

  const instance = nanoid()
  const stamped: SlideObject[] = masterObjects.map((obj) => {
    const oldId = obj.id
    const newId = (typeof oldId === 'string' ? idMap.get(oldId) : undefined) ?? nanoid()
    const x = typeof obj.x === 'number' ? obj.x + dx : dx
    const y = typeof obj.y === 'number' ? obj.y + dy : dy

    const clone: Record<string, unknown> = { ...(obj as unknown as Record<string, unknown>) }
    clone['id'] = newId
    clone['x'] = x
    clone['y'] = y
    const crop = shiftedCrop(clone['imageRect'], dx, dy)
    if (crop !== undefined) clone['imageRect'] = crop
    clone['component'] = {
      id: componentId,
      objectId: oldId,
      instance,
      origin: {
        x: typeof obj.x === 'number' ? obj.x : 0,
        y: typeof obj.y === 'number' ? obj.y : 0,
      },
    }

    // Remap groupId (rules in the doc comment above).
    const groupId = clone['groupId']
    if (typeof groupId === 'string') {
      const remapped = idMap.get(groupId) ?? tokenMap.get(groupId)
      if (remapped !== undefined) {
        clone['groupId'] = remapped
      } else {
        delete clone['groupId']
      }
    }

    return clone as unknown as SlideObject
  })

  insertObjectsWithRichText(ctx.objects, stamped, LOCAL_ORIGIN)
  return stamped.map((o) => o.id)
}

/**
 * `imageRect` (a crop's source rect) is in absolute slide coordinates: a
 * frame moved by (dx, dy) takes its crop along. Undefined when there is no
 * crop to move.
 */
export function shiftedCrop(
  rect: unknown,
  dx: number,
  dy: number,
): { x: number; y: number; width: number; height: number } | undefined {
  if (typeof rect !== 'object' || rect === null) return undefined
  const r = rect as { x?: unknown; y?: unknown; width?: unknown; height?: unknown }
  if (typeof r.x !== 'number' || typeof r.y !== 'number') return undefined
  if (typeof r.width !== 'number' || typeof r.height !== 'number') return undefined
  return { x: r.x + dx, y: r.y + dy, width: r.width, height: r.height }
}

// ---------------------------------------------------------------------------
// insertObjectsWithRichText — plain objects (+ rich-text deltas) → Y.Array
// ---------------------------------------------------------------------------

/** A body to write into a Y.Text once it is integrated. */
type BodyContent = RichTextOps | string

function isRichTextOps(v: unknown): v is RichTextOps {
  return (
    Array.isArray(v) &&
    v.every(
      (op) =>
        op !== null &&
        typeof op === 'object' &&
        (typeof (op as { insert?: unknown }).insert === 'string' ||
          (typeof (op as { insert?: unknown }).insert === 'object' &&
            (op as { insert?: unknown }).insert !== null)),
    )
  )
}

/**
 * Take the body of a record's `text` out of it: its `_richTextOps` delta
 * when present, else the Y.Text's own delta, else the plain string. Leaves
 * `text` set to `placeholder` and strips `_richTextOps` so the marker never
 * reaches the CRDT.
 */
function takeBody(rec: Record<string, unknown>, placeholder: unknown): BodyContent {
  const ops = rec[RICH_TEXT_OPS_KEY]
  delete rec[RICH_TEXT_OPS_KEY]
  const text = rec['text']
  rec['text'] = placeholder
  if (isRichTextOps(ops)) return ops
  if (text instanceof Y.Text) return richTextOpsOf(text)
  return typeof text === 'string' ? text : ''
}

function writeBody(target: unknown, content: BodyContent): void {
  if (!(target instanceof Y.Text)) return
  if (target.length > 0) target.delete(0, target.length)
  if (typeof content === 'string') {
    if (content.length > 0) target.insert(0, content)
    return
  }
  if (content.length > 0) target.applyDelta(content)
}

interface PreparedObject {
  yMap: Y.Map<unknown>
  /** Body of a text object's own `text`, or null for non-text objects. */
  body: BodyContent | null
  /** Bodies of table cells, by position. */
  cellBodies: Array<{ r: number; c: number; content: BodyContent }>
}

function prepareObject(obj: SlideObject): PreparedObject {
  const rec: Record<string, unknown> = { ...(obj as unknown as Record<string, unknown>) }
  let body: BodyContent | null = null
  const cellBodies: PreparedObject['cellBodies'] = []
  if (rec['type'] === 'text') {
    // Empty Y.Text now, content after integration (a prelim Y.Text can't
    // take a delta, and its pending ops don't survive nested integration).
    body = takeBody(rec, new Y.Text())
  } else {
    delete rec[RICH_TEXT_OPS_KEY]
  }
  if (rec['type'] === 'table' && Array.isArray(rec['rows'])) {
    // `plainObjectToYMap` gives every cell an EMPTY Y.Text for a string
    // `text` (see bindings.ts buildTableCellYMap); bodies are replayed
    // after integration — the same two-phase init as addObject.
    rec['rows'] = (rec['rows'] as TableCell[][]).map((row, r) =>
      row.map((cell, c) => {
        const cellRec: Record<string, unknown> = { ...(cell as unknown as Record<string, unknown>) }
        const content = takeBody(cellRec, '')
        if (content.length > 0) cellBodies.push({ r, c, content })
        return cellRec as unknown as TableCell
      }),
    )
  }
  return { yMap: plainObjectToYMap(rec as unknown as SlideObject), body, cellBodies }
}

function replayBodies(p: PreparedObject): void {
  if (p.body !== null) writeBody(p.yMap.get('text'), p.body)
  if (p.cellBodies.length === 0) return
  const rows = p.yMap.get('rows')
  if (!(rows instanceof Y.Array)) return
  for (const { r, c, content } of p.cellBodies) {
    const row = rows.get(r) as unknown
    if (!(row instanceof Y.Array)) continue
    const cell = row.get(c) as unknown
    if (cell instanceof Y.Map) writeBody(cell.get('text'), content)
  }
}

/**
 * Append plain SlideObjects to an INTEGRATED objects Y.Array, restoring
 * their rich text: a text object's body and every table cell's body are
 * written from the record's `_richTextOps` delta (RICH_TEXT_OPS_KEY) when
 * present — replayed with `applyDelta`, so inline runs and paragraph
 * attributes come back exactly — else from a Y.Text's own delta, else from
 * the plain string. `_richTextOps` markers never reach the CRDT.
 *
 * Built on the slide-model binding (`plainObjectToYMap`) plus the same
 * two-phase create-then-fill init `addObject` uses for table cells, all in
 * one `doc.transact(…, origin)` — joined into the caller's transaction
 * when called inside one.
 *
 * Appended on top of the stacking order, or inserted at `index` when given
 * (clamped to the array) — how `restampComponent` puts a replaced or added
 * object where it belongs.
 *
 * Used by `stampComponent`, `restampComponent` and `writeComponentMaster`.
 *
 * @throws when `objects` is not integrated into a Y.Doc.
 */
export function insertObjectsWithRichText(
  objects: Y.Array<Y.Map<unknown>>,
  plainObjects: ReadonlyArray<SlideObject>,
  origin?: unknown,
  index?: number,
): void {
  if (plainObjects.length === 0) return
  const doc = objects.doc
  if (doc === null) {
    throw new Error('insertObjectsWithRichText: the objects Y.Array must be integrated in a Y.Doc')
  }
  const prepared = plainObjects.map(prepareObject)
  doc.transact(() => {
    const maps = prepared.map((p) => p.yMap)
    if (index === undefined) objects.push(maps)
    else objects.insert(Math.max(0, Math.min(index, objects.length)), maps)
    for (const p of prepared) replayBodies(p)
  }, origin)
}

/** The id of a component master's one slide. */
export const COMPONENT_MASTER_SLIDE_ID = 'master'

/**
 * Write a new component master into `doc`, an empty component document:
 * the one slide (id {@link COMPONENT_MASTER_SLIDE_ID}) with `masterTree`
 * as its objects — rich text replayed from `_richTextOps` by
 * `insertObjectsWithRichText` — and `masterAnimations`. With an empty tree
 * it writes the empty master a new component starts from.
 *
 * A document that already has a slide is left alone and `false` returned:
 * a master is written once, never over what is there. One transaction,
 * joined into the caller's when called inside one.
 */
export function writeComponentMaster(
  doc: Y.Doc,
  masterTree: ReadonlyArray<SlideObject>,
  masterAnimations: ReadonlyArray<AnimationStep>,
  origin?: unknown,
): boolean {
  const slides = doc.getArray<Y.Map<unknown>>('slides')
  if (slides.length > 0) return false
  doc.transact(() => {
    const slide = new Y.Map<unknown>()
    slide.set('id', COMPONENT_MASTER_SLIDE_ID)
    slide.set('order', 0)
    const objects = new Y.Array<Y.Map<unknown>>()
    const animations = new Y.Array<Y.Map<unknown>>()
    slide.set('objects', objects)
    slide.set('animations', animations)
    // The slide is integrated first: rich-text bodies can only be filled
    // once their Y.Texts live in the document.
    slides.push([slide])
    insertObjectsWithRichText(objects, masterTree, origin)
    if (masterAnimations.length > 0) animations.push(masterAnimations.map(animationStepToYMap))
  }, origin)
  return true
}
