/**
 * slide-model/src/restampComponent.ts
 *
 * Re-apply a component's current master to the stamps of it on one slide
 * (A4.1, `component.restamp`). A stamp is found by its objects' provenance
 * (`component: { id, objectId, instance, origin }`, written by
 * `stampComponent`); each `instance` is one stamp and is restamped on its
 * own.
 *
 * Per stamp:
 *   - an object whose master object still exists is updated IN PLACE, its
 *     id and stacking position kept (slide animations and Magic Move pair by
 *     id): every field from the master, placed at the stamp's offset, the
 *     master's groups remapped to the stamp's own tokens — except slot
 *     content. A text slot keeps its body (the caller re-applies the master's
 *     formatting to it, the way `component.stamp` fills a slot — reported in
 *     `textSlots`); a picture slot keeps its picture (its crop carried to the
 *     new frame, scaled with it); a table slot keeps its cells, its grid and
 *     the size the grid adds up to, its styling coming from the master.
 *     `origin` is brought up to date.
 *   - a master object the stamp has no copy of is added, in master order —
 *     one new in the master, one a person deleted from the stamp, one a
 *     partial copy never had: a restamp resets the stamp to its master;
 *   - an object whose master object is gone is deleted, with every
 *     animation step that targets it.
 *
 * The stamp's offset is `object.x − origin.x` (and y): a stamp people moved
 * is restamped where they put it. Objects of one stamp normally share it;
 * when one was nudged on its own, the offset most of them share wins (ties:
 * the earliest in master order), and the nudged one goes back into place
 * with every other master field.
 *
 * Groups: a stamp keeps its own token for a master group when that token
 * groups nothing but the stamp's copies of that group, else it gets a fresh
 * one; an object the master leaves ungrouped keeps a group a person made with
 * objects outside the stamp.
 *
 * Slots are the master objects' `slot ?? name`, as `component.stamp` fills
 * them. One `doc.transact(…, LOCAL_ORIGIN)` → one undo step (joined into the
 * caller's transaction when called inside one).
 */

import * as Y from 'yjs'
import { nanoid } from 'nanoid'
import type { SlideObject } from '@narrative/shared'
import { LOCAL_ORIGIN, type ObjectsMutationContext } from './mutations.js'
import { removeAnimation, type AnimationsMutationContext } from './animationMutations.js'
import { RICH_TEXT_OPS_KEY, richTextOpsOf, type RichTextOps } from './components.js'
import { insertObjectsWithRichText, readMasterObjects, shiftedCrop } from './stampComponent.js'
import { yMapToPlainObject } from './bindings.js'

/** What restamping one stamp did. */
export interface RestampedStamp {
  /** The stamp's `component.instance`. */
  instance: string
  /** Objects updated in place (ids kept), in stacking order. */
  updated: string[]
  /**
   * Objects restored for master objects the stamp had no copy of — new in the
   * master, deleted from the stamp, or never copied — in master order.
   */
  added: string[]
  /** Objects deleted because their master object is gone. */
  removed: string[]
}

/** What `restampComponent` did on one slide. */
export interface RestampSlideResult {
  /** One entry per stamp of the component on the slide, in stacking order of their first object. */
  stamps: RestampedStamp[]
  /** Animation steps deleted with the removed objects. */
  removedAnimations: string[]
  /**
   * Text slots whose body was kept: the caller applies the master object's
   * formatting to `objectId`'s body (component.stamp's slot filling).
   */
  textSlots: Array<{ objectId: string; masterObjectId: string }>
}

/** Fields that hold a picture slot's picture, per object type. */
const PICTURE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  image: ['assetId', 'variant', 'fit', 'alt', 'imageRect', 'imageRotation'],
  video: ['assetId', 'fit', 'alt', 'posterAssetId', 'posterTime', 'trimStart', 'trimEnd'],
}

/**
 * What a table slot keeps: its cells, and its grid together with the frame
 * size the grid adds up to (a table's column widths sum to its width, its
 * row heights to its height). Its styling — `defaults`, `borderSegments` —
 * and everything else comes from the master.
 */
const TABLE_SLOT_FIELDS = ['rows', 'colWidths', 'rowHeights', 'width', 'height'] as const

/** `h:<row>:<col>` / `v:<row>:<col>` (TableObject.borderSegments). */
const BORDER_SEGMENT_KEY = /^([hv]):(\d+):(\d+)$/

