/**
 * slide-model/src/mutations.ts
 *
 * Mutation API — všechny Yjs operace obaleny v doc.transact(fn, LOCAL_ORIGIN).
 * LOCAL_ORIGIN je Symbol importovatelný do UndoManageru pro filtrování.
 *
 * Konzumenti (editor-ui, test code) nesmí přistupovat k Y.Doc přímo —
 * všechny mutace jdou přes toto API.
 */

import * as Y from 'yjs'
import { nanoid } from 'nanoid'
import type { SlideObject, SlideObjectType, SlideObjectPatch, TableCell } from '@narrative/shared'
import {
  plainObjectToYMap,
  yMapToPlainObject,
  collectPendingCellTextInserts,
  type PendingCellTextInsert,
} from './bindings.js'
import { getObjectTypeDef } from './registry.js'
import { createTextValue, richAttrsAtIndex } from './richText.js'
import type { RichDeltaOp } from './richText.js'

/**
 * Symbol pro identifikaci lokálních user mutací.
 * UndoManager filtruje jen operace s tímto originem.
 * Remote changes (Hocuspocus v M4) budou mít jiný origin → nebudou undo-ovány.
 */
export const LOCAL_ORIGIN = Symbol('local-user')

/**
 * ObjectsMutationContext — context scoped to one slide's objects Y.Array.
 * Renamed from MutationContext in M9 for clarity.
 * Use getSlideObjectsCtx() from slides.ts to obtain from a deck context.
 */
export interface ObjectsMutationContext {
  doc: Y.Doc
  objects: Y.Array<Y.Map<unknown>>
}

/**
 * @deprecated Use ObjectsMutationContext. Alias kept for backward compat — removed in M10.
 */
export type MutationContext = ObjectsMutationContext

/**
 * Splice a Y.Text body: delete `removeLen` chars at `start`, then insert
 * `insertText` there, inheriting the formatting of the run at the insertion
 * point (so typing inside a bold word stays bold). Wrapped in one
 * `doc.transact` so the edit is a single atomic step.
 *
 * Moved out of `apps/web/src/ui/TextEditOverlay.tsx` (which spliced the Y.Text
 * inline) so the raw `Y.Text` mutation lives in slide-model per the "mutations
 * live here" invariant. `origin` is forwarded to `doc.transact` and defaults to
 * UNDEFINED — the contenteditable typing path intentionally uses no origin
 * (its own `localEditRef` flag suppresses the observer echo, not the origin),
 * so callers must opt in to LOCAL_ORIGIN if they want undo-tracking semantics.
 */
export function spliceRichText(
  doc: Y.Doc,
  yText: Y.Text,
  start: number,
  removeLen: number,
  insertText: string,
  origin?: unknown,
): void {
  doc.transact(() => {
    if (removeLen > 0) yText.delete(start, removeLen)
    if (insertText.length > 0) {
      const attrs = richAttrsAtIndex(yText, start)
      if (Object.keys(attrs).length > 0) {
        yText.insert(start, insertText, attrs)
      } else {
        yText.insert(start, insertText)
      }
    }
  }, origin)
}

/**
 * Přidá SlideObject do Y.Array.
 * Objekt musí mít platné id a type.
 */
export function addObject(ctx: ObjectsMutationContext, obj: SlideObject): void {
  // Text bodies are CRDT Y.Text values so collaborators can apply
  // inline formatting (italic / underline / fontWeight / color) on
  // ranges concurrently. Promote a plain string to Y.Text on insert.
  let prepared = obj

  // Paste path: an optional `_richTextOps` Quill-delta ride-along carries
  // inline formatting from the source text object (Y.Text isn't JSON-
  // serializable so the clipboard captures it as a delta). Strip the
  // marker before persisting and apply the delta after integration so
  // the Y.Text has a doc context.
  let richOps: RichDeltaOp[] | null = null
  const opsField = (obj as { _richTextOps?: unknown })._richTextOps
  if (Array.isArray(opsField)) {
    richOps = opsField as RichDeltaOp[]
    const { _richTextOps: _drop, ...rest } = obj as unknown as Record<string, unknown>
    void _drop
    prepared = rest as unknown as SlideObject
  }

  if (prepared.type === 'text') {
    const t = (prepared as { text: unknown }).text
    if (typeof t === 'string') {
      prepared = { ...prepared, text: createTextValue(t) } as SlideObject
    }
  }
  // Tables carry per-cell Y.Texts in deeply-nested Y.Arrays. Pending ops
  // on standalone Y.Texts don't fire when the cell Y.Text is integrated
  // indirectly through `row Y.Array → rows Y.Array → table Y.Map →
  // objects Y.Array`. Capture initial text strings here so we can apply
  // them via `yText.insert()` AFTER integration inside the same transact.
  let tablePendingInserts: PendingCellTextInsert[] = []
  if (prepared.type === 'table') {
    tablePendingInserts = collectPendingCellTextInserts(
      prepared as unknown as { rows: TableCell[][] },
    )
  }
  const yMap = plainObjectToYMap(prepared)
  ctx.doc.transact(() => {
    ctx.objects.push([yMap])
    if (richOps !== null) {
      const yt = yMap.get('text')
      if (yt instanceof Y.Text) {
        if (yt.length > 0) yt.delete(0, yt.length)
        // applyDelta replays the captured insert+attributes ops onto the
        // freshly-integrated Y.Text, restoring per-run italic/underline/
        // weight/color exactly as on the source.
        yt.applyDelta(
          richOps as unknown as Array<{
            insert: string
            attributes?: Record<string, unknown>
          }>,
        )
      }
    }
    applyPendingCellTextInserts(yMap, tablePendingInserts)
  }, LOCAL_ORIGIN)
}

