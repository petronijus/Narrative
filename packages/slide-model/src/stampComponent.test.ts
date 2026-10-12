/**
 * slide-model/src/stampComponent.test.ts
 *
 * Unit tests for stampComponent — one-shot stamping of a component
 * master Y.Doc onto a slide as detached primitives.
 */

import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { createSlideDoc } from './yDoc.js'
import { getSlideObjectsCtx, listSlides } from './slides.js'
import { yMapToPlainObject } from './bindings.js'
import type { SlideMutationContext } from './slideMutationContext.js'
import type { RectangleObject, TextObject, SlideObject } from '@narrative/shared'
import {
  COMPONENT_MASTER_SLIDE_ID,
  stampComponent,
  writeComponentMaster,
} from './stampComponent.js'
import { promoteToComponent, type PromoteToComponentPlan } from './components.js'
import { addObject, groupObjects, LOCAL_ORIGIN, type ObjectsMutationContext } from './mutations.js'
import { addTable, getTableCellYMap } from './tableMutations.js'

function makeDeckCtx(): SlideMutationContext {
  const { doc, slides } = createSlideDoc()
  return { doc, slides }
}

/**
 * Build a component master Y.Doc with the canonical schema:
 *   doc.getArray('slides') → [ Y.Map { objects: Y.Array<Y.Map>, animations: Y.Array<Y.Map> } ]
 */
function makeMasterDoc(objects: SlideObject[]): Y.Doc {
  const doc = new Y.Doc()
  const slides = doc.getArray<Y.Map<unknown>>('slides')
  doc.transact(() => {
    const slide = new Y.Map<unknown>()
    const objectsArr = new Y.Array<Y.Map<unknown>>()
    const animationsArr = new Y.Array<Y.Map<unknown>>()
    slide.set('objects', objectsArr)
    slide.set('animations', animationsArr)
    slides.push([slide])
    for (const obj of objects) {
      const yMap = new Y.Map<unknown>()
      for (const [k, v] of Object.entries(obj as unknown as Record<string, unknown>)) {
        yMap.set(k, v)
      }
      objectsArr.push([yMap])
    }
  })
  return doc
}

function makeRect(
  id: string,
  x: number,
  y: number,
  extras: Partial<RectangleObject> = {},
): RectangleObject {
  return {
    id,
    type: 'rectangle',
    x,
    y,
    width: 100,
    height: 80,
    fill: 0xff0000,
    rotation: 0,
    opacity: 1,
    ...extras,
  }
}

function makeText(id: string, x: number, y: number, text: string): TextObject {
  return {
    id,
    type: 'text',
    x,
    y,
    width: 200,
    height: 40,
    rotation: 0,
    opacity: 1,
    text,
    fontSize: 24,
    fontWeight: 'normal',
    color: 0x000000,
    align: 'left',
  }
}

