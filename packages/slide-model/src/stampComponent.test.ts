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
import { stampComponent } from './stampComponent.js'

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

    const ids = stampComponent(objCtx, masterDoc, { x: 50, y: 50 })

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

    const ids = stampComponent(objCtx, masterDoc, { x: 0, y: 0 })

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

    stampComponent(objCtx, masterDoc, { x: 500, y: 600 })

    const o1 = yMapToPlainObject<RectangleObject>(objCtx.objects.get(0))
    const o2 = yMapToPlainObject<RectangleObject>(objCtx.objects.get(1))
    // (100,200) → (500,600); (150,240) → (550,640) — same delta.
    expect(o1.x).toBe(500)
    expect(o1.y).toBe(600)
    expect(o2.x).toBe(550)
    expect(o2.y).toBe(640)
  })

  it('does not modify the master when stamped', () => {
    const deckCtx = makeDeckCtx()
    const slideId = listSlides(deckCtx)[0]!.id
    const objCtx = getSlideObjectsCtx(deckCtx, slideId)!
    const masterDoc = makeMasterDoc([makeRect('master-rect-1', 100, 100)])

    stampComponent(objCtx, masterDoc, { x: 999, y: 999 })

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

    const ids = stampComponent(objCtx, masterDoc, { x: 0, y: 0 })
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

    stampComponent(objCtx, masterDoc, { x: 0, y: 0 })
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

    const ids = stampComponent(objCtx, masterDoc, { x: 0, y: 0 })
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
