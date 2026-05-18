/**
 * bindings.test.ts
 *
 * Round-trip testy: plain object → Y.Map (uvnitř Y.Doc) → plain object musí být identity.
 *
 * POZOR: Y.Map musí být integrovaný v Y.Doc před čtením. Testy používají
 * plainObjectToYMapInDoc() helper který garantuje doc integraci.
 */

import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { plainObjectToYMap, yMapToPlainObject, plainObjectToYMapInDoc } from './bindings.js'
import type {
  RectangleObject,
  EllipseObject,
  TextObject,
  ImageObject,
  VideoObject,
  TableObject,
} from '@narrative/shared'
import { buildTable } from './tableMutations.js'

describe('plainObjectToYMap → yMapToPlainObject round-trip', () => {
  it('rectangle round-trip (v Y.Doc)', () => {
    const rect: RectangleObject = {
      id: 'rect-1',
      type: 'rectangle',
      x: 100,
      y: 200,
      width: 300,
      height: 150,
      fill: 0x4060e0,
      rotation: 0.5,
      opacity: 0.9,
    }

    const doc = new Y.Doc()
    const yMap = plainObjectToYMapInDoc(doc, rect)
    const result = yMapToPlainObject<RectangleObject>(yMap)

    expect(result).toEqual(rect)
  })

  it('ellipse round-trip (v Y.Doc)', () => {
    const ellipse: EllipseObject = {
      id: 'ellipse-1',
      type: 'ellipse',
      x: 50,
      y: 75,
      width: 180,
      height: 120,
      fill: 0xe06040,
      rotation: 0,
      opacity: 1,
    }

    const doc = new Y.Doc()
    const yMap = plainObjectToYMapInDoc(doc, ellipse)
    const result = yMapToPlainObject<EllipseObject>(yMap)

    expect(result).toEqual(ellipse)
  })

  it('text round-trip (v Y.Doc)', () => {
    const text: TextObject = {
      id: 'text-1',
      type: 'text',
      x: 10,
      y: 20,
      width: 240,
      height: 40,
      rotation: 0,
      opacity: 1,
      text: 'Hello World',
      fontSize: 24,
      fontWeight: 'bold',
      color: 0x333333,
      align: 'center',
    }

    const doc = new Y.Doc()
    const yMap = plainObjectToYMapInDoc(doc, text)
    const result = yMapToPlainObject<TextObject>(yMap)

    expect(result).toEqual(text)
  })

  it('Y.Map (v Y.Doc) obsahuje všechny fields', () => {
    const rect: RectangleObject = {
      id: 'test-id',
      type: 'rectangle',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      fill: 0,
      rotation: 0,
      opacity: 1,
    }

    const doc = new Y.Doc()
    const yMap = plainObjectToYMapInDoc(doc, rect)
    expect(yMap.get('id')).toBe('test-id')
    expect(yMap.get('type')).toBe('rectangle')
    expect(yMap.get('fill')).toBe(0)
  })

  it('image round-trip (v Y.Doc) — all fields including optional', () => {
    const image: ImageObject = {
      id: 'img-1',
      type: 'image',
      x: 50,
      y: 80,
      width: 400,
      height: 300,
      rotation: 0,
      opacity: 0.95,
      assetId: 'asset-abc123',
      variant: 'display',
      fit: 'cover',
      alt: 'A scenic mountain landscape',
    }

    const doc = new Y.Doc()
    const yMap = plainObjectToYMapInDoc(doc, image)
    const result = yMapToPlainObject<ImageObject>(yMap)

    expect(result).toEqual(image)
    expect(result.assetId).toBe('asset-abc123')
    expect(result.variant).toBe('display')
    expect(result.fit).toBe('cover')
    expect(result.alt).toBe('A scenic mountain landscape')
  })

  it('image round-trip — partial optional fields (no alt, contain fit)', () => {
    const image: ImageObject = {
      id: 'img-2',
      type: 'image',
      x: 0,
      y: 0,
      width: 200,
      height: 150,
      rotation: 0,
      opacity: 1,
      assetId: 'asset-xyz',
      variant: 'thumb',
      fit: 'contain',
    }

    const doc = new Y.Doc()
    const yMap = plainObjectToYMapInDoc(doc, image)
    const result = yMapToPlainObject<ImageObject>(yMap)

    expect(result).toEqual(image)
    expect(result.alt).toBeUndefined()
  })

  it('image round-trip — empty assetId (broken placeholder)', () => {
    const image: ImageObject = {
      id: 'img-3',
      type: 'image',
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      rotation: 0,
      opacity: 1,
      assetId: '',
      variant: 'display',
      fit: 'cover',
    }

    const doc = new Y.Doc()
    const yMap = plainObjectToYMapInDoc(doc, image)
    const result = yMapToPlainObject<ImageObject>(yMap)

    expect(result.assetId).toBe('')
    expect(result.type).toBe('image')
  })

  it('video round-trip (v Y.Doc) — all fields including optional', () => {
    const video: VideoObject = {
      id: 'vid-1',
      type: 'video',
      x: 100,
      y: 100,
      width: 640,
      height: 360,
      rotation: 0,
      opacity: 1,
      assetId: 'asset-vid-abc',
      fit: 'contain',
      autoplay: true,
      loop: true,
      muted: false,
      alt: 'Conference keynote recording',
    }

    const doc = new Y.Doc()
    const yMap = plainObjectToYMapInDoc(doc, video)
    const result = yMapToPlainObject<VideoObject>(yMap)

    expect(result).toEqual(video)
    expect(result.assetId).toBe('asset-vid-abc')
    expect(result.fit).toBe('contain')
    expect(result.autoplay).toBe(true)
    expect(result.loop).toBe(true)
    expect(result.muted).toBe(false)
    expect(result.alt).toBe('Conference keynote recording')
  })

  it('video round-trip — minimal required fields (no optional)', () => {
    const video: VideoObject = {
      id: 'vid-2',
      type: 'video',
      x: 0,
      y: 0,
      width: 640,
      height: 360,
      rotation: 0,
      opacity: 1,
      assetId: 'asset-vid-xyz',
    }

    const doc = new Y.Doc()
    const yMap = plainObjectToYMapInDoc(doc, video)
    const result = yMapToPlainObject<VideoObject>(yMap)

    expect(result).toEqual(video)
    expect(result.autoplay).toBeUndefined()
    expect(result.loop).toBeUndefined()
    expect(result.muted).toBeUndefined()
    expect(result.alt).toBeUndefined()
    expect(result.fit).toBeUndefined()
  })

  it('video round-trip — empty assetId (broken placeholder)', () => {
    const video: VideoObject = {
      id: 'vid-3',
      type: 'video',
      x: 0,
      y: 0,
      width: 640,
      height: 360,
      rotation: 0,
      opacity: 1,
      assetId: '',
      fit: 'contain',
      autoplay: false,
      loop: false,
      muted: true,
    }

    const doc = new Y.Doc()
    const yMap = plainObjectToYMapInDoc(doc, video)
    const result = yMapToPlainObject<VideoObject>(yMap)

    expect(result.assetId).toBe('')
    expect(result.type).toBe('video')
    expect(result.muted).toBe(true)
  })

  it('plainObjectToYMap stores a Y.Text reference under "text" without flattening it', () => {
    const doc = new Y.Doc()
    const yt = new Y.Text()
    yt.insert(0, 'hello')
    const text: TextObject = {
      id: 'text-yt',
      type: 'text',
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      rotation: 0,
      opacity: 1,
      text: yt,
      fontSize: 24,
      fontWeight: 'normal',
      color: 0,
      align: 'left',
    }
    const yMap = plainObjectToYMapInDoc(doc, text)
    const stored = yMap.get('text')
    // The Y.Text instance must be preserved by reference, not stringified
    // or cloned — collaborators rely on the same CRDT instance to apply
    // formatting.
    expect(stored).toBeInstanceOf(Y.Text)
    expect(stored).toBe(yt)
    expect((stored as Y.Text).toString()).toBe('hello')
  })

  it('yMapToPlainObject vyhodí na chybějícím type field', () => {
    // Prázdný Y.Map bez doc — entries() vrátí prázdno, type bude undefined
    // Alternativně: Y.Map v doc bez type field
    const doc = new Y.Doc()
    const arr = doc.getArray<Y.Map<unknown>>('test')
    const yMap = new Y.Map<unknown>()
    doc.transact(() => {
      yMap.set('id', 'broken')
      // type field záměrně chybí
      arr.push([yMap])
    })

    expect(() => yMapToPlainObject(yMap)).toThrow('missing required "type" field')
  })
})