/**
 * Odstraní objekt podle id z Y.Array.
 * Pokud id neexistuje, operace je no-op.
 */
export function removeObject(ctx: ObjectsMutationContext, id: string): void {
  ctx.doc.transact(() => {
    const idx = findIndexById(ctx.objects, id)
    if (idx !== -1) {
      ctx.objects.delete(idx, 1)
    }
  }, LOCAL_ORIGIN)
}

/**
 * Replace an object with a new one — possibly of another type — under the
 * same id and at the same place in the stacking order, in one transaction.
 * Everything that addresses the object by id (animation steps, Magic Move
 * pairing, a selection) keeps pointing at it. Used to turn a parametric
 * shape into an editable path.
 *
 * Text and table objects hold CRDT children (Y.Text); they are changed with
 * the dedicated mutations, never replaced, so this refuses them. Returns
 * false when no object has `next.id`.
 */
export function replaceObject(ctx: ObjectsMutationContext, next: SlideObject): boolean {
  if (next.type === 'text' || next.type === 'table') {
    throw new Error(`replaceObject: ${next.type} objects cannot be replaced wholesale`)
  }
  let replaced = false
  ctx.doc.transact(() => {
    const idx = findIndexById(ctx.objects, next.id)
    if (idx === -1) return
    const current = ctx.objects.get(idx).get('type')
    if (current === 'text' || current === 'table') {
      throw new Error(`replaceObject: ${String(current)} objects cannot be replaced wholesale`)
    }
    ctx.objects.delete(idx, 1)
    ctx.objects.insert(idx, [plainObjectToYMap(next)])
    replaced = true
  }, LOCAL_ORIGIN)
  return replaced
}

/**
 * Aktualizuje properties objektu. Patch může obsahovat libovolnou podmnožinu
 * properties (kromě id a type — ty jsou immutable).
 *
 * Pokud objekt s daným id neexistuje, operace je no-op.
 */
export function updateObject<T extends SlideObject>(
  ctx: ObjectsMutationContext,
  id: string,
  patch: SlideObjectPatch<T>,
): void {
  ctx.doc.transact(() => {
    const idx = findIndexById(ctx.objects, id)
    if (idx === -1) return

    const yMap = ctx.objects.get(idx)
    for (const [key, value] of Object.entries(patch)) {
      // Rich-text bodies need special handling: a `text` patch with a
      // plain string must REPLACE the existing Y.Text's contents in
      // place (preserving CRDT identity) rather than overwrite the
      // map slot. If the slot still holds a legacy plain string, this
      // is the lazy migration point — promote it to Y.Text.
      if (key === 'text' && typeof value === 'string') {
        const existing = yMap.get('text')
        if (existing instanceof Y.Text) {
          if (existing.length > 0) existing.delete(0, existing.length)
          if (value.length > 0) existing.insert(0, value)
          continue
        }
        yMap.set('text', createTextValue(value))
        continue
      }
      // P5b: explicit undefined ⇒ delete the key so optional schema fields
      // (stroke, strokeWidth, cornerRadius, …) don't persist as `undefined`
      // which would defeat `exactOptionalPropertyTypes` downstream.
      if (value === undefined) {
        yMap.delete(key)
      } else {
        yMap.set(key, value)
      }
    }
  }, LOCAL_ORIGIN)
}

/**
 * Vytvoří objekt daného typu s defaultProps z registry + volitelné overrides,
 * přidá ho do doc a vrátí plain object (s vygenerovaným id).
 *
 * @throws Pokud typ není registrován v registry.
 */
/**
 * Distributive Partial for a union — applies Partial<Omit<_, 'type'>> to each
 * union member. Without the distribution TypeScript would intersect the
 * variants and lose type-specific fields (e.g. ImageObject.assetId).
 */
type PerMemberPartial<T> = T extends unknown ? Partial<Omit<T, 'type'>> : never

