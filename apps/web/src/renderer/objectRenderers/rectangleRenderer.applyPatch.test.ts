/**
 * objectRenderers/rectangleRenderer.applyPatch.test.ts
 *
 * Unit testy pro rectangleRenderer.applyPatch() — M3 chirurgický patch update.
 *
 * Pixi.js je mockován — testy běží v Node/jsdom bez GPU.
 *
 * Testujeme:
 * - Patch { x } → mění pouze pozici, NEredrawuje fill/Graphics
 * - Patch { fill } → redrawuje Graphics
 * - Patch { width } → redrawuje Graphics s novou geometrií + přepočítá pivot+pozici
 * - Kombinované patche
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { pixiMock } from '../../test/pixiMock'

vi.mock('pixi.js', () => pixiMock())

import { rectangleRenderer } from './rectangleRenderer'
import type { RectangleObject } from '../types'
import type { Graphics } from 'pixi.js'

const baseRect: RectangleObject = {
  id: 'r1',
  type: 'rectangle',
  x: 10,
  y: 20,
  width: 100,
  height: 80,
  fill: 0xff0000,
  rotation: 0,
  opacity: 1,
}

describe('rectangleRenderer.applyPatch()', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('existuje na rendereru', () => {
    expect(rectangleRenderer.applyPatch).toBeDefined()
  })

  describe('pozice — pouze x nebo y', () => {
    it('patch { x } mění node.x, NEredrawuje Graphics', () => {
      const node = rectangleRenderer.mount(baseRect)
      const graphics = node.children[0] as InstanceType<typeof Graphics>
      vi.clearAllMocks()

      rectangleRenderer.applyPatch!(node, { x: 999 })

      // x = patch.x + pivot.x (pivot.x = width/2 = 50)
      expect(node.x).toBe(999 + 50)
      // Graphics.clear nesmí být volán
      expect(graphics.clear).not.toHaveBeenCalled()
    })

    it('patch { y } mění node.y, NEredrawuje Graphics', () => {
      const node = rectangleRenderer.mount(baseRect)
      const graphics = node.children[0] as InstanceType<typeof Graphics>
      vi.clearAllMocks()

      rectangleRenderer.applyPatch!(node, { y: 500 })

      // y = patch.y + pivot.y (pivot.y = height/2 = 40)
      expect(node.y).toBe(500 + 40)
      expect(graphics.clear).not.toHaveBeenCalled()
    })

    it('patch { x, y } mění obě pozice bez redrawu', () => {
      const node = rectangleRenderer.mount(baseRect)
      const graphics = node.children[0] as InstanceType<typeof Graphics>
      vi.clearAllMocks()

      rectangleRenderer.applyPatch!(node, { x: 100, y: 200 })

      expect(node.x).toBe(100 + 50)
      expect(node.y).toBe(200 + 40)
      expect(graphics.clear).not.toHaveBeenCalled()
    })
  })

  describe('fill', () => {
    it('patch { fill } redrawuje Graphics', () => {
      const node = rectangleRenderer.mount(baseRect)
      const graphics = node.children[0] as InstanceType<typeof Graphics>
      vi.clearAllMocks()

      rectangleRenderer.applyPatch!(node, { fill: 0x0000ff })

      expect(graphics.clear).toHaveBeenCalled()
      expect(graphics.fill).toHaveBeenCalledWith({ color: 0x0000ff })
    })

    it('patch { fill } NEmění pozici', () => {
      const node = rectangleRenderer.mount(baseRect)
      const xBefore = node.x
      const yBefore = node.y
      vi.clearAllMocks()

      rectangleRenderer.applyPatch!(node, { fill: 0x00ff00 })

      expect(node.x).toBe(xBefore)
      expect(node.y).toBe(yBefore)
    })
  })

  describe('geometry — width nebo height', () => {
    it('patch { width } redrawuje Graphics s novou šířkou', () => {
      const node = rectangleRenderer.mount(baseRect)
      const graphics = node.children[0] as InstanceType<typeof Graphics>
      vi.clearAllMocks()

      rectangleRenderer.applyPatch!(node, { width: 200 })

      expect(graphics.clear).toHaveBeenCalled()
      expect(graphics.rect).toHaveBeenCalledWith(0, 0, 200, baseRect.height)
    })

    it('patch { width } přepočítá pivot.x a node.x', () => {
      const node = rectangleRenderer.mount(baseRect)
      vi.clearAllMocks()

      // Původní: data.x = 10, width = 100, pivot.x = 50, node.x = 60
      // Po patch { width: 200 }: pivot.x = 100, node.x = data.x + 100 = 110
      rectangleRenderer.applyPatch!(node, { width: 200 })

      expect(node.pivot.x).toBe(100)
      expect(node.x).toBe(10 + 100) // data.x + newPivotX
    })

    it('patch { height } redrawuje Graphics s novou výškou', () => {
      const node = rectangleRenderer.mount(baseRect)
      const graphics = node.children[0] as InstanceType<typeof Graphics>
      vi.clearAllMocks()

      rectangleRenderer.applyPatch!(node, { height: 160 })

      expect(graphics.clear).toHaveBeenCalled()
      expect(graphics.rect).toHaveBeenCalledWith(0, 0, baseRect.width, 160)
    })
  })

  describe('rotation a opacity', () => {
    it('patch { rotation } mění node.rotation, NEredrawuje', () => {
      const node = rectangleRenderer.mount(baseRect)
      const graphics = node.children[0] as InstanceType<typeof Graphics>
      vi.clearAllMocks()

      rectangleRenderer.applyPatch!(node, { rotation: Math.PI / 4 })

      expect(node.rotation).toBeCloseTo(Math.PI / 4)
      expect(graphics.clear).not.toHaveBeenCalled()
    })

    it('patch { opacity } mění node.alpha, NEredrawuje', () => {
      const node = rectangleRenderer.mount(baseRect)
      const graphics = node.children[0] as InstanceType<typeof Graphics>
      vi.clearAllMocks()

      rectangleRenderer.applyPatch!(node, { opacity: 0.5 })

      expect(node.alpha).toBe(0.5)
      expect(graphics.clear).not.toHaveBeenCalled()
    })
  })

  describe('kombinované patche', () => {
    it('patch { x, fill } repozice + redraw', () => {
      const node = rectangleRenderer.mount(baseRect)
      const graphics = node.children[0] as InstanceType<typeof Graphics>
      vi.clearAllMocks()

      rectangleRenderer.applyPatch!(node, { x: 300, fill: 0xffffff })

      expect(node.x).toBe(300 + 50)
      expect(graphics.clear).toHaveBeenCalled()
      expect(graphics.fill).toHaveBeenCalledWith({ color: 0xffffff })
    })
  })
})