describe('plainObjectToYMap (standalone — pouze pro write před insertem)', () => {
  it('plainObjectToYMap vrátí Y.Map (hodnoty čitelné až po integrace do doc)', () => {
    const rect: RectangleObject = {
      id: 'standalone',
      type: 'rectangle',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      fill: 0,
      rotation: 0,
      opacity: 1,
    }

    // plainObjectToYMap je určena pro insert do Y.Array.push()
    // Po insertu jsou hodnoty čitelné
    const doc = new Y.Doc()
    const arr = doc.getArray<Y.Map<unknown>>('objects')
    const yMap = plainObjectToYMap(rect)

    doc.transact(() => {
      arr.push([yMap])
    })

    // Nyní je yMap integrovaný v doc — hodnoty jsou čitelné
    expect(yMap.get('id')).toBe('standalone')
    expect(yMap.get('type')).toBe('rectangle')
  })

  it('table round-trip — 2×3 grid with nested Y.Array<Y.Array<Y.Map>>', async () => {
    // Build a fresh 2-row × 3-col table; verify the nested Yjs structure
    // survives a write → read cycle and lands back as a plain TableObject
    // with the same dimensions + cells. Uses `addObject` (mutations.ts)
    // because that's the only entry point that knows to apply per-cell
    // text inserts AFTER the table Y.Map is integrated — pending ops on
    // standalone Y.Text don't fire when integrated via nested Y.Array.
    const { addObject } = await import('./mutations.js')
    const table = buildTable({
      x: 100,
      y: 200,
      width: 300,
      height: 150,
      rows: 2,
      cols: 3,
    })
    // Seed a couple of cells with text so the Y.Text → string projection
    // gets exercised on the read side.
    table.rows[0]![0]!.text = 'A1'
    table.rows[1]![2]!.text = 'C2'
    table.rows[0]![1]!.fill = 0xff0000

    const doc = new Y.Doc()
    const arr = doc.getArray<Y.Map<unknown>>('objects')
    addObject({ doc, objects: arr }, table as never)
    const yMap = arr.get(0) as Y.Map<unknown>

    // Nested Yjs containers are now alive in the doc.
    const rowsY = yMap.get('rows') as Y.Array<Y.Array<Y.Map<unknown>>>
    expect(rowsY).toBeInstanceOf(Y.Array)
    expect(rowsY.length).toBe(2)
    expect((rowsY.get(0) as Y.Array<Y.Map<unknown>>).length).toBe(3)

    // Cell text is Y.Text in the live doc — projection back to plain
    // happens via yMapToPlainObject's table-aware path.
    const result = yMapToPlainObject<TableObject>(yMap)
    expect(result.type).toBe('table')
    expect(result.rows).toHaveLength(2)
    expect(result.rows[0]).toHaveLength(3)
    expect(result.colWidths).toHaveLength(3)
    expect(result.rowHeights).toHaveLength(2)
    // Y.Text values survive as Y.Text instances so the renderer can bind.
    expect(result.rows[0]![0]!.text).toBeInstanceOf(Y.Text)
    expect((result.rows[0]![0]!.text as Y.Text).toString()).toBe('A1')
    expect((result.rows[1]![2]!.text as Y.Text).toString()).toBe('C2')
    expect(result.rows[0]![1]!.fill).toBe(0xff0000)
  })
})
