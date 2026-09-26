/**
 * writeComponentMasterTree.test.ts
 *
 * Drives the real master writer against an in-memory Hocuspocus stand-in
 * and checks the component doc it produces: rich text promoted from a
 * slide (text objects AND table cells, inline runs AND paragraph
 * attributes) must land in the master unchanged, no `_richTextOps` marker
 * may reach the CRDT, animations are written as before, and a stamp of
 * the resulting master reproduces every body exactly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as Y from 'yjs'
import type { AnimationStep, SlideObject, TextObject } from '@narrative/shared'
import {
  addAnimation,
  addObject,
  addTable,
  createSlideDoc,
  getSlideAnimationsCtx,
  getSlideObjectsCtx,
  getTableCellYMap,
  listSlides,
  promoteToComponent,
  stampComponent,
  yMapToAnimationStep,
  yMapToPlainObject,
} from '@narrative/slide-model'

// Every update the writer produces, so the test can rebuild the doc the
// server would have received (the writer destroys its own doc).
const captured = vi.hoisted(() => ({ updates: [] as Uint8Array[] }))

vi.mock('@hocuspocus/provider', () => {
  class HocuspocusProvider {
    private readonly handlers = new Map<string, Set<() => void>>()
    constructor(opts: { document: Y.Doc }) {
      opts.document.on('update', (u: Uint8Array) => captured.updates.push(u))
      // First sync of an empty, freshly-created component doc.
      queueMicrotask(() => this.handlers.get('synced')?.forEach((fn) => fn()))
    }
    on(event: string, fn: () => void): void {
      const set = this.handlers.get(event) ?? new Set()
      set.add(fn)
      this.handlers.set(event, set)
    }
    off(event: string, fn: () => void): void {
      this.handlers.get(event)?.delete(fn)
    }
    destroy(): void {}
  }
  return { HocuspocusProvider }
})

const { writeComponentMasterTree } = await import('./writeComponentMasterTree.js')

type DeltaOp = { insert: unknown; attributes?: Record<string, unknown> }

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

function expectNoOpsMarker(v: unknown): void {
  if (v instanceof Y.Map) {
    expect(v.has('_richTextOps')).toBe(false)
    v.forEach((sv) => expectNoOpsMarker(sv))
  } else if (v instanceof Y.Array) {
    v.forEach((sv) => expectNoOpsMarker(sv))
  }
}

describe('writeComponentMasterTree', () => {
  beforeEach(() => {
    captured.updates.length = 0
  })

  it('writes promoted rich text losslessly, and stamping the master keeps it', async () => {
    const deck = createSlideDoc()
    const slideId = listSlides(deck)[0]!.id
    const objCtx = getSlideObjectsCtx(deck, slideId)!
    addObject(objCtx, {
      id: 'txt',
      type: 'text',
      x: 10,
      y: 10,
      width: 300,
      height: 80,
      rotation: 0,
      opacity: 1,
      text: '',
      fontSize: 24,
      fontWeight: 'normal',
      color: 0,
      align: 'left',
    } as TextObject)
    const tableId = addTable(objCtx, { x: 10, y: 120, width: 300, height: 100, rows: 2, cols: 2 })
    const textY = objCtx.objects.get(0).get('text') as Y.Text
    const cellY = getTableCellYMap(objCtx, tableId, 1, 1)!.get('text') as Y.Text
    deck.doc.transact(() => {
      textY.insert(0, 'Title', { fontWeight: 700, fontFamily: 'Inter' })
      textY.insert(5, ' ', { list: 'bullet', level: 1, bulletChar: '◦' })
      textY.insert(6, 'body', { italic: true, color: 0x3366ff })
      cellY.insert(0, 'A', { underline: true, fontSize: 12 })
      cellY.insert(1, ' ', { list: 'number', numberFormat: 'decimalParen', startAt: 2 })
    })
    const step: Omit<AnimationStep, 'id'> = {
      objectId: 'txt',
      preset: 'fadeIn',
      trigger: 'onClick',
      duration: 0.4,
      delay: 0,
      easing: 'linear',
    }
    addAnimation(getSlideAnimationsCtx(deck, slideId)!, step)

    const sources = objCtx.objects.toArray().map((m) => yMapToPlainObject<SlideObject>(m))
    const plan = promoteToComponent(deck, slideId, ['txt', tableId], 'folder-1')
    await writeComponentMasterTree({
      componentId: plan.componentId,
      masterTree: plan.masterTree,
      masterAnimations: plan.masterAnimations,
    })

    const master = new Y.Doc()
    for (const u of captured.updates) Y.applyUpdate(master, u)
    const slides = master.getArray<Y.Map<unknown>>('slides')
    expect(slides.length).toBe(1)
    const slide = slides.get(0)
    expect(slide.get('id')).toBe('master')
    expectNoOpsMarker(slides)

    const masterObjs = (slide.get('objects') as Y.Array<Y.Map<unknown>>)
      .toArray()
      .map((m) => yMapToPlainObject<SlideObject>(m))
    for (const src of sources) {
      const inMaster = masterObjs.find((o) => o.id === src.id)
      expect(inMaster).toBeDefined()
      expect(bodies(inMaster!)).toEqual(bodies(src))
    }
    const anims = (slide.get('animations') as Y.Array<Y.Map<unknown>>)
      .toArray()
      .map((m) => yMapToAnimationStep(m))
    expect(anims).toEqual(plan.masterAnimations)

    const target = createSlideDoc()
    const targetCtx = getSlideObjectsCtx(target, listSlides(target)[0]!.id)!
    stampComponent(targetCtx, master, { x: 0, y: 0 })
    const stamped = targetCtx.objects.toArray().map((m) => yMapToPlainObject<SlideObject>(m))
    expect(bodies(stamped.find((o) => o.type === 'text')!)).toEqual(
      bodies(sources.find((o) => o.type === 'text')!),
    )
    expect(bodies(stamped.find((o) => o.type === 'table')!)).toEqual(
      bodies(sources.find((o) => o.type === 'table')!),
    )
  })
})