interface Provenance {
  id: string
  objectId: string
  instance: string
  origin: { x: number; y: number }
}

function provenanceOf(value: unknown): Provenance | null {
  if (typeof value !== 'object' || value === null) return null
  const c = value as Record<string, unknown>
  const origin = c['origin'] as { x?: unknown; y?: unknown } | undefined
  if (
    typeof c['id'] !== 'string' ||
    typeof c['objectId'] !== 'string' ||
    typeof c['instance'] !== 'string' ||
    typeof origin !== 'object' ||
    origin === null ||
    typeof origin.x !== 'number' ||
    typeof origin.y !== 'number'
  ) {
    return null
  }
  return {
    id: c['id'],
    objectId: c['objectId'],
    instance: c['instance'],
    origin: { x: origin.x, y: origin.y },
  }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/** The slot a master object is: its `slot`, else its `name`; null when it is none. */
export function slotNameOf(obj: { slot?: unknown; name?: unknown }): string | null {
  for (const v of [obj.slot, obj.name]) {
    if (typeof v === 'string' && v.trim() !== '') return v
  }
  return null
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const bb = b as unknown[]
    return a.length === bb.length && a.every((v, i) => deepEqual(v, bb[i]))
  }
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  return (
    ka.length === kb.length &&
    ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  )
}

/**
 * A crop (absolute slide px) carried from one frame to another: moved with
 * the frame and scaled by its size change, as object.resize does.
 */
function carriedCrop(
  crop: unknown,
  from: { x: number; y: number; width: number; height: number },
  to: { x: number; y: number; width: number; height: number },
): { x: number; y: number; width: number; height: number } | undefined {
  const c = shiftedCrop(crop, 0, 0)
  if (c === undefined) return undefined
  const sx = from.width === 0 ? 1 : to.width / from.width
  const sy = from.height === 0 ? 1 : to.height / from.height
  return {
    x: to.x + (c.x - from.x) * sx,
    y: to.y + (c.y - from.y) * sy,
    width: c.width * sx,
    height: c.height * sy,
  }
}

/** The border segments of `segments` that lie inside an R x C grid. */
function segmentsInside(segments: unknown, rows: number, cols: number): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (typeof segments !== 'object' || segments === null) return out
  for (const [key, value] of Object.entries(segments)) {
    const m = BORDER_SEGMENT_KEY.exec(key)
    if (m === null) continue
    const r = Number(m[2])
    const c = Number(m[3])
    if (m[1] === 'h' ? r <= rows && c < cols : r < rows && c <= cols) out[key] = value
  }
  return out
}

function frameOf(rec: { get(key: string): unknown } | Record<string, unknown>) {
  const get = (k: string): unknown =>
    rec instanceof Y.Map ? rec.get(k) : (rec as Record<string, unknown>)[k]
  return { x: num(get('x')), y: num(get('y')), width: num(get('width')), height: num(get('height')) }
}

/** What `masterGroupOf` says of an object that is no copy in this stamp of a current master object. */
const NOT_A_COPY = Symbol('not a copy')

interface StampMember {
  map: Y.Map<unknown>
  id: string
  provenance: Provenance
}

/** How one existing object is brought to its master object. */
interface PlannedUpdate {
  member: StampMember
  /** The object as it will be, plain (a text body as a string plus `_richTextOps`). */
  next: Record<string, unknown>
  /** Keys whose current CRDT value stays untouched (slot content). */
  keep: ReadonlySet<string>
  /** Whether the object is replaced whole at its index (a type change, a table). */
  replace: boolean
}

/**
 * Re-apply the master in `componentDoc` (component `componentId`) to every
 * stamp of it on the slide of `objects` / `animations`. See the file header.
 * A slide without such stamps is left alone and an empty result returned.
 */