export function createObjectOfType(
  ctx: ObjectsMutationContext,
  type: SlideObjectType,
  overrides?: PerMemberPartial<SlideObject>,
  /** The new object's id (default: a fresh nanoid); the caller makes sure the slide has no such object. */
  id: string = nanoid(),
): SlideObject {
  const def = getObjectTypeDef(type)
  if (def === undefined) {
    throw new Error(`createObjectOfType: type '${type}' is not registered`)
  }

  // defaultProps() vrací Omit<T, 'id' | 'type'> — cast je bezpečný
  const defaults = def.defaultProps() as Omit<SlideObject, 'id' | 'type'>
  const obj: SlideObject = {
    ...defaults,
    ...overrides,
    id,
    type,
  } as SlideObject

  addObject(ctx, obj)

  return obj
}

/**
 * Duplicate one object. Thin wrapper over {@link duplicateObjects}: the copy
 * gets a new id, is offset by `offset` (default 20/20 so it is visibly
 * separate) and lands on top of the z-order. A lone copy of a group member
 * does NOT join the source's group — see `duplicateObjects`.
 *
 * @returns the plain copy, or null when the source does not exist.
 */
export function duplicateObject(
  ctx: ObjectsMutationContext,
  id: string,
  offset: { x: number; y: number } = { x: 20, y: 20 },
): SlideObject | null {
  const [copy] = duplicateObjects(ctx, [id], offset)
  if (copy === undefined) {
    console.warn(`duplicateObject: object '${id}' not found`)
    return null
  }
  return copy
}

/**
 * Duplicate a set of objects in ONE transaction (one undo step).
 *
 * - Copies get fresh ids and are offset by `offset`; a cropped image's
 *   `imageRect` moves with its frame so the crop stays put relative to it.
 * - Copies are appended on top of the z-order, keeping the sources'
 *   relative stacking order (not the order of `ids`).
 * - Groups are remapped, never shared with the sources: every source group
 *   with two or more members in the set becomes ONE fresh group shared by
 *   those copies; a source group with a single member in the set yields an
 *   ungrouped copy (a group of one means nothing). Copying a group
 *   therefore produces an independent group, instead of silently growing
 *   the original one.
 * - Unknown ids are skipped.
 *
 * @returns the plain copies, in z-order.
 */
export function duplicateObjects(
  ctx: ObjectsMutationContext,
  ids: ReadonlyArray<string>,
  offset: { x: number; y: number } = { x: 20, y: 20 },
): SlideObject[] {
  return copyObjectsTo(ctx, ctx, ids, offset)
}

/**
 * Copy objects from one slide to another slide of the SAME document (or to
 * the same slide), on top of the target's stacking order, in the sources'
 * relative order, in one transaction. Same rules as {@link duplicateObjects}:
 * fresh ids, every property and rich text kept (tables' cell text too), a
 * crop moved with its frame by `offset`, a group copied whole becomes its
 * own new group and a lone member of a group comes out ungrouped.
 * Animations are not copied. Returns the copies in their new order.
 */
export function copyObjectsTo(
  from: ObjectsMutationContext,
  to: ObjectsMutationContext,
  ids: ReadonlyArray<string>,
  offset: { x: number; y: number } = { x: 0, y: 0 },
): SlideObject[] {
  if (from.doc !== to.doc) throw new Error('copyObjectsTo: both slides must be in one document')
  const ctx = to
  const wanted = new Set(ids)
  const sources: Y.Map<unknown>[] = []
  for (let i = 0; i < from.objects.length; i++) {
    const m = from.objects.get(i)
    if (wanted.has(m.get('id') as string)) sources.push(m)
  }
  if (sources.length === 0) return []

  const membersPerGroup = new Map<string, number>()
  for (const m of sources) {
    const g = m.get('groupId')
    if (typeof g === 'string' && g !== '') membersPerGroup.set(g, (membersPerGroup.get(g) ?? 0) + 1)
  }
  const groupRemap = new Map<string, string>()
  for (const [g, count] of membersPerGroup) {
    if (count >= 2) groupRemap.set(g, nanoid())
  }

  const prepared = sources.map((m) => buildDuplicateYMap(m, offset, groupRemap))
  const firstNewIndex = ctx.objects.length
  ctx.doc.transact(() => {
    ctx.objects.push(prepared.map((p) => p.yMap))
    for (const { yMap, richTextDeltas } of prepared) replayRichTextDeltas(yMap, richTextDeltas)
  }, LOCAL_ORIGIN)

  // yMapToPlainObject unfolds nested CRDT (table rows/cols/defaults) to the
  // plain SlideObject shape; a flat Object.fromEntries(entries()) would leak
  // live Y.Array/Y.Map handles for a duplicated table.
  const copies: SlideObject[] = []
  for (let i = firstNewIndex; i < ctx.objects.length; i++) {
    copies.push(yMapToPlainObject(ctx.objects.get(i)))
  }
  return copies
}

