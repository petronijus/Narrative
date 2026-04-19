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
import type { RectangleObject, EllipseObject, TextObject } from '@narrative/shared'

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
})
