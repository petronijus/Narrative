/**
 * Unit tests for richText helpers — Y.Text ↔ delta ↔ HTML.
 */
import * as Y from 'yjs'
import { describe, it, expect } from 'vitest'
import { applyFormat, createTextValue, getPlainString, toDelta, toHtml } from './richText.js'

function attach(): Y.Text {
  const doc = new Y.Doc()
  const map = doc.getMap('m')
  const yt = createTextValue('')
  map.set('text', yt)
  return yt
}

describe('richText helpers', () => {
  it('createTextValue seeds a Y.Text with the initial string', () => {
    const doc = new Y.Doc()
    const map = doc.getMap('m')
    const yt = createTextValue('hello')
    map.set('text', yt)
    expect(getPlainString(yt)).toBe('hello')
  })

  it('applyFormat marks a substring with attributes', () => {
    const yt = attach()
    yt.insert(0, 'hello world')
    applyFormat(yt, 6, 5, { italic: true })
    const delta = toDelta(yt)
    expect(delta).toEqual([{ insert: 'hello ' }, { insert: 'world', attributes: { italic: true } }])
  })

  it('toHtml emits <i>, <u>, <span style="font-weight">, <span style="color"> wrappers', () => {
    const yt = attach()
    yt.insert(0, 'hi there')
    applyFormat(yt, 0, 2, { italic: true, underline: true })
    applyFormat(yt, 3, 5, { fontWeight: 700, color: 0xff0000 })
    const html = toHtml(toDelta(yt), {})
    expect(html).toBe('<u><i>hi</i></u> <span style="font-weight:700;color:#ff0000">there</span>')
  })

  it('toHtml escapes HTML special characters in the body', () => {
    const yt = attach()
    yt.insert(0, 'a < b & c > d')
    const html = toHtml(toDelta(yt), {})
    expect(html).toBe('a &lt; b &amp; c &gt; d')
  })

  it('toHtml turns \\n into <br>', () => {
    const yt = attach()
    yt.insert(0, 'line one\nline two')
    const html = toHtml(toDelta(yt), {})
    expect(html).toBe('line one<br>line two')
  })

  it('toHtml respects defaults when a run has no attribute', () => {
    const yt = attach()
    yt.insert(0, 'abc')
    const html = toHtml(toDelta(yt), { italic: true })
    expect(html).toBe('<i>abc</i>')
  })

  it('toHtml lets a run override a box-wide default with attribute=false', () => {
    const yt = attach()
    yt.insert(0, 'one two')
    applyFormat(yt, 4, 3, { italic: false })
    const html = toHtml(toDelta(yt), { italic: true })
    expect(html).toBe('<i>one </i>two')
  })

  it('toHtml emits a plain single-word fontFamily unquoted', () => {
    const yt = attach()
    yt.insert(0, 'hi')
    applyFormat(yt, 0, 2, { fontFamily: 'Arial' })
    expect(toHtml(toDelta(yt), {})).toBe('<span style="font-family:Arial">hi</span>')
  })

  it('toHtml quotes a multi-word fontFamily in single quotes (safe inside a double-quoted attr)', () => {
    const yt = attach()
    yt.insert(0, 'hi')
    applyFormat(yt, 0, 2, { fontFamily: 'Druk Wide' })
    // Single quotes: a `"` here would break the surrounding style="" attribute.
    expect(toHtml(toDelta(yt), {})).toBe('<span style="font-family:\'Druk Wide\'">hi</span>')
  })

  it('toHtml quotes a family with digits, which unquoted would drop the declaration', () => {
    const yt = attach()
    yt.insert(0, 'hi')
    applyFormat(yt, 0, 2, { fontFamily: 'Northwind Sans ST Pro 36 Regular, sans-serif' })
    // Each name of a stack on its own; the generic family stays bare.
    expect(toHtml(toDelta(yt), {})).toBe(
      '<span style="font-family:\'Northwind Sans ST Pro 36 Regular\', sans-serif">hi</span>',
    )
  })

  it("toHtml escapes an apostrophe in a family name (O'Hare Sans)", () => {
    const yt = attach()
    yt.insert(0, 'hi')
    applyFormat(yt, 0, 2, { fontFamily: "O'Hare Sans" })
    expect(toHtml(toDelta(yt), {})).toBe("<span style=\"font-family:'O\\'Hare Sans'\">hi</span>")
  })

  it('toHtml strips a hostile fontFamily so it cannot break out of the style attribute', () => {
    const yt = attach()
    yt.insert(0, 'pwn')
    // Classic attribute-breakout payload set via a malicious collaborator
    // or crafted .pptx: must not yield a `"` or `<` in the output.
    applyFormat(yt, 0, 3, { fontFamily: 'x"><img src=q onerror=alert(1)>' })
    const html = toHtml(toDelta(yt), {})
    expect(html).not.toContain('<img')
    expect(html).not.toContain('onerror=')
    // No quote/angle-bracket survives the allowlist; chars left are inert.
    expect(html).toBe('<span style="font-family:\'ximg srcq onerroralert1\'">pwn</span>')
  })

  it('toHtml drops a fontFamily that sanitises to nothing', () => {
    const yt = attach()
    yt.insert(0, 'hi')
    applyFormat(yt, 0, 2, { fontFamily: '";:{}<>' })
    // No font-family bit at all — nothing survived the allowlist.
    expect(toHtml(toDelta(yt), {})).toBe('hi')
  })
})
