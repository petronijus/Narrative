/**
 * objectRenderers/textRenderer.applyPatch.test.ts
 *
 * Unit testy pro textRenderer.applyPatch() — M3 chirurgický patch update.
 *
 * Pixi.js je mockován — testy běží v Node/jsdom bez GPU.
 *
 * Klíčová invarianta: změna x/y/rotation/opacity NESMÍ rebuildit TextStyle.
 * Změna text NESMÍ rebuildit TextStyle (jen textNode.text = patch.text).
 * Změna fontSize/fontWeight/color/align/width → mění TextStyle properties.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock TextStyle s mutable properties a spy objektem
const _mockStyleInstance = {
  fontSize: 16,
  fontWeight: 'normal' as 'normal' | 'bold',
  fill: '#000000',
  align: 'left' as 'left' | 'center' | 'right',
  wordWrapWidth: 300,
}

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

  class MockText extends MockContainer {
    text = ''
    style: Record<string, unknown> = {
      fontSize: 16,
      fontWeight: 'normal',
      fill: '#000000',
      align: 'left',
      wordWrapWidth: 300,
    }

    constructor(opts: { text: string; style: Record<string, unknown> }) {
      super()
      this.text = opts.text
      this.style = { ...opts.style }
    }

    override destroy(): void {
      super.destroy()
    }
  }

  class MockTextStyle {
    fontSize = 16
    fontWeight: 'normal' | 'bold' = 'normal'
    fill = '#000000'
    align: 'left' | 'center' | 'right' = 'left'
    wordWrap = true
    wordWrapWidth = 300
    fontFamily = 'system-ui'

    constructor(opts: Record<string, unknown>) {
      Object.assign(this, opts)
    }
  }

  class MockGraphics extends MockContainer {
    clear = vi.fn().mockReturnThis()
    rect = vi.fn().mockReturnThis()
    fill = vi.fn().mockReturnThis()
  }

  return {
    Container: MockContainer,
    Graphics: MockGraphics,
    Text: MockText,
    TextStyle: MockTextStyle,
    Application: vi.fn(),
  }
})

import { textRenderer } from './textRenderer'
import type { TextObject } from '../types'
import type { Text } from 'pixi.js'

const baseText: TextObject = {
  id: 't1',
  type: 'text',
  x: 10,
  y: 20,
  width: 300,
  height: 100,
  text: 'Hello World',
  fontSize: 16,
  fontWeight: 'normal',
  color: 0x000000,
  align: 'left',
  rotation: 0,
  opacity: 1,
}

describe('textRenderer.applyPatch()', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('existuje na rendereru', () => {
    expect(textRenderer.applyPatch).toBeDefined()
  })

  describe('pozice — NErebuildí TextStyle', () => {
    it('patch { x } mění node.x, textNode.style.wordWrapWidth se nemění', () => {
      const node = textRenderer.mount(baseText)
      const textNode = node.children[0] as InstanceType<typeof Text>
      const styleBefore = textNode.style
      vi.clearAllMocks()

      textRenderer.applyPatch!(node, { x: 999 })

      // x = patch.x + pivot.x (pivot.x = width/2 = 150)
      expect(node.x).toBe(999 + 150)
      // style reference se nesmí změnit (žádný rebuild)
      expect(textNode.style).toBe(styleBefore)
    })

    it('patch { y } mění node.y bez style rebuild', () => {
      const node = textRenderer.mount(baseText)
      const textNode = node.children[0] as InstanceType<typeof Text>
      const styleBefore = textNode.style
      vi.clearAllMocks()

      textRenderer.applyPatch!(node, { y: 500 })

      expect(node.y).toBe(500 + 50)
      expect(textNode.style).toBe(styleBefore)
    })

    it('patch { rotation } mění node.rotation bez style rebuild', () => {
      const node = textRenderer.mount(baseText)
      const textNode = node.children[0] as InstanceType<typeof Text>
      const styleBefore = textNode.style
      vi.clearAllMocks()

      textRenderer.applyPatch!(node, { rotation: 1.2 })

      expect(node.rotation).toBe(1.2)
      expect(textNode.style).toBe(styleBefore)
    })

    it('patch { opacity } mění node.alpha bez style rebuild', () => {
      const node = textRenderer.mount(baseText)
      const textNode = node.children[0] as InstanceType<typeof Text>
      const styleBefore = textNode.style
      vi.clearAllMocks()

      textRenderer.applyPatch!(node, { opacity: 0.5 })

      expect(node.alpha).toBe(0.5)
      expect(textNode.style).toBe(styleBefore)
    })
  })

  describe('text content — NErebuildí TextStyle', () => {
    it('patch { text } mění textNode.text, NEmění style', () => {
      const node = textRenderer.mount(baseText)
      const textNode = node.children[0] as InstanceType<typeof Text>
      const styleBefore = textNode.style
      vi.clearAllMocks()

      textRenderer.applyPatch!(node, { text: 'New content' })

      expect(textNode.text).toBe('New content')
      expect(textNode.style).toBe(styleBefore)
    })
  })

  describe('style properties — mění TextStyle', () => {
    it('patch { fontSize } mění style.fontSize', () => {
      const node = textRenderer.mount(baseText)
      const textNode = node.children[0] as InstanceType<typeof Text>
      vi.clearAllMocks()

      textRenderer.applyPatch!(node, { fontSize: 32 })

      expect((textNode.style as unknown as Record<string, unknown>).fontSize).toBe(32)
    })

    it('patch { fontWeight } mění style.fontWeight', () => {
      const node = textRenderer.mount(baseText)
      const textNode = node.children[0] as InstanceType<typeof Text>
      vi.clearAllMocks()

      textRenderer.applyPatch!(node, { fontWeight: 'bold' })

      expect((textNode.style as unknown as Record<string, unknown>).fontWeight).toBe('bold')
    })

    it('patch { color } mění style.fill', () => {
      const node = textRenderer.mount(baseText)
      const textNode = node.children[0] as InstanceType<typeof Text>
      vi.clearAllMocks()

      textRenderer.applyPatch!(node, { color: 0xff0000 })

      expect((textNode.style as unknown as Record<string, unknown>).fill).toBe('#ff0000')
    })

    it('patch { align } mění style.align', () => {
      const node = textRenderer.mount(baseText)
      const textNode = node.children[0] as InstanceType<typeof Text>
      vi.clearAllMocks()

      textRenderer.applyPatch!(node, { align: 'center' })

      expect((textNode.style as unknown as Record<string, unknown>).align).toBe('center')
    })

    it('patch { width } mění style.wordWrapWidth a přepočítá pivot.x a node.x', () => {
      const node = textRenderer.mount(baseText)
      const textNode = node.children[0] as InstanceType<typeof Text>
      vi.clearAllMocks()

      // Původní: data.x=10, width=300, pivot.x=150, node.x=160
      // Po patch { width: 400 }: pivot.x=200, node.x = data.x + 200 = 210
      textRenderer.applyPatch!(node, { width: 400 })

      expect((textNode.style as unknown as Record<string, unknown>).wordWrapWidth).toBe(400)
      expect(node.pivot.x).toBe(200)
      expect(node.x).toBe(10 + 200)
    })
  })

  describe('kombinované patche', () => {
    it('patch { x, text } — repozice + text update, bez style rebuild', () => {
      const node = textRenderer.mount(baseText)
      const textNode = node.children[0] as InstanceType<typeof Text>
      const styleBefore = textNode.style
      vi.clearAllMocks()

      textRenderer.applyPatch!(node, { x: 300, text: 'Updated' })

      expect(node.x).toBe(300 + 150)
      expect(textNode.text).toBe('Updated')
      expect(textNode.style).toBe(styleBefore)
    })
  })
})
