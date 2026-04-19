/**
 * objectRenderers/ellipseRenderer.applyPatch.test.ts
 *
 * Unit testy pro ellipseRenderer.applyPatch() — M3 chirurgický patch update.
 *
 * Pixi.js je mockován — testy běží v Node/jsdom bez GPU.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('pixi.js', () => {
  class MockContainer {
    children: MockContainer[] = []
    destroyed = false
    x = 0
    y = 0
    rotation = 0
    alpha = 1
    pivot = {
      x: 0,
      y: 0,
      set: vi.fn(function (this: { x: number; y: number }, x: number, y: number) {
        this.x = x
        this.y = y
      }),
    }

    addChild(child: MockContainer): MockContainer {
      this.children.push(child)
      return child
    }

    removeChild(child: MockContainer): MockContainer {
      this.children = this.children.filter((c) => c !== child)
      return child
    }

    destroy(): void {
      this.destroyed = true
    }
  }

  class MockGraphics extends MockContainer {
    clear = vi.fn().mockReturnThis()
    ellipse = vi.fn().mockReturnThis()
    fill = vi.fn().mockReturnThis()
    rect = vi.fn().mockReturnThis()
  }

  return {
    Container: MockContainer,
    Graphics: MockGraphics,
    Application: vi.fn(),
    Text: vi.fn(),
    TextStyle: vi.fn(),
    Point: vi.fn(),
  }
})

import { ellipseRenderer } from './ellipseRenderer'
import type { EllipseObject } from '../types'
import type { Graphics } from 'pixi.js'

const baseEllipse: EllipseObject = {
  id: 'e1',
  type: 'ellipse',
  x: 10,
  y: 20,
  width: 200,
  height: 100,
  fill: 0xff0000,
  rotation: 0,
  opacity: 1,
}

describe('ellipseRenderer.applyPatch()', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('existuje na rendereru', () => {
    expect(ellipseRenderer.applyPatch).toBeDefined()
  })

  describe('pozice', () => {
    it('patch { x } mění node.x, NEredrawuje Graphics', () => {
      const node = ellipseRenderer.mount(baseEllipse)
      const graphics = node.children[0] as InstanceType<typeof Graphics>
      vi.clearAllMocks()

      ellipseRenderer.applyPatch!(node, { x: 999 })

      // x = patch.x + pivot.x (pivot.x = width/2 = 100)
      expect(node.x).toBe(999 + 100)
      expect(graphics.clear).not.toHaveBeenCalled()
    })

    it('patch { y } mění node.y, NEredrawuje Graphics', () => {
      const node = ellipseRenderer.mount(baseEllipse)
      const graphics = node.children[0] as InstanceType<typeof Graphics>
      vi.clearAllMocks()

      ellipseRenderer.applyPatch!(node, { y: 500 })

      // y = patch.y + pivot.y (pivot.y = height/2 = 50)
      expect(node.y).toBe(500 + 50)
      expect(graphics.clear).not.toHaveBeenCalled()
    })
  })

  describe('fill', () => {
    it('patch { fill } redrawuje Graphics', () => {
      const node = ellipseRenderer.mount(baseEllipse)
      const graphics = node.children[0] as InstanceType<typeof Graphics>
      vi.clearAllMocks()

      ellipseRenderer.applyPatch!(node, { fill: 0x0000ff })

      expect(graphics.clear).toHaveBeenCalled()
      expect(graphics.fill).toHaveBeenCalledWith({ color: 0x0000ff })
    })

    it('patch { fill } NEmění pozici', () => {
      const node = ellipseRenderer.mount(baseEllipse)
      const xBefore = node.x
      const yBefore = node.y
      vi.clearAllMocks()

      ellipseRenderer.applyPatch!(node, { fill: 0x00ff00 })

      expect(node.x).toBe(xBefore)
      expect(node.y).toBe(yBefore)
    })
  })

  describe('geometry', () => {
    it('patch { width } redrawuje Graphics s novou geometrií', () => {
      const node = ellipseRenderer.mount(baseEllipse)
      const graphics = node.children[0] as InstanceType<typeof Graphics>
      vi.clearAllMocks()

      ellipseRenderer.applyPatch!(node, { width: 300 })

      expect(graphics.clear).toHaveBeenCalled()
      // ellipse(centerX, centerY, halfW, halfH) — newWidth=300, currentHeight=100
      expect(graphics.ellipse).toHaveBeenCalledWith(150, 50, 150, 50)
    })

    it('patch { width } přepočítá pivot.x a node.x', () => {
      const node = ellipseRenderer.mount(baseEllipse)
      vi.clearAllMocks()

      // Původní: data.x=10, width=200, pivot.x=100, node.x=110
      // Po patch { width: 300 }: pivot.x=150, node.x = 10 + 150 = 160
      ellipseRenderer.applyPatch!(node, { width: 300 })

      expect(node.pivot.x).toBe(150)
      expect(node.x).toBe(10 + 150)
    })

    it('patch { height } redrawuje Graphics s novou výškou', () => {
      const node = ellipseRenderer.mount(baseEllipse)
      const graphics = node.children[0] as InstanceType<typeof Graphics>
      vi.clearAllMocks()

      ellipseRenderer.applyPatch!(node, { height: 200 })

      expect(graphics.clear).toHaveBeenCalled()
      // ellipse: currentWidth=200, newHeight=200
      expect(graphics.ellipse).toHaveBeenCalledWith(100, 100, 100, 100)
    })
  })

  describe('rotation a opacity', () => {
    it('patch { rotation } mění node.rotation, NEredrawuje', () => {
      const node = ellipseRenderer.mount(baseEllipse)
      const graphics = node.children[0] as InstanceType<typeof Graphics>
      vi.clearAllMocks()

      ellipseRenderer.applyPatch!(node, { rotation: 1.5 })

      expect(node.rotation).toBe(1.5)
      expect(graphics.clear).not.toHaveBeenCalled()
    })

    it('patch { opacity } mění node.alpha, NEredrawuje', () => {
      const node = ellipseRenderer.mount(baseEllipse)
      const graphics = node.children[0] as InstanceType<typeof Graphics>
      vi.clearAllMocks()

      ellipseRenderer.applyPatch!(node, { opacity: 0.3 })

      expect(node.alpha).toBe(0.3)
      expect(graphics.clear).not.toHaveBeenCalled()
    })
  })
})
