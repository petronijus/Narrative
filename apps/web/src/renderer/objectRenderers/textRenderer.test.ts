/**
 * objectRenderers/textRenderer.test.ts
 *
 * Unit testy pro textRenderer.
 * Pixi.js je mockován — testy běží v Node/jsdom bez GPU.
 *
 * Testujeme:
 * - mount: vrací Container s Text node, aplikuje transform
 * - update: aktualizuje text/style properties s minimálním rebuild
 * - destroy: uvolní Text node a Container
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

  class MockTextStyle {
    fontFamily: string
    fontSize: number
    fontWeight: string
    fill: string
    align: string
    wordWrap: boolean
    wordWrapWidth: number

    constructor(opts: {
      fontFamily: string
      fontSize: number
      fontWeight: string
      fill: string
      align: string
      wordWrap: boolean
      wordWrapWidth: number
    }) {
      this.fontFamily = opts.fontFamily
      this.fontSize = opts.fontSize
      this.fontWeight = opts.fontWeight
      this.fill = opts.fill
      this.align = opts.align
      this.wordWrap = opts.wordWrap
      this.wordWrapWidth = opts.wordWrapWidth
    }
  }

  class MockText extends MockContainer {
    text: string
    style: MockTextStyle

    constructor(opts: { text: string; style: MockTextStyle }) {
      super()
      this.text = opts.text
      this.style = opts.style
    }
  }

  class MockGraphics extends MockContainer {
    clear = vi.fn().mockReturnThis()
    rect = vi.fn().mockReturnThis()
    ellipse = vi.fn().mockReturnThis()
    fill = vi.fn().mockReturnThis()
  }

  return {
    Container: MockContainer,
    Graphics: MockGraphics,
    Text: MockText,
    TextStyle: MockTextStyle,
    Application: vi.fn(),
    Point: vi.fn(),
  }
})

import { textRenderer } from './textRenderer'
import type { TextObject } from '../types'
import { Container, Text } from 'pixi.js'

const baseText: TextObject = {
  id: 't1',
  type: 'text',
  x: 50,
  y: 100,
  width: 300,
  height: 200,
  text: 'Hello World',
  fontSize: 24,
  fontWeight: 'normal',
  color: 0x000000,
  align: 'left',
  rotation: 0,
  opacity: 1,
}

describe('textRenderer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('mount()', () => {
    it('vrátí Container instance', () => {
      const node = textRenderer.mount(baseText)
      expect(node).toBeInstanceOf(Container)
    })

    it('Container má Text child', () => {
      const node = textRenderer.mount(baseText)
      expect(node.children).toHaveLength(1)
      expect(node.children[0]).toBeInstanceOf(Text)
    })

    it('Text node má správný text content', () => {
      const node = textRenderer.mount(baseText)
      const textNode = node.children[0] as InstanceType<typeof Text>
      expect(textNode.text).toBe('Hello World')
    })

    it('aplikuje transformaci — pozice (s pivot offsetem)', () => {
      const node = textRenderer.mount(baseText)
      // x = 50 + 300/2 = 200, y = 100 + 200/2 = 200
      expect(node.x).toBe(200)
      expect(node.y).toBe(200)
    })

    it('aplikuje rotation a opacity', () => {
      const rotated: TextObject = { ...baseText, rotation: Math.PI / 6, opacity: 0.7 }
      const node = textRenderer.mount(rotated)
      expect(node.rotation).toBe(Math.PI / 6)
      expect(node.alpha).toBe(0.7)
    })

    it('nastaví pivot na střed objektu', () => {
      const node = textRenderer.mount(baseText)
      expect(node.pivot.set).toHaveBeenCalledWith(baseText.width / 2, baseText.height / 2)
    })

    it('TextStyle má wordWrap aktivní s wordWrapWidth = data.width', () => {
      const node = textRenderer.mount(baseText)
      const textNode = node.children[0] as InstanceType<typeof Text>
      expect(textNode.style.wordWrap).toBe(true)
      expect(textNode.style.wordWrapWidth).toBe(baseText.width)
    })

    it('TextStyle fill je CSS hex string z color čísla', () => {
      const colored: TextObject = { ...baseText, color: 0xff3300 }
      const node = textRenderer.mount(colored)
      const textNode = node.children[0] as InstanceType<typeof Text>
      expect(textNode.style.fill).toBe('#ff3300')
    })

    it('TextStyle fontSize odpovídá data.fontSize', () => {
      const big: TextObject = { ...baseText, fontSize: 48 }
      const node = textRenderer.mount(big)
      const textNode = node.children[0] as InstanceType<typeof Text>
      expect(textNode.style.fontSize).toBe(48)
    })

    it('TextStyle fontWeight odpovídá data.fontWeight (bold)', () => {
      const bold: TextObject = { ...baseText, fontWeight: 'bold' }
      const node = textRenderer.mount(bold)
      const textNode = node.children[0] as InstanceType<typeof Text>
      expect(textNode.style.fontWeight).toBe('bold')
    })

    it('TextStyle align odpovídá data.align (center)', () => {
      const centered: TextObject = { ...baseText, align: 'center' }
      const node = textRenderer.mount(centered)
      const textNode = node.children[0] as InstanceType<typeof Text>
      expect(textNode.style.align).toBe('center')
    })
  })

  describe('update()', () => {
    it('aktualizuje text content při změně text property', () => {
      const node = textRenderer.mount(baseText)
      const textNode = node.children[0] as InstanceType<typeof Text>

      const next: TextObject = { ...baseText, text: 'Updated text' }
      textRenderer.update(node, baseText, next)

      expect(textNode.text).toBe('Updated text')
    })

    it('NEaktualizuje text content když je text stejný', () => {
      const node = textRenderer.mount(baseText)
      const textNode = node.children[0] as InstanceType<typeof Text>
      const originalText = textNode.text

      const next: TextObject = { ...baseText, x: 999 } // změna pozice, ne textu
      textRenderer.update(node, baseText, next)

      expect(textNode.text).toBe(originalText)
    })

    it('aktualizuje style při změně fontSize', () => {
      const node = textRenderer.mount(baseText)
      const textNode = node.children[0] as InstanceType<typeof Text>
      const originalStyle = textNode.style

      const next: TextObject = { ...baseText, fontSize: 36 }
      textRenderer.update(node, baseText, next)

      // Style by měl být nová instance
      expect(textNode.style).not.toBe(originalStyle)
      expect(textNode.style.fontSize).toBe(36)
    })

    it('aktualizuje style při změně color', () => {
      const node = textRenderer.mount(baseText)
      const textNode = node.children[0] as InstanceType<typeof Text>

      const next: TextObject = { ...baseText, color: 0x0066ff }
      textRenderer.update(node, baseText, next)

      expect(textNode.style.fill).toBe('#0066ff')
    })

    it('aktualizuje style při změně fontWeight', () => {
      const node = textRenderer.mount(baseText)
      const textNode = node.children[0] as InstanceType<typeof Text>

      const next: TextObject = { ...baseText, fontWeight: 'bold' }
      textRenderer.update(node, baseText, next)

      expect(textNode.style.fontWeight).toBe('bold')
    })

    it('aktualizuje style při změně align', () => {
      const node = textRenderer.mount(baseText)
      const textNode = node.children[0] as InstanceType<typeof Text>

      const next: TextObject = { ...baseText, align: 'right' }
      textRenderer.update(node, baseText, next)

      expect(textNode.style.align).toBe('right')
    })

    it('aktualizuje style při změně width (wordWrapWidth)', () => {
      const node = textRenderer.mount(baseText)
      const textNode = node.children[0] as InstanceType<typeof Text>

      const next: TextObject = { ...baseText, width: 500 }
      textRenderer.update(node, baseText, next)

      expect(textNode.style.wordWrapWidth).toBe(500)
    })

    it('NErebuilduje style při změně pouze pozice/rotace/opacity', () => {
      const node = textRenderer.mount(baseText)
      const textNode = node.children[0] as InstanceType<typeof Text>
      const originalStyle = textNode.style

      const next: TextObject = { ...baseText, x: 999, y: 999, rotation: 1, opacity: 0.5 }
      textRenderer.update(node, baseText, next)

      expect(textNode.style).toBe(originalStyle)
    })

    it('aktualizuje pozici', () => {
      const node = textRenderer.mount(baseText)

      const next: TextObject = { ...baseText, x: 200, y: 300 }
      textRenderer.update(node, baseText, next)

      // x = 200 + 300/2 = 350, y = 300 + 200/2 = 400
      expect(node.x).toBe(350)
      expect(node.y).toBe(400)
    })
  })

  describe('destroy()', () => {
    it('zničí Container', () => {
      const node = textRenderer.mount(baseText)
      textRenderer.destroy(node)
      expect(node.destroyed).toBe(true)
    })

    it('zničí Text child', () => {
      const node = textRenderer.mount(baseText)
      const textNode = node.children[0] as InstanceType<typeof Text>
      textRenderer.destroy(node)
      expect(textNode.destroyed).toBe(true)
    })
  })
})
