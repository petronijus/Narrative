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
import type { RectangleObject, EllipseObject, ImageObject, VideoObject } from '@narrative/shared'

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

describe('image object type', () => {
  it('can be registered with expected defaults', () => {
    registerObjectType<ImageObject>({
      type: 'image',
      defaultProps: () => ({
        x: 100,
        y: 100,
        width: 400,
        height: 300,
        rotation: 0,
        opacity: 1,
        assetId: '',
        variant: 'display',
        fit: 'cover',
      }),
    })

    const def = getObjectTypeDef('image')
    expect(def).toBeDefined()
    expect(def?.type).toBe('image')

    const defaults = def?.defaultProps() as Omit<ImageObject, 'id' | 'type'>
    expect(defaults.assetId).toBe('')
    expect(defaults.variant).toBe('display')
    expect(defaults.fit).toBe('cover')
    expect(defaults.width).toBe(400)
    expect(defaults.height).toBe(300)
  })

  it('image type appears in listRegisteredTypes after registration', () => {
    registerObjectType<ImageObject>({
      type: 'image',
      defaultProps: () => ({
        x: 100,
        y: 100,
        width: 400,
        height: 300,
        rotation: 0,
        opacity: 1,
        assetId: '',
        variant: 'display',
        fit: 'cover',
      }),
    })

    expect(listRegisteredTypes()).toContain('image')
  })
})

describe('video object type', () => {
  it('can be registered with expected defaults', () => {
    registerObjectType<VideoObject>({
      type: 'video',
      defaultProps: () => ({
        x: 100,
        y: 100,
        width: 640,
        height: 360,
        rotation: 0,
        opacity: 1,
        assetId: '',
        fit: 'contain',
        autoplay: false,
        loop: false,
        muted: true,
      }),
    })

    const def = getObjectTypeDef('video')
    expect(def).toBeDefined()
    expect(def?.type).toBe('video')

    const defaults = def?.defaultProps() as Omit<VideoObject, 'id' | 'type'>
    expect(defaults.assetId).toBe('')
    expect(defaults.fit).toBe('contain')
    expect(defaults.autoplay).toBe(false)
    expect(defaults.loop).toBe(false)
    expect(defaults.muted).toBe(true)
    expect(defaults.width).toBe(640)
    expect(defaults.height).toBe(360)
  })

  it('video type appears in listRegisteredTypes after registration', () => {
    registerObjectType<VideoObject>({
      type: 'video',
      defaultProps: () => ({
        x: 100,
        y: 100,
        width: 640,
        height: 360,
        rotation: 0,
        opacity: 1,
        assetId: '',
        fit: 'contain',
        autoplay: false,
        loop: false,
        muted: true,
      }),
    })

    expect(listRegisteredTypes()).toContain('video')
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