describe('stampComponent', () => {
  it('returns [] for an empty master', () => {
    const deckCtx = makeDeckCtx()
    const slideId = listSlides(deckCtx)[0]!.id
    const objCtx = getSlideObjectsCtx(deckCtx, slideId)!
    const masterDoc = makeMasterDoc([])

    const ids = stampComponent(objCtx, masterDoc, { x: 50, y: 50 }, 'cmp')

    expect(ids).toEqual([])
    expect(objCtx.objects.length).toBe(0)
  })

  it('stamps every master object with a fresh id', () => {
    const deckCtx = makeDeckCtx()
    const slideId = listSlides(deckCtx)[0]!.id
    const objCtx = getSlideObjectsCtx(deckCtx, slideId)!
    const masterDoc = makeMasterDoc([
      makeRect('master-rect-1', 100, 100),
      makeText('master-text-1', 120, 220, 'Hello'),
    ])

    const ids = stampComponent(objCtx, masterDoc, { x: 0, y: 0 }, 'cmp')

    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toBe('master-rect-1')
    expect(ids[1]).not.toBe('master-text-1')
    expect(new Set(ids).size).toBe(2)
    expect(objCtx.objects.length).toBe(2)
  })

  it('translates the cluster so its bbox top-left lands at the drop point', () => {
    const deckCtx = makeDeckCtx()
    const slideId = listSlides(deckCtx)[0]!.id
    const objCtx = getSlideObjectsCtx(deckCtx, slideId)!
    // Master bbox top-left is (100, 200); inner offsets 0 and 50 in x.
    const masterDoc = makeMasterDoc([makeRect('m1', 100, 200), makeRect('m2', 150, 240)])

    stampComponent(objCtx, masterDoc, { x: 500, y: 600 }, 'cmp')

    const o1 = yMapToPlainObject<RectangleObject>(objCtx.objects.get(0))
    const o2 = yMapToPlainObject<RectangleObject>(objCtx.objects.get(1))
    // (100,200) → (500,600); (150,240) → (550,640) — same delta.
    expect(o1.x).toBe(500)
    expect(o1.y).toBe(600)
    expect(o2.x).toBe(550)
    expect(o2.y).toBe(640)
  })

  it('records where every stamped object came from, one instance per stamp', () => {
    const deckCtx = makeDeckCtx()
    const slideId = listSlides(deckCtx)[0]!.id
    const objCtx = getSlideObjectsCtx(deckCtx, slideId)!
    const masterDoc = makeMasterDoc([
      makeRect('m1', 100, 200, {
        component: { id: 'other', objectId: 'x', instance: 'y', origin: { x: 0, y: 0 } },
      }),
      makeRect('m2', 150, 240),
    ])

    const first = stampComponent(objCtx, masterDoc, { x: 500, y: 600 }, 'cmp')
    const second = stampComponent(objCtx, masterDoc, { x: 0, y: 0 }, 'cmp')

    const all = [...first, ...second].map((id, i) => {
      void id
      return yMapToPlainObject<RectangleObject>(objCtx.objects.get(i)).component!
    })
    expect(all[0]).toMatchObject({ id: 'cmp', objectId: 'm1', origin: { x: 100, y: 200 } })
    expect(all[1]).toMatchObject({ id: 'cmp', objectId: 'm2', origin: { x: 150, y: 240 } })
    expect(all[0]!.instance).toBe(all[1]!.instance)
    expect(all[2]!.instance).toBe(all[3]!.instance)
    expect(all[2]!.instance).not.toBe(all[0]!.instance)
  })

  it('moves a crop with its frame', () => {
    const deckCtx = makeDeckCtx()
    const slideId = listSlides(deckCtx)[0]!.id
    const objCtx = getSlideObjectsCtx(deckCtx, slideId)!
    const masterDoc = makeMasterDoc([
      {
        id: 'pic',
        type: 'image',
        assetId: 'a1',
        x: 100,
        y: 100,
        width: 200,
        height: 100,
        rotation: 0,
        opacity: 1,
        imageRect: { x: 50, y: 80, width: 300, height: 150 },
      },
    ])
    stampComponent(objCtx, masterDoc, { x: 400, y: 300 }, 'cmp')
    expect(objCtx.objects.get(0).get('imageRect')).toEqual({
      x: 350,
      y: 280,
      width: 300,
      height: 150,
    })
  })

  it('does not modify the master when stamped', () => {
    const deckCtx = makeDeckCtx()
    const slideId = listSlides(deckCtx)[0]!.id
    const objCtx = getSlideObjectsCtx(deckCtx, slideId)!
    const masterDoc = makeMasterDoc([makeRect('master-rect-1', 100, 100)])

    stampComponent(objCtx, masterDoc, { x: 999, y: 999 }, 'cmp')

    const masterSlide = masterDoc.getArray<Y.Map<unknown>>('slides').get(0)
    const masterObjs = masterSlide.get('objects') as Y.Array<Y.Map<unknown>>
    expect(masterObjs.length).toBe(1)
    const mObj = yMapToPlainObject<RectangleObject>(masterObjs.get(0))
    expect(mObj.id).toBe('master-rect-1')
    expect(mObj.x).toBe(100)
    expect(mObj.y).toBe(100)
  })

  it('remaps groupId references between stamped siblings', () => {
    const deckCtx = makeDeckCtx()
    const slideId = listSlides(deckCtx)[0]!.id
    const objCtx = getSlideObjectsCtx(deckCtx, slideId)!
    const masterDoc = makeMasterDoc([
      makeRect('grp', 100, 100, { groupId: 'grp' }),
      makeRect('child', 120, 120, { groupId: 'grp' }),
    ])

    const ids = stampComponent(objCtx, masterDoc, { x: 0, y: 0 }, 'cmp')
    const o0 = yMapToPlainObject<RectangleObject>(objCtx.objects.get(0))
    const o1 = yMapToPlainObject<RectangleObject>(objCtx.objects.get(1))

    expect(o0.groupId).toBe(ids[0])
    expect(o1.groupId).toBe(ids[0])
  })

  it('drops groupId that does not refer to a stamped sibling', () => {
    const deckCtx = makeDeckCtx()
    const slideId = listSlides(deckCtx)[0]!.id
    const objCtx = getSlideObjectsCtx(deckCtx, slideId)!
    const masterDoc = makeMasterDoc([makeRect('orphan', 100, 100, { groupId: 'foreign-id' })])

    stampComponent(objCtx, masterDoc, { x: 0, y: 0 }, 'cmp')
    const o = yMapToPlainObject<RectangleObject>(objCtx.objects.get(0))
    expect(o.groupId).toBeUndefined()
  })

  it('handles a master with mixed object types and a Y.Text body', () => {
    const deckCtx = makeDeckCtx()
    const slideId = listSlides(deckCtx)[0]!.id
    const objCtx = getSlideObjectsCtx(deckCtx, slideId)!
    // Build manually so the text body is a Y.Text inside the master.
    const masterDoc = new Y.Doc()
    const slides = masterDoc.getArray<Y.Map<unknown>>('slides')
    masterDoc.transact(() => {
      const slide = new Y.Map<unknown>()
      const objectsArr = new Y.Array<Y.Map<unknown>>()
      slide.set('objects', objectsArr)
      slide.set('animations', new Y.Array<Y.Map<unknown>>())
      slides.push([slide])

      const yRect = new Y.Map<unknown>()
      for (const [k, v] of Object.entries(
        makeRect('r', 0, 0) as unknown as Record<string, unknown>,
      )) {
        yRect.set(k, v)
      }
      objectsArr.push([yRect])

      const yText = new Y.Map<unknown>()
      const body = new Y.Text('hi')
      for (const [k, v] of Object.entries(
        makeText('t', 0, 0, '') as unknown as Record<string, unknown>,
      )) {
        if (k === 'text') continue
        yText.set(k, v)
      }
      yText.set('text', body)
      objectsArr.push([yText])
    })

    const ids = stampComponent(objCtx, masterDoc, { x: 0, y: 0 }, 'cmp')
    expect(ids).toHaveLength(2)

    const stampedText = yMapToPlainObject<TextObject>(objCtx.objects.get(1))
    // addObjects promotes plain string → Y.Text on insert, so the
    // stamped text body lives as a Y.Text in the deck doc with the
    // same content.
    const t = stampedText.text as unknown as Y.Text | string
    if (t instanceof Y.Text) {
      expect(t.toString()).toBe('hi')
    } else {
      expect(t).toBe('hi')
    }
  })
})

