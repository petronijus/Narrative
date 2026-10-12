/**
 * slide-model/src/restampComponent.test.ts
 *
 * restampComponent — a changed master re-applied to the stamps made from it,
 * in place: ids kept, slot content kept, objects added and removed as the
 * master gained and lost them, one undo step.
 */

import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import type {
  ImageObject,
  RectangleObject,
  SlideObject,
  TableObject,
  TextObject,
  ComponentProvenance,
} from '@narrative/shared'
import { createSlideDoc } from './yDoc.js'
import { getSlideAnimationsCtx, getSlideObjectsCtx, listSlides } from './slides.js'
import { yMapToPlainObject } from './bindings.js'
import { addAnimation } from './animationMutations.js'
import { applyFormat } from './richText.js'
import { addObjects, updateObject, type ObjectsMutationContext } from './mutations.js'
import {
  addTable,
  getTableCellYMap,
  insertTableCol,
  setTableBorderSegment,
  setTableDefaultsPatch,
} from './tableMutations.js'
import { createUndoManager } from './undo.js'
import { stampComponent, writeComponentMaster } from './stampComponent.js'
import { restampComponent } from './restampComponent.js'

const CMP = 'cmp_1'

function rect(id: string, x: number, y: number, extra: Partial<RectangleObject> = {}) {
  return {
    id,
    type: 'rectangle',
    x,
    y,
    width: 100,
    height: 50,
    fill: 0xff0000,
    rotation: 0,
    opacity: 1,
    ...extra,
  } satisfies RectangleObject
}

function text(id: string, x: number, y: number, body: string, extra: Partial<TextObject> = {}) {
  return {
    id,
    type: 'text',
    x,
    y,
    width: 400,
    height: 60,
    text: body,
    fontSize: 32,
    fontWeight: 'normal',
    color: 0x111111,
    align: 'left',
    rotation: 0,
    opacity: 1,
    ...extra,
  } satisfies TextObject
}

function image(id: string, x: number, y: number, extra: Partial<ImageObject> = {}) {
  return {
    id,
    type: 'image',
    assetId: 'master-pic',
    x,
    y,
    width: 300,
    height: 200,
    rotation: 0,
    opacity: 1,
    ...extra,
  } satisfies ImageObject
}

interface World {
  deck: ReturnType<typeof createSlideDoc>
  slideId: string
  objects: ObjectsMutationContext
  master: Y.Doc
  /** The master's objects context (edit the master with the ordinary writers). */
  masterObjects: ObjectsMutationContext
  restamp: () => ReturnType<typeof restampComponent>
}

function world(masterTree: SlideObject[]): World {
  const deck = createSlideDoc()
  const slideId = listSlides(deck)[0]!.id
  const objects = getSlideObjectsCtx(deck, slideId)!
  const master = new Y.Doc()
  writeComponentMaster(master, masterTree, [])
  const masterSlides = master.getArray<Y.Map<unknown>>('slides')
  const masterObjects = getSlideObjectsCtx({ doc: master, slides: masterSlides }, 'master')!
  return {
    deck,
    slideId,
    objects,
    master,
    masterObjects,
    restamp: () => restampComponent(objects, getSlideAnimationsCtx(deck, slideId)!, master, CMP),
  }
}

/** `updateObject` with an untyped patch (the tests patch fields of several types). */
function update(ctx: ObjectsMutationContext, id: string, patch: Record<string, unknown>): void {
  updateObject(ctx, id, patch as Parameters<typeof updateObject>[2])
}

function plain(ctx: ObjectsMutationContext): SlideObject[] {
  return ctx.objects.toArray().map((m) => yMapToPlainObject(m))
}

function byId(ctx: ObjectsMutationContext, id: string): SlideObject {
  const o = plain(ctx).find((x) => x.id === id)
  if (o === undefined) throw new Error(`no object ${id}`)
  return o
}

function bodyOf(ctx: ObjectsMutationContext, id: string): Y.Text {
  const t = ctx.objects
    .toArray()
    .find((m) => m.get('id') === id)
    ?.get('text')
  if (!(t instanceof Y.Text)) throw new Error(`no body on ${id}`)
  return t
}