export function restampComponent(
  objects: ObjectsMutationContext,
  animations: AnimationsMutationContext,
  componentDoc: Y.Doc,
  componentId: string,
): RestampSlideResult {
  const result: RestampSlideResult = { stamps: [], removedAnimations: [], textSlots: [] }

  // The stamps on the slide, by instance, in stacking order.
  const instances = new Map<string, StampMember[]>()
  for (let i = 0; i < objects.objects.length; i++) {
    const map = objects.objects.get(i)
    const provenance = provenanceOf(map.get('component'))
    if (provenance === null || provenance.id !== componentId) continue
    const members = instances.get(provenance.instance) ?? []
    members.push({ map, id: map.get('id') as string, provenance })
    instances.set(provenance.instance, members)
  }
  if (instances.size === 0) return result

  const master = readMasterObjects(componentDoc).map((o) => {
    const plain: Record<string, unknown> = { ...(o as unknown as Record<string, unknown>) }
    delete plain['component']
    return plain
  })
  const masterIds = new Set(master.map((m) => m['id'] as string))
  const masterIndex = new Map(master.map((m, i) => [m['id'] as string, i]))

  // Group tokens of the master: a token shared by two or more master objects
  // is a group; a groupId naming another master object is the legacy
  // group-object model (stampComponent's rules).
  const tokenMembers = new Map<string, number>()
  for (const m of master) {
    const g = m['groupId']
    if (typeof g === 'string' && g !== '') tokenMembers.set(g, (tokenMembers.get(g) ?? 0) + 1)
  }

  // Every group token on the slide, with the objects carrying it.
  const holders = new Map<string, Y.Map<unknown>[]>()
  for (let i = 0; i < objects.objects.length; i++) {
    const map = objects.objects.get(i)
    const g = map.get('groupId')
    if (typeof g === 'string' && g !== '') holders.set(g, [...(holders.get(g) ?? []), map])
  }

  // Plan every stamp before the first write.
  interface PlannedStamp {
    instance: string
    updates: PlannedUpdate[]
    additions: Array<{ masterIndex: number; obj: Record<string, unknown> }>
    removals: StampMember[]
    textSlots: Array<{ objectId: string; masterObjectId: string }>
  }
  const plans: PlannedStamp[] = []
  for (const [instance, members] of instances) {
    const offset = stampOffset(members, masterIndex)
    const kept = members.filter((m) => masterIds.has(m.provenance.objectId))
    const removals = members.filter((m) => !masterIds.has(m.provenance.objectId))

    // Master object id → the stamp's object id (first copy wins), new ids
    // for the master objects the stamp has no copy of.
    const copyOf = new Map<string, string>()
    for (const m of kept)
      if (!copyOf.has(m.provenance.objectId)) copyOf.set(m.provenance.objectId, m.id)
    const addedIds = new Map<string, string>()
    for (const m of master) {
      const id = m['id'] as string
      if (!copyOf.has(id)) addedIds.set(id, nanoid())
    }

    // The stamp's own token for each master group token: the one its copies
    // carry already when that token holds nothing else — every object on the
    // slide carrying it is this stamp's copy of a member of that master
    // group — else a fresh one for this stamp (a token a person also gave
    // other objects stays theirs).
    const masterGroupOf = (holder: Y.Map<unknown>): unknown => {
      const p = provenanceOf(holder.get('component'))
      if (p === null || p.id !== componentId || p.instance !== instance) return NOT_A_COPY
      const i = masterIndex.get(p.objectId)
      return i === undefined ? NOT_A_COPY : master[i]!['groupId']
    }
    const tokenOf = new Map<string, string>()
    for (const m of kept) {
      const g = master[masterIndex.get(m.provenance.objectId)!]!['groupId']
      const current = m.map.get('groupId')
      if (
        typeof g === 'string' &&
        (tokenMembers.get(g) ?? 0) >= 2 &&
        !masterIds.has(g) &&
        !tokenOf.has(g) &&
        typeof current === 'string' &&
        current !== '' &&
        (holders.get(current) ?? []).every((h) => masterGroupOf(h) === g)
      ) {
        tokenOf.set(g, current)
      }
    }
    /** Whether `token` also groups objects that are not this stamp's copies. */
    const sharedOutside = (token: unknown): boolean =>
      typeof token === 'string' &&
      (holders.get(token) ?? []).some((h) => masterGroupOf(h) === NOT_A_COPY)
    const groupFor = (g: unknown): string | undefined => {
      if (typeof g !== 'string' || g === '') return undefined
      if (masterIds.has(g)) return copyOf.get(g) ?? addedIds.get(g)
      if ((tokenMembers.get(g) ?? 0) < 2) return undefined
      let token = tokenOf.get(g)
      if (token === undefined) {
        token = nanoid()
        tokenOf.set(g, token)
      }
      return token
    }

    /** The master object as it lands in this stamp, under `id`. */
    const placed = (m: Record<string, unknown>, id: string): Record<string, unknown> => {
      const next: Record<string, unknown> = { ...m, id }
      next['x'] = num(m['x']) + offset.x
      next['y'] = num(m['y']) + offset.y
      const crop = shiftedCrop(m['imageRect'], offset.x, offset.y)
      if (crop !== undefined) next['imageRect'] = crop
      const group = groupFor(m['groupId'])
      if (group === undefined) delete next['groupId']
      else next['groupId'] = group
      next['component'] = {
        id: componentId,
        objectId: m['id'],
        instance,
        origin: { x: num(m['x']), y: num(m['y']) },
      }
      return next
    }

    const textSlots: PlannedStamp['textSlots'] = []
    const updates = kept.map((member): PlannedUpdate => {
      const m = master[masterIndex.get(member.provenance.objectId)!]!
      const next = placed(m, member.id)
      // An object the master leaves ungrouped keeps a group a person put it
      // in with objects outside the stamp.
      const current = member.map.get('groupId')
      if (next['groupId'] === undefined && sharedOutside(current)) next['groupId'] = current
      const type = next['type']
      const currentType = member.map.get('type')
      const slot = slotNameOf(m) !== null && currentType === type
      const keep = new Set<string>()
      if (slot && type === 'text' && member.map.get('text') instanceof Y.Text) {
        keep.add('text')
        textSlots.push({ objectId: member.id, masterObjectId: m['id'] as string })
      } else if (slot && PICTURE_FIELDS[type as string] !== undefined) {
        for (const k of PICTURE_FIELDS[type as string]!) keep.add(k)
        // The picture stays where it sits in its frame: a crop (absolute)
        // follows the frame from where it is to where the master puts it,
        // scaled with it.
        keep.delete('imageRect')
        const crop = carriedCrop(member.map.get('imageRect'), frameOf(member.map), frameOf(next))
        if (crop !== undefined) next['imageRect'] = crop
        else delete next['imageRect']
      } else if (slot && type === 'table') {
        // Rebuilt whole (its nested structure cannot be patched key by key):
        // the slot's cells, grid and size, the master's styling.
        const current = yMapToPlainObject(member.map) as unknown as Record<string, unknown>
        for (const k of TABLE_SLOT_FIELDS) next[k] = current[k]
        // Cell bodies captured now, as deltas: the old table goes before the
        // new one is built.
        const rows = (Array.isArray(current['rows']) ? (current['rows'] as unknown[][]) : []).map(
          (row) =>
            row.map((cell) => {
              const c = cell as Record<string, unknown>
              const body = c['text']
              return body instanceof Y.Text
                ? { ...c, text: body.toString(), [RICH_TEXT_OPS_KEY]: richTextOpsOf(body) }
                : c
            }),
        )
        next['rows'] = rows
        const segments = segmentsInside(m['borderSegments'], rows.length, rows[0]?.length ?? 0)
        if (Object.keys(segments).length > 0) next['borderSegments'] = segments
        else delete next['borderSegments']
      }
      const replace = currentType !== type || type === 'table'
      return { member, next, keep: replace ? new Set() : keep, replace }
    })

    const additions = master
      .filter((m) => addedIds.has(m['id'] as string))
      .map((m) => ({
        masterIndex: masterIndex.get(m['id'] as string)!,
        obj: placed(m, addedIds.get(m['id'] as string)!),
      }))

    plans.push({ instance, updates, additions, removals, textSlots })
  }

  // Write.
  objects.doc.transact(() => {
    for (const plan of plans) {
      for (const u of plan.updates) applyUpdate(objects, u)

      const removedIds = new Set(plan.removals.map((m) => m.id))
      const steps: string[] = []
      for (let i = 0; i < animations.animations.length; i++) {
        const step = animations.animations.get(i)
        if (removedIds.has(step.get('objectId') as string)) steps.push(step.get('id') as string)
      }
      for (const id of removedIds) {
        const idx = indexOfId(objects.objects, id)
        if (idx !== -1) objects.objects.delete(idx, 1)
      }
      for (const step of steps) removeAnimation(animations, step)
      result.removedAnimations.push(...steps)

      // Each added object goes right above the copy of the master object
      // before it (or below the copy of the one after it), so the stamp's
      // stacking follows the master's.
      const placedIds = new Map<number, string>()
      for (const u of plan.updates) {
        const i = masterIndex.get(u.member.provenance.objectId)!
        if (!placedIds.has(i)) placedIds.set(i, u.member.id)
      }
      for (const a of plan.additions) {
        let at = objects.objects.length
        const before = [...placedIds.entries()]
          .filter(([i]) => i < a.masterIndex)
          .sort(([x], [y]) => y - x)[0]
        const after = [...placedIds.entries()]
          .filter(([i]) => i > a.masterIndex)
          .sort(([x], [y]) => x - y)[0]
        if (before !== undefined) at = indexOfId(objects.objects, before[1]) + 1
        else if (after !== undefined) at = indexOfId(objects.objects, after[1])
        insertObjectsWithRichText(
          objects.objects,
          [a.obj as unknown as SlideObject],
          LOCAL_ORIGIN,
          at,
        )
        placedIds.set(a.masterIndex, a.obj['id'] as string)
      }

      result.stamps.push({
        instance: plan.instance,
        updated: plan.updates.map((u) => u.member.id),
        added: plan.additions.map((a) => a.obj['id'] as string),
        removed: [...removedIds],
      })
      result.textSlots.push(...plan.textSlots)
    }
  }, LOCAL_ORIGIN)

  return result
}