// ---------------------------------------------------------------------------
// promote → master → stamp: rich text survives the whole trip
// ---------------------------------------------------------------------------

type DeltaOp = { insert: unknown; attributes?: Record<string, unknown> }

/** Every Y.Text body of a slide-object snapshot, keyed by a stable path. */
function bodies(obj: SlideObject): Record<string, DeltaOp[]> {
  const out: Record<string, DeltaOp[]> = {}
  if (obj.type === 'text' && obj.text instanceof Y.Text) out['text'] = obj.text.toDelta()
  if (obj.type === 'table') {
    obj.rows.forEach((row, r) =>
      row.forEach((cell, c) => {
        if (cell.text instanceof Y.Text) out[`cell:${r}:${c}`] = cell.text.toDelta()
      }),
    )
  }
  return out
}

/** Recursively assert no `_richTextOps` marker leaked into the CRDT. */
function expectNoOpsMarker(v: unknown): void {
  if (v instanceof Y.Map) {
    expect(v.has('_richTextOps')).toBe(false)
    v.forEach((sv) => expectNoOpsMarker(sv))
  } else if (v instanceof Y.Array) {
    v.forEach((sv) => expectNoOpsMarker(sv))
  }
}

/** Seed a slide with a rich text object, a rich table and a token group. */
function seedRichSlide(objCtx: ObjectsMutationContext): { textId: string; tableId: string } {
  const textObj = makeText('rich-text', 40, 50, '')
  addObject(objCtx, textObj)
  const tableId = addTable(objCtx, { x: 300, y: 50, width: 300, height: 120, rows: 2, cols: 2 })
  const rectA = makeRect('grp-a', 40, 300)
  const rectB = makeRect('grp-b', 160, 300)
  addObject(objCtx, rectA)
  addObject(objCtx, rectB)
  groupObjects(objCtx, ['grp-a', 'grp-b'])

  const textY = objCtx.objects.get(0).get('text') as Y.Text
  const cellY = getTableCellYMap(objCtx, tableId, 1, 0)!.get('text') as Y.Text
  const cell01 = getTableCellYMap(objCtx, tableId, 0, 1)!.get('text') as Y.Text
  objCtx.doc.transact(() => {
    // Inline runs + two list paragraphs carried on U+2029 separators.
    textY.insert(0, 'Bold', { fontWeight: 700 })
    textY.insert(4, ' red', { color: 0xff0000, italic: true })
    textY.insert(8, ' ', { list: 'bullet', level: 0, bulletChar: '–' })
    textY.insert(9, 'sub', { fontFamily: 'Inter', fontSize: 30 })
    textY.insert(12, ' ', { list: 'bullet', level: 1 })
    // Table cells: numbered list with a custom format / start, and runs.
    cellY.insert(0, 'one', { underline: true })
    cellY.insert(3, ' ', { list: 'number', numberFormat: 'lowerRoman', startAt: 3 })
    cellY.insert(4, 'two')
    cellY.insert(7, ' ', { list: 'number', numberFormat: 'lowerRoman', level: 2 })
    cell01.insert(0, 'plain ')
    cell01.insert(6, 'big', { fontSize: 40, fontWeight: 800 })
  })
  return { textId: textObj.id, tableId }
}

