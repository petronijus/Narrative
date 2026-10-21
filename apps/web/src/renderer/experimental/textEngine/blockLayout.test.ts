import { describe, expect, it } from 'vitest'
import {
  breakUnits,
  CHROMIUM_LAYOUT,
  layoutBlock,
  WEBKIT_LAYOUT,
  type Measurer,
} from './blockLayout.js'
import type { BlockParagraph, BlockStyle, TextBlock } from './textBlock.js'

/** Every character is `size / 2` wide; letter spacing adds per character. */
const mono: Measurer = {
  width: (text, style) => [...text].length * (style.size / 2 + style.letterSpacing),
}

function style(over: Partial<BlockStyle> = {}): BlockStyle {
  return {
    font: 'normal 400 20px Mono',
    size: 20,
    stretch: 100,
    color: 'rgb(0, 0, 0)',
    letterSpacing: 0,
    transform: 'none',
    ascent: 16,
    descent: 4,
    ...over,
  }
}

function para(text: string, over: Partial<BlockParagraph> = {}): BlockParagraph {
  return {
    marginTop: 0,
    marginBottom: 0,
    paddingLeft: 0,
    textIndent: 0,
    lineHeight: 30,
    strut: 0,
    align: 'left',
    inlines: [{ kind: 'text', text, style: 0 }],
    ...over,
  }
}

function block(paragraphs: BlockParagraph[], over: Partial<TextBlock> = {}): TextBlock {
  return { width: 100, padding: 0, breakWord: true, styles: [style()], paragraphs, ...over }
}

const lineTexts = (b: TextBlock, opts = CHROMIUM_LAYOUT): string[] =>
  layoutBlock(b, mono, opts).runs.map((r) => r.text)

describe('breakUnits', () => {
  it('breaks after spaces, keeping the spaces with the word before', () => {
    expect(breakUnits('one two  three')).toEqual(['one ', 'two  ', 'three'])
  })

  it('breaks after a hyphen between letters, not before a digit', () => {
    expect(breakUnits('well-known -5 x-1')).toEqual(['well-', 'known ', '-5 ', 'x-1'])
  })

  it('breaks around em dashes and between ideographs', () => {
    expect(breakUnits('a—b')).toEqual(['a', '—', 'b'])
    expect(breakUnits('日本語')).toEqual(['日', '本', '語'])
  })
})

describe('layoutBlock', () => {
  it('wraps at the box width, hanging the trailing space', () => {
    // 10 px per character, 100 px wide: "aaaa bbbb " fits (the space hangs).
    expect(lineTexts(block([para('aaaa bbbb cccc')]))).toEqual(['aaaa bbbb ', 'cccc'])
  })

  it('breaks a word longer than the line between graphemes (break-word)', () => {
    expect(lineTexts(block([para('abcdefghijklmn')]))).toEqual(['abcdefghij', 'klmn'])
  })

  it('lets a long word overflow without break-word', () => {
    expect(lineTexts(block([para('abcdefghijklmn')], { breakWord: false }))).toEqual([
      'abcdefghijklmn',
    ])
  })

  it('places baselines with the half-leading above the glyphs floored (Chromium)', () => {
    // 31 px line, 20 px of font: 11 px of leading, 5 above (floored) and 6 below.
    const out = layoutBlock(block([para('a', { lineHeight: 31 })]), mono, CHROMIUM_LAYOUT)
    expect(out.runs[0]!.y).toBe(5 + 16)
    expect(out.height).toBe(31)
  })

  it('keeps the exact half-leading in WebKit', () => {
    const out = layoutBlock(block([para('a', { lineHeight: 31 })]), mono, WEBKIT_LAYOUT)
    expect(out.runs[0]!.y).toBe(5.5 + 16)
  })

  it('collapses the margins between paragraphs and keeps the outer ones', () => {
    const out = layoutBlock(
      block([
        para('a', { marginTop: 4, marginBottom: 10 }),
        para('b', { marginTop: 6, marginBottom: 3 }),
      ]),
      mono,
    )
    const [a, b] = out.runs
    expect(a!.y).toBe(4 + 5 + 16)
    expect(b!.y - a!.y).toBe(30 + 10)
    expect(out.height).toBe(4 + 30 + 10 + 30 + 3)
  })

  it('aligns each line on its own width without its hanging spaces', () => {
    const out = layoutBlock(block([para('aaaa bbbb cccc', { align: 'right' })]), mono)
    expect(out.runs.map((r) => r.x)).toEqual([100 - 90, 100 - 40])
    const centred = layoutBlock(block([para('aa', { align: 'center' })]), mono)
    expect(centred.runs[0]!.x).toBe(40)
  })

  it('draws a marker box in the hanging indent and the text after it', () => {
    const p: BlockParagraph = {
      ...para(''),
      paddingLeft: 30,
      textIndent: -30,
      inlines: [
        { kind: 'box', width: 30, text: '•', style: 0 },
        { kind: 'text', text: 'item that wraps', style: 0 },
      ],
    }
    // 130 px: the first line has the marker's 30 and "item that " (the space hangs).
    const out = layoutBlock(block([p], { width: 130 }), mono)
    expect(out.runs.map((r) => [r.text, r.x])).toEqual([
      ['•', 0],
      ['item that ', 30],
      ['wraps', 30],
    ])
  })

  it('starts a line at a <br> and draws no run for it', () => {
    const p: BlockParagraph = {
      ...para(''),
      inlines: [
        { kind: 'text', text: 'one', style: 0 },
        { kind: 'br' },
        { kind: 'text', text: 'two', style: 0 },
      ],
    }
    expect(lineTexts(block([p]))).toEqual(['one', 'two'])
  })

  it('makes a line as tall as its tallest inline box', () => {
    const big = style({ font: 'normal 400 40px Mono', size: 40, ascent: 32, descent: 8 })
    const p: BlockParagraph = {
      ...para(''),
      inlines: [
        { kind: 'text', text: 'a', style: 0 },
        { kind: 'text', text: 'B', style: 1 },
      ],
    }
    const out = layoutBlock(block([p], { styles: [style(), big], width: 500 }), mono)
    // The big box: 30 − 40 = −10 of leading, −5 above: its ascent reaches 27
    // above the baseline. The small one's descent + 6 of leading reach 9 below.
    expect(out.runs.map((r) => r.y)).toEqual([27, 27])
    expect(out.height).toBe(27 + 9)
  })

  it('lays out unwrapped text at its own width and aligns within it', () => {
    const out = layoutBlock(
      block([para('long line'), para('ab', { align: 'right' })], { width: null }),
      mono,
    )
    expect(out.width).toBe(90)
    expect(out.runs[1]!.x).toBe(70)
  })

  it('applies text-transform before measuring', () => {
    const out = layoutBlock(
      block([para('ß x')], { styles: [style({ transform: 'uppercase' })] }),
      mono,
    )
    expect(out.runs[0]!.text).toBe('SS X')
    expect(out.runs[0]!.width).toBe(40)
  })

  it('offsets everything by the padding', () => {
    const out = layoutBlock(block([para('a')], { padding: 7 }), mono)
    expect(out.runs[0]!.x).toBe(7)
    expect(out.runs[0]!.y).toBe(7 + 5 + 16)
    expect(out.lines[0]!.top).toBe(7)
  })
})
