/**
 * objectRenderers/textRenderer.autofit.test.ts — autofit (agentic A4.2):
 * a `grow-down` box is drawn as tall as its laid-out text, a `shrink` box
 * draws its type at the largest scale (down to its floor) at which the text
 * fits, and both report what they are drawn as.
 *
 * The browser's layout is the e2e's (text-autofit.spec.ts). Here HTMLText
 * "measures" a text whose height is inversely proportional to the width it
 * is laid out in — `TEXT_AREA / wordWrapWidth` — so the scale search has a
 * real curve to search, and `height` is scaled by the node's scale as
 * Pixi's is.
 */

import { describe, it, expect, vi } from 'vitest'
import { pixiMock } from '../../test/pixiMock'

/** Laid out at width w, the test text is TEXT_AREA / w px tall (unscaled). */
const TEXT_AREA = 60_000

vi.mock('pixi.js', () => {
  const mock = pixiMock()
  const Base = mock.HTMLText as unknown as new (opts?: Record<string, unknown>) => {
    style: { wordWrapWidth?: number }
    scale: { y: number }
  }
  class MeasuredHTMLText extends Base {
    constructor(opts: Record<string, unknown> = {}) {
      super(opts)
      Object.defineProperty(this, 'height', {
        configurable: true,
        get: () => {
          const w = this.style.wordWrapWidth
          return w === undefined || w <= 0 ? 0 : (TEXT_AREA / w) * this.scale.y
        },
        set: () => {},
      })
    }
  }
  return { ...mock, HTMLText: MeasuredHTMLText }
})

import type { Container, HTMLText } from 'pixi.js'
import {
  measureTextBoxLayout,
  subscribeTextLayout,
  textBoxLayout,
  textRenderer,
} from './textRenderer.js'
import type { TextObject } from '@narrative/shared'

function makeText(overrides: Partial<TextObject> = {}): TextObject {
  return {
    id: 't1',
    type: 'text',
    x: 100,
    y: 50,
    width: 200,
    height: 100,
    rotation: 0,
    opacity: 1,
    text: 'a text that needs room',
    fontSize: 40,
    fontWeight: 'normal',
    color: 0x111111,
    align: 'left',
    ...overrides,
  } as TextObject
}

function textNodeOf(node: Container): HTMLText {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return node.children.find((c) => (c as any).anchor !== undefined) as unknown as HTMLText
}

describe('autofit: shrink', () => {
  it('draws the type at the largest scale at which the text fits', () => {
    // Unscaled at 200 px the text is 300 px tall; laid out at 200/s and
    // drawn at s it is 300·s² — it fits a 100 px box from s ≈ 0.577.
    const node = textRenderer.mount(makeText({ autofit: 'shrink' }))
    const { scale, height } = textBoxLayout(node)!
    expect(scale).toBeGreaterThan(0.57)
    expect(scale).toBeLessThanOrEqual(Math.sqrt(101 / 300))
    expect(height).toBe(100)
    const textNode = textNodeOf(node)
    expect(textNode.scale.y).toBe(scale)
    // Laid out wider by the inverse, so lines break as at the smaller size.
    expect(textNode.style.wordWrapWidth).toBeCloseTo(200 / scale)
  })

  it('stops at half the size, or at minFontSize', () => {
    const tiny = textRenderer.mount(makeText({ autofit: 'shrink', height: 10 }))
    expect(textBoxLayout(tiny)!.scale).toBe(0.5)
    const floored = textRenderer.mount(makeText({ autofit: 'shrink', height: 10, minFontSize: 30 }))
    expect(textBoxLayout(floored)!.scale).toBe(0.75)
  })

  it('leaves text that fits at its size', () => {
    const node = textRenderer.mount(makeText({ autofit: 'shrink', height: 400 }))
    expect(textBoxLayout(node)!.scale).toBe(1)
  })

  it('searches again when the box changes, and goes back to scale 1 when switched off', () => {
    const node = textRenderer.mount(makeText({ autofit: 'shrink' }))
    const first = textBoxLayout(node)!.scale
    textRenderer.applyPatch(node, { height: 200 })
    expect(textBoxLayout(node)!.scale).toBeGreaterThan(first)
    textRenderer.applyPatch(node, { autofit: undefined } as unknown as Partial<TextObject>)
    expect(textBoxLayout(node)!.scale).toBe(1)
    expect(textNodeOf(node).style.wordWrapWidth).toBe(200)
  })
})

describe('autofit: grow-down', () => {
  it('is drawn as tall as its text, turning about the centre of that', () => {
    const node = textRenderer.mount(makeText({ autofit: 'grow-down', vAlign: 'bottom' }))
    // 300 px of text in a box whose stored height is 100.
    expect(textBoxLayout(node)).toEqual({ height: 300, scale: 1 })
    expect(node.pivot.y).toBe(150)
    expect(node.y).toBe(50 + 150)
    // No room to align in: the text starts at the top.
    expect(textNodeOf(node).y).toBeLessThan(1)
  })

  it('follows the text as it reflows, and reports each change once', () => {
    const node = textRenderer.mount(makeText({ autofit: 'grow-down' }))
    const heard: number[] = []
    const off = subscribeTextLayout((container, layout) => {
      if (container === node) heard.push(layout.height)
    })
    textRenderer.applyPatch(node, { width: 300 })
    textRenderer.applyPatch(node, { width: 300 })
    off()
    expect(heard).toEqual([200])
    expect(node.pivot.y).toBe(100)
  })

  it('a fixed box is drawn at its own height', () => {
    const node = textRenderer.mount(makeText())
    expect(textBoxLayout(node)).toEqual({ height: 100, scale: 1 })
  })
})

describe('measureTextBoxLayout', () => {
  it("gives what a fresh mount of each box is drawn as, one box after another on the page's node", () => {
    const boxes: TextObject[] = [
      makeText({ autofit: 'shrink' }),
      makeText({ autofit: 'grow-down', align: 'right' }),
      // The same text and box as the first: its search must not be skipped
      // because the node still holds the first's style and scale.
      makeText({ autofit: 'shrink' }),
      makeText({ autofit: 'shrink', height: 10, minFontSize: 30, align: 'center' }),
      makeText({ autofit: 'grow-down', width: 400 }),
      makeText(),
      makeText({ autofit: 'shrink', width: 120 }),
    ]
    for (const data of boxes) {
      const mounted = textBoxLayout(textRenderer.mount(data))
      expect(measureTextBoxLayout(data)).toEqual(mounted)
    }
  })

  it('reports no layout to the listeners (the node is not on any canvas)', () => {
    const heard = vi.fn()
    const off = subscribeTextLayout(heard)
    measureTextBoxLayout(makeText({ autofit: 'grow-down' }))
    measureTextBoxLayout(makeText({ autofit: 'shrink', width: 150 }))
    off()
    expect(heard).not.toHaveBeenCalled()
  })
})