type RichTextDelta = ReturnType<Y.Text['toDelta']>

/**
 * Build a detached Y.Map copy of `source`. Any Yjs CRDT values (Y.Text /
 * Y.Map / Y.Array) are deep-CLONED — Yjs forbids the same CRDT instance
 * from living in two parents at once, and reusing an already-integrated
 * subtree blows up during _integrate. Y.Text deltas are captured so inline
 * formatting can be replayed after integration (toString() drops run
 * attributes, and a detached Y.Text cannot take a delta yet).
 */
function buildDuplicateYMap(
  source: Y.Map<unknown>,
  offset: { x: number; y: number },
  groupRemap: ReadonlyMap<string, string>,
): { yMap: Y.Map<unknown>; richTextDeltas: Array<{ path: string[]; delta: RichTextDelta }> } {
  const plain = Object.fromEntries(source.entries()) as Record<string, unknown>
  plain['id'] = nanoid()
  // Position is optional on some legacy records — only offset numeric
  // coords, otherwise `undefined + 20` would persist NaN.
  if (typeof plain['x'] === 'number') plain['x'] = plain['x'] + offset.x
  if (typeof plain['y'] === 'number') plain['y'] = plain['y'] + offset.y
  const shiftedCrop = shiftedImageRect(plain['imageRect'], offset.x, offset.y)
  if (shiftedCrop !== undefined) plain['imageRect'] = shiftedCrop
  const g = plain['groupId']
  if (typeof g === 'string' && g !== '') {
    const remapped = groupRemap.get(g)
    if (remapped === undefined) delete plain['groupId']
    else plain['groupId'] = remapped
  }

  const richTextDeltas: Array<{ path: string[]; delta: RichTextDelta }> = []
  const cloneYjsValue = (value: unknown, path: string[]): unknown => {
    if (value instanceof Y.Text) {
      richTextDeltas.push({ path, delta: value.toDelta() })
      return new Y.Text()
    }
    if (value instanceof Y.Map) {
      const m = new Y.Map<unknown>()
      for (const [k, v] of value.entries()) m.set(k, cloneYjsValue(v, [...path, k]))
      return m
    }
    if (value instanceof Y.Array) {
      const a = new Y.Array<unknown>()
      const items: unknown[] = []
      for (let i = 0; i < value.length; i++) {
        items.push(cloneYjsValue(value.get(i), [...path, String(i)]))
      }
      a.push(items)
      return a
    }
    return value
  }
  const yMap = new Y.Map<unknown>()
  for (const [key, value] of Object.entries(plain)) yMap.set(key, cloneYjsValue(value, [key]))
  return { yMap, richTextDeltas }
}

/** Walk a freshly-integrated copy to each cloned Y.Text and replay its delta. */
function replayRichTextDeltas(
  root: Y.Map<unknown>,
  deltas: ReadonlyArray<{ path: string[]; delta: RichTextDelta }>,
): void {
  for (const { path, delta } of deltas) {
    let cursor: unknown = root
    for (const seg of path) {
      if (cursor instanceof Y.Map) cursor = cursor.get(seg)
      else if (cursor instanceof Y.Array) cursor = cursor.get(Number(seg))
      else {
        cursor = undefined
        break
      }
    }
    if (cursor instanceof Y.Text) cursor.applyDelta(delta)
  }
}

/**
 * `imageRect` (the crop's source rect) is in ABSOLUTE slide coordinates, so
 * every translation of an image frame must move it by the same delta, or
 * the visible crop slides inside the frame. Returns undefined when there is
 * nothing to shift (no crop set).
 */