describe('restampComponent', () => {
  it('updates a moved stamp in place, at the offset people moved it to', () => {
    const w = world([rect('m_bar', 100, 100), rect('m_box', 100, 200)])
    const [bar, box] = stampComponent(w.objects, w.master, { x: 100, y: 100 }, CMP)
    // People moved the whole stamp by (+300, +40).
    update(w.objects, bar!, { x: 400, y: 140 })
    update(w.objects, box!, { x: 400, y: 240 })
    // The master changes: the bar is wider, red becomes blue and moves down 10.
    update(w.masterObjects, 'm_bar', { width: 180, fill: 0x0000ff, y: 110 })

    const result = w.restamp()

    expect(result.stamps).toHaveLength(1)
    expect(result.stamps[0]!.updated).toEqual([bar, box])
    expect(result.stamps[0]!.added).toEqual([])
    expect(result.stamps[0]!.removed).toEqual([])
    expect(plain(w.objects).map((o) => o.id)).toEqual([bar, box])
    const b = byId(w.objects, bar!) as RectangleObject
    expect(b).toMatchObject({ x: 400, y: 150, width: 180, fill: 0x0000ff })
    expect(b.component).toMatchObject({ id: CMP, objectId: 'm_bar', origin: { x: 100, y: 110 } })
    expect(byId(w.objects, box!)).toMatchObject({ x: 400, y: 240 })
  })

  it('takes the offset most of the stamp shares: a nudged object goes back into place', () => {
    const w = world([rect('m1', 0, 0), rect('m2', 0, 100), rect('m3', 0, 200)])
    const [a, b, c] = stampComponent(w.objects, w.master, { x: 0, y: 0 }, CMP)
    for (const id of [a!, b!, c!]) {
      const o = byId(w.objects, id)
      update(w.objects, id, { x: o.x + 50 })
    }
    update(w.objects, b!, { x: 57 }) // nudged on its own

    w.restamp()

    expect([a, b, c].map((id) => byId(w.objects, id!).x)).toEqual([50, 50, 50])
  })

  it('keeps a text slot’s text and gives it the master’s box formatting; replaces other text', () => {
    const w = world([
      text('m_title', 100, 100, 'Headline', { name: 'title' }),
      text('m_kicker', 100, 50, 'KICKER', { slot: 'kicker' }),
      text('m_note', 100, 300, 'Fixed note'),
    ])
    const [title, kicker, note] = stampComponent(w.objects, w.master, { x: 100, y: 50 }, CMP)
    // Filled after the stamp, as component.stamp's slots are.
    const tb = bodyOf(w.objects, title!)
    w.deck.doc.transact(() => {
      tb.delete(0, tb.length)
      tb.insert(0, 'Q3 results')
    })
    update(w.objects, kicker!, { text: 'Finance' })
    update(w.objects, note!, { text: 'edited by hand' })
    // The master's title turns brand red; its note gets new, formatted text.
    update(w.masterObjects, 'm_title', { color: 0xe0301e, fontSize: 48 })
    const masterNote = bodyOf(w.masterObjects, 'm_note')
    w.master.transact(() => {
      masterNote.delete(0, masterNote.length)
      masterNote.insert(0, 'Source: annual report')
      applyFormat(masterNote, 0, 7, { fontWeight: 700 })
    })

    const result = w.restamp()

    expect(bodyOf(w.objects, title!).toString()).toBe('Q3 results')
    expect(byId(w.objects, title!)).toMatchObject({ color: 0xe0301e, fontSize: 48 })
    expect(bodyOf(w.objects, kicker!).toString()).toBe('Finance')
    expect(result.textSlots).toEqual([
      { objectId: title, masterObjectId: 'm_title' },
      { objectId: kicker, masterObjectId: 'm_kicker' },
    ])
    // Not a slot: the master's text, formatting included, in the same Y.Text.
    const noteBody = bodyOf(w.objects, note!)
    expect(noteBody.toString()).toBe('Source: annual report')
    expect(noteBody.toDelta()[0]).toMatchObject({
      insert: 'Source:',
      attributes: { fontWeight: 700 },
    })
  })

  it('keeps a picture slot’s picture, its crop following the frame', () => {
    const w = world([image('m_pic', 100, 100, { name: 'photo', fit: 'cover' })])
    const [pic] = stampComponent(w.objects, w.master, { x: 100, y: 100 }, CMP)
    update(w.objects, pic!, {
      assetId: 'people-pic',
      fit: 'contain',
      imageRect: { x: 80, y: 90, width: 400, height: 260 },
    })
    // The master frame moves 20 right and gets an ellipse mask.
    update(w.masterObjects, 'm_pic', {
      x: 120,
      mask: { kind: 'ellipse' },
      assetId: 'new-master-pic',
    })

    w.restamp()

    expect(byId(w.objects, pic!)).toMatchObject({
      x: 120,
      assetId: 'people-pic',
      fit: 'contain',
      mask: { kind: 'ellipse' },
      imageRect: { x: 100, y: 90, width: 400, height: 260 },
    })
  })

  it('scales a picture slot’s crop with its frame when the master resizes the frame', () => {
    const w = world([image('m_pic', 100, 100, { name: 'photo' })])
    const [pic] = stampComponent(w.objects, w.master, { x: 100, y: 100 }, CMP)
    update(w.objects, pic!, { imageRect: { x: 50, y: 100, width: 600, height: 300 } })
    update(w.masterObjects, 'm_pic', { width: 600, height: 100 })

    w.restamp()

    // Frame (100,100 300x200) → (100,100 600x100): x scales by 2, y by 0.5.
    expect(byId(w.objects, pic!)).toMatchObject({
      width: 600,
      height: 100,
      imageRect: { x: 0, y: 100, width: 1200, height: 150 },
    })
  })

  it('keeps a video slot’s clip and takes its playback from the master', () => {
    const video = {
      id: 'm_vid',
      type: 'video',
      name: 'clip',
      assetId: 'master-clip',
      x: 0,
      y: 0,
      width: 640,
      height: 360,
      rotation: 0,
      opacity: 1,
      autoplay: false,
    } satisfies SlideObject
    const w = world([video])
    const [v] = stampComponent(w.objects, w.master, { x: 0, y: 0 }, CMP)
    update(w.objects, v!, { assetId: 'people-clip', trimStart: 2, trimEnd: 8, posterTime: 3 })
    update(w.masterObjects, 'm_vid', { autoplay: true, loop: true, opacity: 0.5 })

    w.restamp()

    expect(byId(w.objects, v!)).toMatchObject({
      assetId: 'people-clip',
      trimStart: 2,
      trimEnd: 8,
      posterTime: 3,
      autoplay: true,
      loop: true,
      opacity: 0.5,
    })
  })

  it('keeps a table slot’s cells, grid and size, and takes its styling from the master', () => {
    const w = world([rect('m_bar', 0, 0)])
    const tableId = addTable(w.masterObjects, { x: 0, y: 100, width: 400, height: 80, rows: 2, cols: 2 })
    update(w.masterObjects, tableId, { name: 'figures' })
    const [, table] = stampComponent(w.objects, w.master, { x: 0, y: 0 }, CMP)
    // People fill a cell and add a column (the frame grows with the grid).
    const cell = getTableCellYMap(w.objects, table!, 0, 0)!.get('text') as Y.Text
    w.deck.doc.transact(() => {
      cell.insert(0, 'Revenue')
      applyFormat(cell, 0, 7, { fontWeight: 700 })
    })
    insertTableCol(w.objects, table!, 2)
    const stamped = () => byId(w.objects, table!) as TableObject
    const grid = { colWidths: stamped().colWidths, width: stamped().width, height: stamped().height }
    // The master restyles its table: bigger type, a heavy bottom rule.
    setTableDefaultsPatch(w.masterObjects, tableId, { fontSize: 30 })
    setTableBorderSegment(w.masterObjects, tableId, 'h:2:1', { color: 0xff0000, width: 4 })
    setTableBorderSegment(w.masterObjects, tableId, 'h:2:0', { color: 0xff0000, width: 4 })

    const result = w.restamp()

    expect(result.stamps[0]!.updated).toContain(table)
    const t = stamped()
    expect(t.id).toBe(table)
    expect({ colWidths: t.colWidths, width: t.width, height: t.height }).toEqual(grid)
    expect(t.colWidths.reduce((a, b) => a + b, 0)).toBeCloseTo(t.width)
    expect(t.rowHeights.reduce((a, b) => a + b, 0)).toBeCloseTo(t.height)
    expect(t.defaults.fontSize).toBe(30)
    expect(Object.keys(t.borderSegments ?? {}).sort()).toEqual(['h:2:0', 'h:2:1'])
    const body = getTableCellYMap(w.objects, table!, 0, 0)!.get('text') as Y.Text
    expect(body.toDelta()).toEqual([{ insert: 'Revenue', attributes: { fontWeight: 700 } }])
    expect(t.rows[0]).toHaveLength(3)
  })

  it('replaces an object whose type changed under the same id and stacking position', () => {
    const w = world([rect('m1', 0, 0), rect('m2', 0, 100)])
    const [a, b] = stampComponent(w.objects, w.master, { x: 0, y: 0 }, CMP)
    // A person turned the first rectangle into a path; it keeps its provenance.
    const map = w.objects.objects.get(0)
    w.deck.doc.transact(() => {
      map.set('type', 'path')
      map.set('anchors', [
        { x: 0, y: 0 },
        { x: 100, y: 50 },
      ])
    })

    w.restamp()

    expect(plain(w.objects).map((o) => [o.id, o.type])).toEqual([
      [a, 'rectangle'],
      [b, 'rectangle'],
    ])
    expect((byId(w.objects, a!) as unknown as Record<string, unknown>)['anchors']).toBeUndefined()
  })

  it('gives a stamp a fresh group token when a person also grouped other objects with it', () => {
    const w = world([rect('m1', 0, 0, { groupId: 'g' }), rect('m2', 0, 100, { groupId: 'g' })])
    const [a, b] = stampComponent(w.objects, w.master, { x: 0, y: 0 }, CMP)
    const token = byId(w.objects, a!).groupId!
    // A person adds an unrelated shape to the stamp's group.
    addObjects(w.objects, [rect('mine', 500, 500, { groupId: token })])

    w.restamp()

    const fresh = byId(w.objects, a!).groupId
    expect(fresh).toBeDefined()
    expect(fresh).not.toBe(token)
    expect(byId(w.objects, b!).groupId).toBe(fresh)
    expect(byId(w.objects, 'mine').groupId).toBe(token)
  })

  it('keeps a group a person made between an ungrouped master object and objects outside the stamp', () => {
    const w = world([rect('m1', 0, 0), rect('m2', 0, 100)])
    const [a, b] = stampComponent(w.objects, w.master, { x: 0, y: 0 }, CMP)
    addObjects(w.objects, [rect('caption', 0, 300, { groupId: 'people' })])
    update(w.objects, a!, { groupId: 'people' })
    // …and one that only grouped the stamp's own copies goes, as the master says.
    update(w.objects, b!, { groupId: 'only-stamp' })

    w.restamp()

    expect(byId(w.objects, a!).groupId).toBe('people')
    expect(byId(w.objects, 'caption').groupId).toBe('people')
    expect(byId(w.objects, b!).groupId).toBeUndefined()
  })

  it('adds master objects new since the stamp in master order and deletes removed ones with their animations', () => {
    const w = world([rect('m1', 0, 0), rect('m_gone', 0, 100), rect('m3', 0, 200)])
    const [a, gone, c] = stampComponent(w.objects, w.master, { x: 0, y: 0 }, CMP)
    const anims = getSlideAnimationsCtx(w.deck, w.slideId)!
    const step = addAnimation(anims, {
      objectId: gone!,
      preset: 'fadeIn',
      trigger: 'onEnter',
      duration: 0.5,
      delay: 0,
      easing: 'power2.out',
    })
    // The master loses m_gone and gains m_new between m1 and m3.
    w.master.transact(() => {
      const arr = w.masterObjects.objects
      const goneIdx = arr.toArray().findIndex((m) => m.get('id') === 'm_gone')
      arr.delete(goneIdx, 1)
    })
    const fresh = new Y.Map<unknown>()
    for (const [k, v] of Object.entries(rect('m_new', 0, 150, { fill: 0x00ff00 }))) fresh.set(k, v)
    w.master.transact(() => w.masterObjects.objects.insert(1, [fresh]))

    const result = w.restamp()

    const stamp = result.stamps[0]!
    expect(stamp.removed).toEqual([gone])
    expect(stamp.added).toHaveLength(1)
    expect(result.removedAnimations).toEqual([step.id])
    expect(anims.animations.length).toBe(0)
    const ids = plain(w.objects).map((o) => o.id)
    expect(ids).toEqual([a, stamp.added[0], c])
    expect(byId(w.objects, stamp.added[0]!)).toMatchObject({
      fill: 0x00ff00,
      component: { id: CMP, objectId: 'm_new', instance: byId(w.objects, a!).component!.instance },
    })
  })

  it('restamps two stamps of one master on a slide independently', () => {
    const w = world([rect('m1', 0, 0, { groupId: 'g' }), rect('m2', 0, 100, { groupId: 'g' })])
    const first = stampComponent(w.objects, w.master, { x: 0, y: 0 }, CMP)
    const second = stampComponent(w.objects, w.master, { x: 500, y: 0 }, CMP)
    for (const id of second) {
      const o = byId(w.objects, id)
      update(w.objects, id, { y: o.y + 300 })
    }
    const groupOf = (id: string) => byId(w.objects, id).groupId
    const firstGroup = groupOf(first[0]!)
    const secondGroup = groupOf(second[0]!)
    update(w.masterObjects, 'm2', { fill: 0x123456 })

    const result = w.restamp()

    expect(result.stamps).toHaveLength(2)
    expect(byId(w.objects, first[1]!)).toMatchObject({ x: 0, y: 100, fill: 0x123456 })
    expect(byId(w.objects, second[1]!)).toMatchObject({ x: 500, y: 400, fill: 0x123456 })
    // Each stamp keeps its own group token.
    expect(groupOf(first[0]!)).toBe(firstGroup)
    expect(groupOf(first[1]!)).toBe(firstGroup)
    expect(groupOf(second[1]!)).toBe(secondGroup)
    expect(firstGroup).not.toBe(secondGroup)
    const instances = new Set(
      [...first, ...second].map(
        (id) => (byId(w.objects, id).component as ComponentProvenance).instance,
      ),
    )
    expect(instances.size).toBe(2)
  })

  it('keeps the animations of the objects it updates', () => {
    const w = world([rect('m1', 0, 0)])
    const [a] = stampComponent(w.objects, w.master, { x: 0, y: 0 }, CMP)
    const anims = getSlideAnimationsCtx(w.deck, w.slideId)!
    addAnimation(anims, {
      objectId: a!,
      preset: 'fadeIn',
      trigger: 'onEnter',
      duration: 0.5,
      delay: 0,
      easing: 'power2.out',
    })
    update(w.masterObjects, 'm1', { fill: 0x00ff00 })

    w.restamp()

    expect(anims.animations.length).toBe(1)
    expect(anims.animations.get(0).get('objectId')).toBe(a)
    expect(byId(w.objects, a!)).toMatchObject({ fill: 0x00ff00 })
  })

  it('leaves other objects and other components’ stamps alone', () => {
    const w = world([rect('m1', 0, 0)])
    const [mine] = stampComponent(w.objects, w.master, { x: 0, y: 0 }, CMP)
    const [theirs] = stampComponent(w.objects, w.master, { x: 0, y: 300 }, 'cmp_other')
    update(w.masterObjects, 'm1', { fill: 0x00ff00 })

    w.restamp()

    expect(byId(w.objects, mine!)).toMatchObject({ fill: 0x00ff00 })
    expect(byId(w.objects, theirs!)).toMatchObject({ fill: 0xff0000 })
  })

  it('returns an empty result on a slide without stamps of the component', () => {
    const w = world([rect('m1', 0, 0)])
    const before = JSON.stringify(plain(w.objects))
    expect(w.restamp()).toEqual({ stamps: [], removedAnimations: [], textSlots: [] })
    expect(JSON.stringify(plain(w.objects))).toBe(before)
  })

  it('is one undo step', () => {
    const w = world([rect('m1', 0, 0), text('m_t', 0, 100, 'Note')])
    stampComponent(w.objects, w.master, { x: 0, y: 0 }, CMP)
    const before = listSlides(w.deck)
    const undo = createUndoManager(w.deck)
    update(w.masterObjects, 'm1', { fill: 0x00ff00, width: 300 })
    const masterNote = bodyOf(w.masterObjects, 'm_t')
    w.master.transact(() => masterNote.insert(0, 'New '))

    w.restamp()
    expect(undo.undoStack).toHaveLength(1)
    undo.undo()

    expect(JSON.stringify(listSlides(w.deck))).toBe(JSON.stringify(before))
  })
})
