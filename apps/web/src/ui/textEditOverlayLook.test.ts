import { afterEach, describe, expect, it } from 'vitest'
import type { TextObject } from '@narrative/shared'
import { setColourResolver } from '../renderer/colourResolver.js'
import {
  boxFilterCss,
  boxTransformCss,
  cssHexa,
  textClipPath,
  textPaintCss,
} from './textEditOverlayLook.js'

function box(extra: Partial<TextObject> = {}): TextObject {
  return {
    id: 't',
    type: 'text',
    x: 0,
    y: 0,
    width: 300,
    height: 100,
    rotation: 0,
    opacity: 1,
    text: 'x',
    fontSize: 24,
    fontWeight: 400,
    color: 0x112233,
    align: 'left',
    ...extra,
  } as TextObject
}

afterEach(() => setColourResolver(null))

describe('textEditOverlayLook', () => {
  it('writes colours as Pixi writes them into the HTMLText CSS', () => {
    // Color.toHexa: alpha rounded to /255.
    expect(cssHexa(0x112233, 1)).toBe('#112233ff')
    expect(cssHexa(0x112233, 0.45)).toBe('#11223373')
    expect(cssHexa(0, 0)).toBe('#00000000')
  })

  it('paints the fill with its alpha, the caret without', () => {
    const paint = textPaintCss(box({ colorAlpha: 0.45 }))
    expect(paint.color).toBe('#11223373')
    expect(paint.caretColor).toBe('#112233')
    expect(paint.WebkitTextStrokeWidth).toBeUndefined()
  })

  it("multiplies a token's own alpha in, through the canvas's resolver", () => {
    setColourResolver(() => '#ff000080')
    const paint = textPaintCss(box({ color: { $token: 'brand' } }))
    expect(paint.color).toBe(cssHexa(0xff0000, Math.round((0x80 / 255) * 1000) / 1000))
  })

  it("draws the stroke under the fill, as Pixi's strokeToCSS does", () => {
    const paint = textPaintCss(box({ stroke: 0x2563eb, strokeWidth: 3, strokeAlpha: 0.5 }))
    expect(paint.WebkitTextStrokeWidth).toBe('3px')
    expect(paint.WebkitTextStrokeColor).toBe('#2563eb80')
    expect(paint.paintOrder).toBe('stroke')
    expect(textPaintCss(box({ stroke: 0x2563eb, strokeWidth: 0 })).paintOrder).toBeUndefined()
  })

  it('flips before it turns, about the centre', () => {
    expect(boxTransformCss(box())).toBeUndefined()
    expect(boxTransformCss(box({ rotation: 0.5, flipH: true }))).toBe('rotate(0.5rad) scale(-1, 1)')
  })

  it('clips a wrapping box at its sides only, an unwrapped or growing one not at all', () => {
    expect(textClipPath(box(), undefined, 1)).toBe('inset(-100000px 0px -100000px 0px)')
    expect(textClipPath(box({ wrap: 'none' }), undefined, 1)).toBeUndefined()
    expect(textClipPath(box({ autofit: 'grow-down' }), undefined, 1)).toBeUndefined()
  })

  it("clips a cell at the cell's edge, in the frame's own units", () => {
    const margin = { top: 8, right: 12, bottom: 8, left: 12 }
    expect(textClipPath(box(), margin, 1)).toBe('inset(-8px -12px -8px -12px)')
    expect(textClipPath(box(), margin, 0.5)).toBe('inset(-16px -24px -16px -24px)')
  })

  it('shadows, then blurs', () => {
    expect(boxFilterCss(box())).toBeUndefined()
    expect(
      boxFilterCss(
        box({ shadow: { color: 0, blur: 6, offsetX: 4, offsetY: 5, opacity: 0.5 }, blur: 2 }),
      ),
    ).toBe('drop-shadow(4px 5px 6px #00000080) blur(2px)')
  })
})