/** A one-slide component doc written by the real master writer. */
function writeMaster(plan: PromoteToComponentPlan): Y.Doc {
  const doc = new Y.Doc()
  expect(writeComponentMaster(doc, plan.masterTree, plan.masterAnimations)).toBe(true)
  return doc
}

function masterObjects(doc: Y.Doc): SlideObject[] {
  const objects = doc.getArray<Y.Map<unknown>>('slides').get(0).get('objects') as Y.Array<
    Y.Map<unknown>
  >
  return objects.toArray().map((m) => yMapToPlainObject<SlideObject>(m))
}

describe('promote → stamp rich-text round trip', () => {
  it('keeps every text body delta (runs + paragraph attributes) for text objects and table cells', () => {
    const deckCtx = makeDeckCtx()
    const slideId = listSlides(deckCtx)[0]!.id
    const objCtx = getSlideObjectsCtx(deckCtx, slideId)!
    const { textId, tableId } = seedRichSlide(objCtx)
    const sources = objCtx.objects.toArray().map((m) => yMapToPlainObject<SlideObject>(m))
    const sourceText = bodies(sources.find((o) => o.id === textId)!)
    const sourceTable = bodies(sources.find((o) => o.id === tableId)!)
    // Sanity: the fixture really carries paragraph attributes.
    expect(JSON.stringify(sourceText)).toContain('bulletChar')
    expect(JSON.stringify(sourceTable)).toContain('lowerRoman')

    const plan = promoteToComponent(deckCtx, slideId, [textId, tableId], 'folder-1')
    // The plan travels as JSON (REST / worker boundary) — must survive it.
    const wire = JSON.parse(JSON.stringify(plan)) as PromoteToComponentPlan
    const master = writeMaster(wire)
    const inMaster = masterObjects(master)
    expect(bodies(inMaster.find((o) => o.id === textId)!)).toEqual(sourceText)
    expect(bodies(inMaster.find((o) => o.id === tableId)!)).toEqual(sourceTable)
    expectNoOpsMarker(master.getArray('slides'))

    const target = makeDeckCtx()
    const targetCtx = getSlideObjectsCtx(target, listSlides(target)[0]!.id)!
    stampComponent(targetCtx, master, { x: 0, y: 0 }, 'cmp')
    const stamped = targetCtx.objects.toArray().map((m) => yMapToPlainObject<SlideObject>(m))
    expect(bodies(stamped.find((o) => o.type === 'text')!)).toEqual(sourceText)
    expect(bodies(stamped.find((o) => o.type === 'table')!)).toEqual(sourceTable)
    expectNoOpsMarker(targetCtx.objects)
  })

  it('stamps rich text written directly in the master editor (no plan involved)', () => {
    const master = new Y.Doc()
    const masterCtx = (() => {
      const slides = master.getArray<Y.Map<unknown>>('slides')
      const slide = new Y.Map<unknown>()
      const objects = new Y.Array<Y.Map<unknown>>()
      master.transact(() => {
        slide.set('objects', objects)
        slides.push([slide])
      })
      return { doc: master, objects }
    })()
    const { textId, tableId } = seedRichSlide(masterCtx)
    const src = masterObjects(master)
    const target = makeDeckCtx()
    const targetCtx = getSlideObjectsCtx(target, listSlides(target)[0]!.id)!
    stampComponent(targetCtx, master, { x: 10, y: 10 }, 'cmp')
    const stamped = targetCtx.objects.toArray().map((m) => yMapToPlainObject<SlideObject>(m))
    expect(bodies(stamped.find((o) => o.type === 'text')!)).toEqual(
      bodies(src.find((o) => o.id === textId)!),
    )
    expect(bodies(stamped.find((o) => o.type === 'table')!)).toEqual(
      bodies(src.find((o) => o.id === tableId)!),
    )
  })

  it('remaps a token group to a fresh token per stamp, keeping its members together', () => {
    const deckCtx = makeDeckCtx()
    const slideId = listSlides(deckCtx)[0]!.id
    const objCtx = getSlideObjectsCtx(deckCtx, slideId)!
    seedRichSlide(objCtx)
    const plan = promoteToComponent(deckCtx, slideId, ['grp-a', 'grp-b'], 'folder-1')
    const masterGroup = (plan.masterTree[0] as RectangleObject).groupId
    expect(typeof masterGroup).toBe('string')
    const master = writeMaster(plan)

    const target = makeDeckCtx()
    const targetCtx = getSlideObjectsCtx(target, listSlides(target)[0]!.id)!
    stampComponent(targetCtx, master, { x: 0, y: 0 }, 'cmp')
    stampComponent(targetCtx, master, { x: 400, y: 0 }, 'cmp')
    const groups = targetCtx.objects
      .toArray()
      .map((m) => yMapToPlainObject<RectangleObject>(m).groupId)
    expect(groups.every((g) => typeof g === 'string')).toBe(true)
    expect(groups[0]).toBe(groups[1])
    expect(groups[2]).toBe(groups[3])
    expect(groups[0]).not.toBe(groups[2])
    expect(groups).not.toContain(masterGroup)
  })

  it('a stamp is one transaction with the local origin (one undo step)', () => {
    const master = makeMasterDoc([makeRect('a', 0, 0), makeText('t', 10, 10, 'hi')])
    const deckCtx = makeDeckCtx()
    const objCtx = getSlideObjectsCtx(deckCtx, listSlides(deckCtx)[0]!.id)!
    const origins: unknown[] = []
    const onTx = (tr: Y.Transaction) => origins.push(tr.origin)
    deckCtx.doc.on('afterTransaction', onTx)
    stampComponent(objCtx, master, { x: 0, y: 0 }, 'cmp')
    deckCtx.doc.off('afterTransaction', onTx)
    expect(origins).toEqual([LOCAL_ORIGIN])
  })
})