function shiftedImageRect(
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

/** Move an object's frame to (x, y), carrying its crop rect along. */
function setPositionCarryingCrop(yMap: Y.Map<unknown>, x: number, y: number): void {
  const oldX = (yMap.get('x') as number | undefined) ?? 0
  const oldY = (yMap.get('y') as number | undefined) ?? 0
  const dx = x - oldX
  const dy = y - oldY
  if (dx === 0 && dy === 0) return
  yMap.set('x', x)
  yMap.set('y', y)
  const shifted = shiftedImageRect(yMap.get('imageRect'), dx, dy)
  if (shifted !== undefined) yMap.set('imageRect', shifted)
}

/** One entry of {@link translateObjects}. */
export interface ObjectTranslation {
  id: string
  dx: number
  dy: number
}

/**
 * Move objects by a delta, in one transaction. This is THE way to move an
 * object: it carries a cropped image's absolute `imageRect` along with the
 * frame (a raw `{x, y}` patch leaves the crop behind). Unknown ids are
 * skipped; a zero delta is a no-op.
 */
export function translateObjects(
  ctx: ObjectsMutationContext,
  moves: ReadonlyArray<ObjectTranslation>,
): void {
  const effective = moves.filter((m) => m.dx !== 0 || m.dy !== 0)
  if (effective.length === 0) return
  ctx.doc.transact(() => {
    for (const { id, dx, dy } of effective) {
      const idx = findIndexById(ctx.objects, id)
      if (idx === -1) {
        console.warn(`translateObjects: object '${id}' not found, skipping`)
        continue
      }
      const m = ctx.objects.get(idx)
      const x = (m.get('x') as number | undefined) ?? 0
      const y = (m.get('y') as number | undefined) ?? 0
      setPositionCarryingCrop(m, x + dx, y + dy)
    }
  }, LOCAL_ORIGIN)
}

/**
 * Popis jedné položky v batch update.
 */
export interface BulkUpdate {
  id: string
  patch: SlideObjectPatch<SlideObject>
}

/**
 * Aplikuje více patch operací v jedné Yjs transakci.
 *
 * Výhoda: N updatů = 1 Yjs update (1 WS message místo N).
 * Při 60Hz group drag (20 objektů) → 60× méně network trafficu.
 *
 * - Pro neexistující id: warn + skip, ostatní pokračují.
 * - Empty updates: no-op, žádná transakce se neotvírá.
 */
export function bulkUpdateObjects(ctx: ObjectsMutationContext, updates: BulkUpdate[]): void {
  if (updates.length === 0) return

  ctx.doc.transact(() => {
    for (const { id, patch } of updates) {
      const idx = findIndexById(ctx.objects, id)
      if (idx === -1) {
        console.warn(`bulkUpdateObjects: object '${id}' not found, skipping`)
        continue
      }
      const yMap = ctx.objects.get(idx)
      for (const [key, value] of Object.entries(patch)) {
        // Mirror updateObject's special-casing so a batched patch can't
        // clobber CRDT identity. A `text` string must replace the existing
        // Y.Text contents in place (not overwrite the slot with a plain
        // string), and explicit undefined deletes the key.
        if (key === 'text' && typeof value === 'string') {
          const existing = yMap.get('text')
          if (existing instanceof Y.Text) {
            if (existing.length > 0) existing.delete(0, existing.length)
            if (value.length > 0) existing.insert(0, value)
          } else {
            yMap.set('text', createTextValue(value))
          }
          continue
        }
        if (value === undefined) {
          yMap.delete(key)
        } else {
          yMap.set(key, value)
        }
      }
    }
  }, LOCAL_ORIGIN)
}

// ---------------------------------------------------------------------------
// P6: layer order (z-order)
// ---------------------------------------------------------------------------

export type LayerMove = 'front' | 'back' | 'forward' | 'backward'

/**
 * Reorder objects in the Y.Array according to a layer-order intent.
 * Y.Array index 0 = back, last = front (matches SceneGraph reconciliation
 * walk that addChilds in order).
 *
 * `front`: move selected to the end. `back`: move to the start.
 * `forward`: each selected jumps past one unselected neighbour toward front.
 * `backward`: symmetric toward back.
 *
 * Multi-id semantics: selected objects keep their relative order; the group
 * moves as a block. For `forward` / `backward` the block shifts by one
 * position past the nearest unselected neighbour.
 */
export function moveObjectsLayer(
  ctx: ObjectsMutationContext,
  ids: ReadonlyArray<string>,
  move: LayerMove,
): void {
  if (ids.length === 0) return
  ctx.doc.transact(() => {
    const arr = ctx.objects
    const idSet = new Set(ids)
    const currentOrder: string[] = []
    for (let i = 0; i < arr.length; i++) {
      currentOrder.push(arr.get(i).get('id') as string)
    }
    const selected = currentOrder.filter((id) => idSet.has(id))
    const unselected = currentOrder.filter((id) => !idSet.has(id))
    if (selected.length === 0) return

    const firstSelectedOriginalIdx = currentOrder.findIndex((id) => idSet.has(id))
    const lastSelectedOriginalIdx = (() => {
      for (let i = currentOrder.length - 1; i >= 0; i--) {
        if (idSet.has(currentOrder[i]!)) return i
      }
      return -1
    })()
    const unselectedBeforeBlock = currentOrder
      .slice(0, firstSelectedOriginalIdx)
      .filter((id) => !idSet.has(id)).length

    let nextOrder: string[]
    if (move === 'front') {
      nextOrder = [...unselected, ...selected]
    } else if (move === 'back') {
      nextOrder = [...selected, ...unselected]
    } else if (move === 'forward') {
      if (lastSelectedOriginalIdx >= currentOrder.length - 1) return
      const insertAt = Math.min(unselected.length, unselectedBeforeBlock + 1)
      nextOrder = [...unselected.slice(0, insertAt), ...selected, ...unselected.slice(insertAt)]
    } else {
      if (firstSelectedOriginalIdx <= 0) return
      const insertAt = Math.max(0, unselectedBeforeBlock - 1)
      nextOrder = [...unselected.slice(0, insertAt), ...selected, ...unselected.slice(insertAt)]
    }

    applyReorderMinimal(arr, currentOrder, nextOrder)
  }, LOCAL_ORIGIN)
}

/**
 * Minimal-churn reorder of a Y.Array. Y.Array has no native `move`, so
 * any positional change is expressed as delete + insert (which creates
 * a new Y.Map — the moved item loses Y.Map identity). The trick is to
 * only do this for items whose INDEX actually changed, leaving every
 * unaffected Y.Map untouched.
 *
 * Algorithm: walk the target positions front-to-back; whenever the id
 * currently sitting at that position differs from the desired one, move
 * the desired id from its current location to here. After at most
 * `ids.length` passes the array matches `nextOrder` exactly.
 *
 * Why this matters for the layer UI: the previous "snapshot all + wipe
 * + refill" approach told every observer "every object was destroyed
 * and re-added". Hocuspocus propagated that too, Pixi tore down the
 * whole scene, TransformHandles looked at stale bounds, thumbnails
 * re-rendered mid-transaction, and the pointer handlers couldn't find
 * the selected id any more — user saw a frozen editor that needed a
 * refresh.
 */
function applyReorderMinimal(
  arr: Y.Array<Y.Map<unknown>>,
  currentOrder: string[],
  nextOrder: string[],
): void {
  let unchanged = nextOrder.length === currentOrder.length
  for (let i = 0; unchanged && i < currentOrder.length; i++) {
    if (nextOrder[i] !== currentOrder[i]) unchanged = false
  }
  if (unchanged) return

  const order = [...currentOrder]
  for (let targetIdx = 0; targetIdx < nextOrder.length; targetIdx++) {
    const desiredId = nextOrder[targetIdx]!
    if (order[targetIdx] === desiredId) continue
    const sourceIdx = order.indexOf(desiredId)
    if (sourceIdx === -1) continue

    // Snapshot the moving Y.Map. delete + insert creates a fresh
    // identity — the old Y.Map can't be re-inserted because every
    // shared-type subtree inside it (Y.Text runs, table rows, default
    // maps, …) would be a detached orphan once the parent is removed,
    // and Yjs crashes deep inside `typeListInsertGenerics` when asked
    // to re-integrate an orphan whose internal `_length` is null.
    //
    // `Y.Map.clone()` (Yjs 13.6+) returns a detached deep copy with
    // every nested AbstractType also cloned recursively, which is
    // exactly what we need — works uniformly for plain objects,
    // text-bearing shapes, and the table object's deeply nested
    // Y.Array<Y.Array<Y.Map<Y.Text>>> rows.
    const cloned = arr.get(sourceIdx).clone()
    arr.delete(sourceIdx, 1)

    // Keep our local `order` array in sync so subsequent iterations
    // compute correct indices.
    order.splice(sourceIdx, 1)
    order.splice(targetIdx, 0, desiredId)
    arr.insert(targetIdx, [cloned])
  }
}

/**
 * P6: move a single object to an explicit index in the Y.Array. Used by
 * the Layers panel drag + drop. `targetIndex` refers to the position in
 * the *new* array (so 0 = back, length-1 = front). The snapshot-refill
 * pattern mirrors moveObjectsLayer for CRDT correctness.
 */
export function moveObjectToIndex(
  ctx: ObjectsMutationContext,
  id: string,
  targetIndex: number,
): void {
  ctx.doc.transact(() => {
    const arr = ctx.objects
    const currentOrder: string[] = []
    for (let i = 0; i < arr.length; i++) {
      currentOrder.push(arr.get(i).get('id') as string)
    }
    const fromIdx = currentOrder.indexOf(id)
    if (fromIdx === -1) return
    const clamped = Math.max(0, Math.min(arr.length - 1, targetIndex))
    if (clamped === fromIdx) return
    const without = currentOrder.filter((x) => x !== id)
    const nextOrder = [...without.slice(0, clamped), id, ...without.slice(clamped)]
    applyReorderMinimal(arr, currentOrder, nextOrder)
  }, LOCAL_ORIGIN)
}

// ---------------------------------------------------------------------------
// P6: align + distribute
// ---------------------------------------------------------------------------

export type AlignAxis = 'left' | 'center-x' | 'right' | 'top' | 'center-y' | 'bottom'
export type DistributeAxis = 'horizontal' | 'vertical'

interface Rect {
  id: string
  x: number
  y: number
  width: number
  height: number
}

function readRect(yMap: Y.Map<unknown>): Rect {
  return {
    id: yMap.get('id') as string,
    x: (yMap.get('x') as number) ?? 0,
    y: (yMap.get('y') as number) ?? 0,
    width: (yMap.get('width') as number) ?? 0,
    height: (yMap.get('height') as number) ?? 0,
  }
}

/**
 * Align selected objects along an axis. Alignment uses the union bounding
 * box of the selection as the reference — "left" snaps every object's
 * left edge to the left edge of the union, "center-x" to its horizontal
 * midpoint, etc. Matches Figma / Keynote expectations.
 */
export function alignObjects(
  ctx: ObjectsMutationContext,
  ids: ReadonlyArray<string>,
  axis: AlignAxis,
): void {
  if (ids.length < 2) return
  ctx.doc.transact(() => {
    const rects: Rect[] = []
    for (let i = 0; i < ctx.objects.length; i++) {
      const m = ctx.objects.get(i)
      if (ids.includes(m.get('id') as string)) rects.push(readRect(m))
    }
    if (rects.length < 2) return

    const minX = Math.min(...rects.map((r) => r.x))
    const maxX = Math.max(...rects.map((r) => r.x + r.width))
    const minY = Math.min(...rects.map((r) => r.y))
    const maxY = Math.max(...rects.map((r) => r.y + r.height))
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2

    for (const r of rects) {
      const idx = findIndexById(ctx.objects, r.id)
      if (idx === -1) continue
      const m = ctx.objects.get(idx)
      switch (axis) {
        case 'left':
          setPositionCarryingCrop(m, minX, r.y)
          break
        case 'center-x':
          setPositionCarryingCrop(m, cx - r.width / 2, r.y)
          break
        case 'right':
          setPositionCarryingCrop(m, maxX - r.width, r.y)
          break
        case 'top':
          setPositionCarryingCrop(m, r.x, minY)
          break
        case 'center-y':
          setPositionCarryingCrop(m, r.x, cy - r.height / 2)
          break
        case 'bottom':
          setPositionCarryingCrop(m, r.x, maxY - r.height)
          break
      }
    }
  }, LOCAL_ORIGIN)
}

/**
 * Distribute >= 3 objects with even spacing between adjacent edges along
 * the chosen axis. End objects keep their positions; interior objects
 * shift so the gaps are uniform. Figma convention.
 */
export function distributeObjects(
  ctx: ObjectsMutationContext,
  ids: ReadonlyArray<string>,
  axis: DistributeAxis,
): void {
  if (ids.length < 3) return
  ctx.doc.transact(() => {
    const rects: Rect[] = []
    for (let i = 0; i < ctx.objects.length; i++) {
      const m = ctx.objects.get(i)
      if (ids.includes(m.get('id') as string)) rects.push(readRect(m))
    }
    if (rects.length < 3) return

    if (axis === 'horizontal') {
      rects.sort((a, b) => a.x - b.x)
      const first = rects[0]!
      const last = rects[rects.length - 1]!
      const totalSpan = last.x + last.width - first.x
      const sumWidths = rects.reduce((acc, r) => acc + r.width, 0)
      const gap = (totalSpan - sumWidths) / (rects.length - 1)
      let cursor = first.x
      for (const r of rects) {
        const idx = findIndexById(ctx.objects, r.id)
        if (idx === -1) continue
        setPositionCarryingCrop(ctx.objects.get(idx), cursor, r.y)
        cursor += r.width + gap
      }
    } else {
      rects.sort((a, b) => a.y - b.y)
      const first = rects[0]!
      const last = rects[rects.length - 1]!
      const totalSpan = last.y + last.height - first.y
      const sumHeights = rects.reduce((acc, r) => acc + r.height, 0)
      const gap = (totalSpan - sumHeights) / (rects.length - 1)
      let cursor = first.y
      for (const r of rects) {
        const idx = findIndexById(ctx.objects, r.id)
        if (idx === -1) continue
        setPositionCarryingCrop(ctx.objects.get(idx), r.x, cursor)
        cursor += r.height + gap
      }
    }
  }, LOCAL_ORIGIN)
}

// ---------------------------------------------------------------------------
// P6: group / ungroup
// ---------------------------------------------------------------------------

/**
 * Assign a fresh groupId to every selected object. Any prior groupId is
 * overwritten (no nested groups for now — Keynote-ish behaviour).
 */
export function groupObjects(ctx: ObjectsMutationContext, ids: ReadonlyArray<string>): string {
  const groupId = nanoid()
  if (ids.length === 0) return groupId
  ctx.doc.transact(() => {
    for (const id of ids) {
      const idx = findIndexById(ctx.objects, id)
      if (idx === -1) continue
      ctx.objects.get(idx).set('groupId', groupId)
    }
  }, LOCAL_ORIGIN)
  return groupId
}

/** Clear the groupId on every selected object. */
export function ungroupObjects(ctx: ObjectsMutationContext, ids: ReadonlyArray<string>): void {
  if (ids.length === 0) return
  ctx.doc.transact(() => {
    for (const id of ids) {
      const idx = findIndexById(ctx.objects, id)
      if (idx === -1) continue
      ctx.objects.get(idx).delete('groupId')
    }
  }, LOCAL_ORIGIN)
}

/**
 * Read the groupId of an object (helper for selection expansion — a
 * click on one group member should select the whole group).
 */
export function getGroupMembers(ctx: ObjectsMutationContext, id: string): string[] {
  const idx = findIndexById(ctx.objects, id)
  if (idx === -1) return [id]
  const groupId = ctx.objects.get(idx).get('groupId') as string | undefined
  if (groupId === undefined || groupId === '') return [id]
  const members: string[] = []
  for (let i = 0; i < ctx.objects.length; i++) {
    const m = ctx.objects.get(i)
    if ((m.get('groupId') as string | undefined) === groupId) {
      members.push(m.get('id') as string)
    }
  }
  return members
}

// ---------------------------------------------------------------------------
// P6: bulk clone (paste)
// ---------------------------------------------------------------------------

/**
 * Add a batch of plain SlideObject records to the Y.Array. Each entry
 * must have a fresh id (caller's responsibility — usually from the
 * clipboard helper that regenerates ids on paste). Stamped in one
 * transaction so a paste is one undo step.
 */
export function addObjects(ctx: ObjectsMutationContext, objects: ReadonlyArray<SlideObject>): void {
  if (objects.length === 0) return
  ctx.doc.transact(() => {
    for (const obj of objects) {
      // Promote text bodies from plain string → Y.Text, mirroring the
      // single-object addObject path. Without this, callers feeding
      // deeply-plain objects (e.g. component-instance detach reading
      // through readMasterDoc) lose CRDT semantics on the text field.
      let prepared = obj

      // Paste path — strip `_richTextOps` (Quill delta carrying inline
      // formatting) before persisting; we replay it onto the integrated
      // Y.Text below.
      let richOps: RichDeltaOp[] | null = null
      const opsField = (obj as { _richTextOps?: unknown })._richTextOps
      if (Array.isArray(opsField)) {
        richOps = opsField as RichDeltaOp[]
        const { _richTextOps: _drop, ...rest } = obj as unknown as Record<string, unknown>
        void _drop
        prepared = rest as unknown as SlideObject
      }

      if (prepared.type === 'text') {
        const t = (prepared as { text: unknown }).text
        if (typeof t === 'string') {
          prepared = { ...prepared, text: createTextValue(t) } as SlideObject
        }
      }
      // Tables: string cell texts become EMPTY Y.Texts in plainObjectToYMap
      // (deep-nested standalone Y.Text `_pending` ops don't survive
      // integration). Mirror addObject: capture them here and replay them
      // onto the integrated map below, inside this same transact.
      let tablePendingInserts: PendingCellTextInsert[] = []
      if (prepared.type === 'table') {
        tablePendingInserts = collectPendingCellTextInserts(
          prepared as unknown as { rows: TableCell[][] },
        )
      }
      const yMap = plainObjectToYMap(prepared)
      ctx.objects.push([yMap])
      if (richOps !== null) {
        const yt = yMap.get('text')
        if (yt instanceof Y.Text) {
          if (yt.length > 0) yt.delete(0, yt.length)
          yt.applyDelta(
            richOps as unknown as Array<{
              insert: string
              attributes?: Record<string, unknown>
            }>,
          )
        }
      }
      applyPendingCellTextInserts(yMap, tablePendingInserts)
    }
  }, LOCAL_ORIGIN)
}

// ---------------------------------------------------------------------------
// Interní helper
// ---------------------------------------------------------------------------

/**
 * Replay initial cell-text strings (collected via
 * collectPendingCellTextInserts BEFORE plainObjectToYMap) onto the
 * now-integrated table Y.Map. Must run inside the same transact() that
 * pushed the map — see bindings.ts buildTableCellYMap for why cell
 * texts need this two-phase init.
 */
function applyPendingCellTextInserts(yMap: Y.Map<unknown>, inserts: PendingCellTextInsert[]): void {
  if (inserts.length === 0) return
  const rowsY = yMap.get('rows') as Y.Array<Y.Array<Y.Map<unknown>>> | undefined
  if (rowsY === undefined) return
  for (const p of inserts) {
    const rowY = rowsY.get(p.r) as Y.Array<Y.Map<unknown>> | undefined
    if (rowY === undefined) continue
    const cellY = rowY.get(p.c) as Y.Map<unknown> | undefined
    if (cellY === undefined) continue
    const yt = cellY.get('text')
    if (yt instanceof Y.Text) yt.insert(0, p.initial)
  }
}

function findIndexById(objects: Y.Array<Y.Map<unknown>>, id: string): number {
  for (let i = 0; i < objects.length; i++) {
    const yMap = objects.get(i)
    if (yMap.get('id') === id) return i
  }
  return -1
}
