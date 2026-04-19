/**
 * objectRenderers/ellipseRenderer.test.ts
 *
 * Unit testy pro ellipseRenderer.
 * Pixi.js je mockován — testy běží v Node/jsdom bez GPU.
 *
 * Testujeme:
 * - mount: vrací Container s Graphics child, aplikuje transform
 * - update: překreslí Graphics jen při změně vizuálních properties
 * - destroy: uvolní Graphics i Container
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
    pivot = { set: vi.fn() }

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
    // rect je potřeba pro rectangleRenderer mock kompatibilitu
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
import { Container, Graphics } from 'pixi.js'

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

describe('ellipseRenderer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('mount()', () => {
    it('vrátí Container instance', () => {
      const node = ellipseRenderer.mount(baseEllipse)
      expect(node).toBeInstanceOf(Container)
    })

    it('Container má Graphics child', () => {
      const node = ellipseRenderer.mount(baseEllipse)
      expect(node.children).toHaveLength(1)
      expect(node.children[0]).toBeInstanceOf(Graphics)
    })

    it('aplikuje transformaci — pozice (s pivot offsetem)', () => {
      const node = ellipseRenderer.mount(baseEllipse)
      // x = data.x + width/2 = 10 + 100 = 110
      expect(node.x).toBe(110)
      // y = data.y + height/2 = 20 + 50 = 70
      expect(node.y).toBe(70)
    })

    it('aplikuje rotation a opacity', () => {
      const rotated: EllipseObject = { ...baseEllipse, rotation: Math.PI / 4, opacity: 0.5 }
      const node = ellipseRenderer.mount(rotated)
      expect(node.rotation).toBe(Math.PI / 4)
      expect(node.alpha).toBe(0.5)
    })

    it('nastaví pivot na střed objektu', () => {
      const node = ellipseRenderer.mount(baseEllipse)
      expect(node.pivot.set).toHaveBeenCalledWith(baseEllipse.width / 2, baseEllipse.height / 2)
    })

    it('Graphics.ellipse je voláno se správnými parametry', () => {
      const node = ellipseRenderer.mount(baseEllipse)
      const graphics = node.children[0] as InstanceType<typeof Graphics>
      // ellipse(centerX, centerY, halfW, halfH)
      expect(graphics.ellipse).toHaveBeenCalledWith(
        baseEllipse.width / 2,
        baseEllipse.height / 2,
        baseEllipse.width / 2,
        baseEllipse.height / 2,
      )
    })

    it('Graphics.fill je voláno s fill color', () => {
      const node = ellipseRenderer.mount(baseEllipse)
      const graphics = node.children[0] as InstanceType<typeof Graphics>
      expect(graphics.fill).toHaveBeenCalledWith({ color: baseEllipse.fill })
    })
  })

  describe('update()', () => {
    it('aktualizuje pozici', () => {
      const node = ellipseRenderer.mount(baseEllipse)
      const next: EllipseObject = { ...baseEllipse, x: 50, y: 60 }
      ellipseRenderer.update(node, baseEllipse, next)
      // x = 50 + 100 = 150, y = 60 + 50 = 110
      expect(node.x).toBe(150)
      expect(node.y).toBe(110)
    })

    it('aktualizuje rotation a opacity', () => {
      const node = ellipseRenderer.mount(baseEllipse)
      const next: EllipseObject = { ...baseEllipse, rotation: 1.5, opacity: 0.3 }
      ellipseRenderer.update(node, baseEllipse, next)
      expect(node.rotation).toBe(1.5)
      expect(node.alpha).toBe(0.3)
    })

    it('překreslí Graphics při změně fill', () => {
      const node = ellipseRenderer.mount(baseEllipse)
      const graphics = node.children[0] as InstanceType<typeof Graphics>
      const clearCallsBefore = (graphics.clear as ReturnType<typeof vi.fn>).mock.calls.length

      const next: EllipseObject = { ...baseEllipse, fill: 0x0000ff }
      ellipseRenderer.update(node, baseEllipse, next)

      expect((graphics.clear as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(
        clearCallsBefore,
      )
    })

    it('překreslí Graphics při změně rozměrů', () => {
      const node = ellipseRenderer.mount(baseEllipse)
      const graphics = node.children[0] as InstanceType<typeof Graphics>
      const clearCallsBefore = (graphics.clear as ReturnType<typeof vi.fn>).mock.calls.length

      const next: EllipseObject = { ...baseEllipse, width: 300, height: 150 }
      ellipseRenderer.update(node, baseEllipse, next)

      expect((graphics.clear as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(
        clearCallsBefore,
      )
    })

    it('NEpřekreslí Graphics při pouhé změně pozice', () => {
      const node = ellipseRenderer.mount(baseEllipse)
      const graphics = node.children[0] as InstanceType<typeof Graphics>
      vi.clearAllMocks()

      const next: EllipseObject = { ...baseEllipse, x: 999, y: 999 }
      ellipseRenderer.update(node, baseEllipse, next)

      expect(graphics.clear).not.toHaveBeenCalled()
    })
  })

  describe('destroy()', () => {
    it('zničí Container', () => {
      const node = ellipseRenderer.mount(baseEllipse)
      ellipseRenderer.destroy(node)
      expect(node.destroyed).toBe(true)
    })

    it('zničí Graphics child', () => {
      const node = ellipseRenderer.mount(baseEllipse)
      const graphics = node.children[0] as InstanceType<typeof Graphics>
      ellipseRenderer.destroy(node)
      expect(graphics.destroyed).toBe(true)
    })
  })
})