/**
 * The offset most of a stamp's objects share (`x − origin.x`, `y − origin.y`);
 * ties go to the object earliest in master order.
 */
function stampOffset(
  members: readonly StampMember[],
  masterIndex: ReadonlyMap<string, number>,
): { x: number; y: number } {
  const tally = new Map<string, { x: number; y: number; count: number; rank: number }>()
  for (const m of members) {
    const x = num(m.map.get('x')) - m.provenance.origin.x
    const y = num(m.map.get('y')) - m.provenance.origin.y
    const key = `${x},${y}`
    const rank = masterIndex.get(m.provenance.objectId) ?? Number.MAX_SAFE_INTEGER
    const t = tally.get(key)
    if (t === undefined) tally.set(key, { x, y, count: 1, rank })
    else {
      t.count++
      t.rank = Math.min(t.rank, rank)
    }
  }
  const best = [...tally.values()].sort((a, b) => b.count - a.count || a.rank - b.rank)[0]!
  return { x: best.x, y: best.y }
}

function indexOfId(arr: Y.Array<Y.Map<unknown>>, id: string): number {
  for (let i = 0; i < arr.length; i++) if (arr.get(i).get('id') === id) return i
  return -1
}

function isRichTextOps(v: unknown): v is RichTextOps {
  return Array.isArray(v)
}

