/**
 * registry.test.ts
 *
 * Testy pro object type registry.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  registerObjectType,
  getObjectTypeDef,
  listRegisteredTypes,
  _clearRegistry,
} from './registry.js'
import type { RectangleObject, EllipseObject } from '@narrative/shared'

beforeEach(() => {
  _clearRegistry()
})

describe('registerObjectType', () => {
  it('zaregistruje nový typ', () => {
    registerObjectType<RectangleObject>({
      type: 'rectangle',
      defaultProps: () => ({
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        fill: 0xff0000,
        rotation: 0,
        opacity: 1,
      }),
    })

    expect(getObjectTypeDef('rectangle')).toBeDefined()
  })

  it('vyhodí chybu při duplicitní registraci stejného typu', () => {
    registerObjectType<RectangleObject>({
      type: 'rectangle',
      defaultProps: () => ({
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        fill: 0xff0000,
        rotation: 0,
        opacity: 1,
      }),
    })

    expect(() =>
      registerObjectType<RectangleObject>({
        type: 'rectangle',
        defaultProps: () => ({
          x: 0,
          y: 0,
          width: 200,
          height: 200,
          fill: 0x00ff00,
          rotation: 0,
          opacity: 1,
        }),
      }),
    ).toThrow("Object type 'rectangle' is already registered")
  })
})

describe('getObjectTypeDef', () => {
  it('vrátí undefined pro neregistrovaný typ', () => {
    expect(getObjectTypeDef('rectangle')).toBeUndefined()
  })

  it('vrátí def po registraci', () => {
    registerObjectType<EllipseObject>({
      type: 'ellipse',
      defaultProps: () => ({
        x: 10,
        y: 10,
        width: 50,
        height: 50,
        fill: 0x0000ff,
        rotation: 0,
        opacity: 1,
      }),
    })

    const def = getObjectTypeDef('ellipse')
    expect(def).toBeDefined()
    expect(def?.type).toBe('ellipse')
    expect(def?.defaultProps().width).toBe(50)
  })
})

describe('listRegisteredTypes', () => {
  it('vrátí prázdné pole když nic není registrováno', () => {
    expect(listRegisteredTypes()).toEqual([])
  })

  it('vrátí všechny registrované typy', () => {
    registerObjectType<RectangleObject>({
      type: 'rectangle',
      defaultProps: () => ({ x: 0, y: 0, width: 10, height: 10, fill: 0, rotation: 0, opacity: 1 }),
    })
    registerObjectType<EllipseObject>({
      type: 'ellipse',
      defaultProps: () => ({ x: 0, y: 0, width: 10, height: 10, fill: 0, rotation: 0, opacity: 1 }),
    })

    const types = listRegisteredTypes()
    expect(types).toHaveLength(2)
    expect(types).toContain('rectangle')
    expect(types).toContain('ellipse')
  })
})