describe('writeComponentMaster', () => {
  it('writes the one master slide, empty for a new component', () => {
    const doc = new Y.Doc()
    expect(writeComponentMaster(doc, [], [])).toBe(true)
    const slides = doc.getArray<Y.Map<unknown>>('slides')
    expect(slides.length).toBe(1)
    expect(slides.get(0).get('id')).toBe(COMPONENT_MASTER_SLIDE_ID)
    expect((slides.get(0).get('objects') as Y.Array<unknown>).length).toBe(0)
    expect((slides.get(0).get('animations') as Y.Array<unknown>).length).toBe(0)
  })

  it('keeps the animations of the promoted subtree', () => {
    const deckCtx = makeDeckCtx()
    const slideId = listSlides(deckCtx)[0]!.id
    const objCtx = getSlideObjectsCtx(deckCtx, slideId)!
    const { textId } = seedRichSlide(objCtx)
    const plan = promoteToComponent(deckCtx, slideId, [textId], 'folder-1')
    const doc = new Y.Doc()
    writeComponentMaster(doc, plan.masterTree, [
      {
        id: 'a1',
        objectId: textId,
        preset: 'fadeIn',
        trigger: 'onEnter',
        duration: 0.5,
        delay: 0,
        easing: 'power2.out',
      },
    ])
    const animations = doc.getArray<Y.Map<unknown>>('slides').get(0).get('animations') as Y.Array<
      Y.Map<unknown>
    >
    expect(animations.length).toBe(1)
    expect(animations.get(0).get('objectId')).toBe(textId)
  })

  it('never writes over a master that is already there', () => {
    const doc = new Y.Doc()
    writeComponentMaster(doc, [], [])
    const deckCtx = makeDeckCtx()
    const slideId = listSlides(deckCtx)[0]!.id
    const { textId } = seedRichSlide(getSlideObjectsCtx(deckCtx, slideId)!)
    const plan = promoteToComponent(deckCtx, slideId, [textId], 'folder-1')
    expect(writeComponentMaster(doc, plan.masterTree, [])).toBe(false)
    expect(doc.getArray('slides').length).toBe(1)
    expect(masterObjects(doc)).toEqual([])
  })
})