/** Bring one existing object to its planned state, in place (or replaced at its index). */
function applyUpdate(objects: ObjectsMutationContext, u: PlannedUpdate): void {
  const idx = indexOfId(objects.objects, u.member.id)
  if (idx === -1) return
  if (u.replace) {
    objects.objects.delete(idx, 1)
    insertObjectsWithRichText(
      objects.objects,
      [u.next as unknown as SlideObject],
      LOCAL_ORIGIN,
      idx,
    )
    return
  }
  const map = u.member.map
  const next = { ...u.next }
  const ops = next[RICH_TEXT_OPS_KEY]
  delete next[RICH_TEXT_OPS_KEY]
  for (const key of [...map.keys()]) {
    if (u.keep.has(key) || key in next) continue
    map.delete(key)
  }
  for (const [key, value] of Object.entries(next)) {
    if (u.keep.has(key)) continue
    if (key === 'text' && next['type'] === 'text') {
      // A text object's body is replaced in place: the Y.Text keeps its
      // identity (collaborators' cursors, observers), its content becomes
      // the master's, formatting included.
      const body = map.get('text')
      if (body instanceof Y.Text) {
        if (body.length > 0) body.delete(0, body.length)
        if (isRichTextOps(ops) && ops.length > 0) body.applyDelta(ops)
        else if (typeof value === 'string' && value.length > 0) body.insert(0, value)
        continue
      }
      const fresh = new Y.Text()
      map.set('text', fresh)
      if (isRichTextOps(ops) && ops.length > 0) fresh.applyDelta(ops)
      else if (typeof value === 'string' && value.length > 0) fresh.insert(0, value)
      continue
    }
    if (value === undefined) {
      map.delete(key)
      continue
    }
    if (!deepEqual(map.get(key), value)) map.set(key, value)
  }
}
