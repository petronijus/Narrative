/**
 * Round-trip tests for the pure DOM ↔ editable-string helpers used by the
 * text-edit overlay. These walk a real (jsdom) DOM built from the SAME
 * `buildListedHtml` the renderer and overlay use, so they verify the
 * paragraph/marker/empty-break structure stays consistent — independent of
 * the (approximate-in-jsdom) selection model.
 */
import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import {
  PARAGRAPH_SEP,
  applyParagraphPatch,
  buildListedHtml,
  getParagraphDeltas,
  getParagraphs,
  createTextValue,
} from '@narrative/slide-model'
import {
  getElementInnerText,
  domShowsHtml,
  domPositionToCharIndex,
  charIndexToDomPosition,
} from './textEditDom.js'

function makeYText(initial: string): Y.Text {
  const doc = new Y.Doc()
  const yt = createTextValue(initial)
  doc.getMap('m').set('text', yt)
  return yt
}

function renderToDom(yt: Y.Text): HTMLElement {
  const el = document.createElement('div')
  el.innerHTML = buildListedHtml(getParagraphDeltas(yt), {})
  return el
}

/** The editable-string projection (paragraphs joined by U+2029, no trailing). */
function editable(yt: Y.Text): string {
  return getParagraphs(yt)
    .map((p) => p.text)
    .join(PARAGRAPH_SEP)
}

describe('getElementInnerText round-trips the editable string', () => {
  const cases: Array<[string, string]> = [
    ['single paragraph', 'hello world'],
    ['empty body', ''],
    ['two plain paragraphs', `a${PARAGRAPH_SEP}b`],
    ['soft break inside a paragraph', `line1\nline2${PARAGRAPH_SEP}next`],
    ['empty middle paragraph', `a${PARAGRAPH_SEP}${PARAGRAPH_SEP}c`],
    // The state produced by pressing Enter at the end of a paragraph (Bug 1
    // fix): a trailing empty paragraph must survive the projection.
    ['trailing empty paragraph', `Alpha${PARAGRAPH_SEP}${PARAGRAPH_SEP}`],
  ]
  it.each(cases)('%s', (_label, body) => {
    const yt = makeYText(body)
    const el = renderToDom(yt)
    expect(getElementInnerText(el)).toBe(editable(yt))
  })

  it('skips list-marker glyphs and indent', () => {
    const yt = makeYText(`one${PARAGRAPH_SEP}two`)
    yt.doc!.transact(() => applyParagraphPatch(yt, 0, yt.length, { list: 'bullet' }))
    const el = renderToDom(yt)
    // Markers are present in the DOM but excluded from the text projection.
    expect(el.querySelector('[data-marker]')).not.toBeNull()
    expect(getElementInnerText(el)).toBe(`one${PARAGRAPH_SEP}two`)
  })

  it('skips numbered-list markers too', () => {
    const yt = makeYText(`a${PARAGRAPH_SEP}b${PARAGRAPH_SEP}c`)
    yt.doc!.transact(() => applyParagraphPatch(yt, 0, yt.length, { list: 'number' }))
    const el = renderToDom(yt)
    expect(getElementInnerText(el)).toBe(`a${PARAGRAPH_SEP}b${PARAGRAPH_SEP}c`)
  })
})

describe('char-index ↔ DOM-position round-trip', () => {
  const bodies = [
    'hello world',
    `a${PARAGRAPH_SEP}b${PARAGRAPH_SEP}c`,
    `line1\nline2${PARAGRAPH_SEP}next`,
  ]
  it.each(bodies)('every index maps back to itself for %j', (body) => {
    const yt = makeYText(body)
    const el = renderToDom(yt)
    const len = editable(yt).length
    for (let i = 0; i <= len; i++) {
      const dom = charIndexToDomPosition(el, i)
      const back = domPositionToCharIndex(el, dom.node, dom.offset)
      expect(back).toBe(i)
    }
  })

  it('normalizes a caret parked inside a leading marker span to the paragraph start', () => {
    // Chrome parks the caret on the marker glyph after a bare Home press.
    const yt = makeYText(`first${PARAGRAPH_SEP}second`)
    yt.doc!.transact(() => applyParagraphPatch(yt, 0, yt.length, { list: 'bullet' }))
    const el = renderToDom(yt)
    const secondMarker = el.querySelectorAll('[data-marker]')[1]!
    const glyphNode = secondMarker.firstChild! // the "•" text node
    // Caret inside the marker resolves to the start of "second" (index 6).
    expect(domPositionToCharIndex(el, glyphNode, 0)).toBe(`first${PARAGRAPH_SEP}`.length)
    // Same for a caret anchored on the marker element itself.
    expect(domPositionToCharIndex(el, secondMarker, 0)).toBe(`first${PARAGRAPH_SEP}`.length)
  })

  it('round-trips through a bulleted, nested list', () => {
    const yt = makeYText(`first${PARAGRAPH_SEP}second${PARAGRAPH_SEP}third`)
    yt.doc!.transact(() => {
      applyParagraphPatch(yt, 0, yt.length, { list: 'bullet' })
      applyParagraphPatch(yt, 6, 12, { list: 'bullet', level: 1 })
    })
    const el = renderToDom(yt)
    const len = editable(yt).length
    for (let i = 0; i <= len; i++) {
      const dom = charIndexToDomPosition(el, i)
      expect(domPositionToCharIndex(el, dom.node, dom.offset)).toBe(i)
    }
  })
})

describe('domShowsHtml', () => {
  const underlined = (yt: Y.Text): string =>
    buildListedHtml(getParagraphDeltas(yt), { underline: true })

  it('holds for the markup as built, and for text the browser typed into its run', () => {
    const yt = makeYText('Hello')
    const el = document.createElement('div')
    el.innerHTML = underlined(yt)
    expect(domShowsHtml(el, underlined(yt))).toBe(true)
    // Typing at the end of the run: the browser grows (or splits) its text node.
    el.querySelector('u')!.append(document.createTextNode(' world'))
    yt.insert(5, ' world')
    expect(domShowsHtml(el, underlined(yt))).toBe(true)
  })

  it('fails for typed text left outside the run the document gives it', () => {
    const yt = makeYText(`Hello${PARAGRAPH_SEP}${PARAGRAPH_SEP}`)
    const el = document.createElement('div')
    el.innerHTML = underlined(yt)
    // The browser types into the empty paragraph's block, not into a <u>.
    const empty = el.querySelectorAll('div')[1]!
    empty.replaceChildren(document.createTextNode('x'))
    yt.insert(6, 'x')
    expect(getElementInnerText(el)).toBe(editable(yt))
    expect(domShowsHtml(el, underlined(yt))).toBe(false)
  })

  it('fails when the box-wide formatting changed under unchanged text', () => {
    const yt = makeYText('Hello')
    const el = renderToDom(yt)
    expect(domShowsHtml(el, underlined(yt))).toBe(false)
  })
})

describe('placeholder line breaks', () => {
  const textOf = (html: string): string => {
    const el = document.createElement('div')
    el.innerHTML = html
    return getElementInnerText(el)
  }

  it('counts the breaks the browser leaves holding a line open as no character', () => {
    // Shift+Enter at the end of "a": the browser's `<br><br>`.
    expect(textOf('<div data-pb="1">a<br><br></div>')).toBe('a\n')
    expect(textOf('<div data-pb="1"><u>a<br></u><br></div>')).toBe('a\n')
    expect(textOf('<div data-pb="1">a<br><br><br></div>')).toBe('a\n\n')
    // Every character deleted: the block holds a lone `<br>`.
    expect(textOf('<div data-pb="1"><br></div>')).toBe('')
    expect(textOf('<div data-pb="1"><u><br></u></div>')).toBe('')
    expect(textOf(`<div data-pb="1">a</div><div data-pb="1"><br></div>`)).toBe(`a${PARAGRAPH_SEP}`)
    // Bare content (before a rebuild).
    expect(textOf('a<br><br>')).toBe('a\n')
  })

  it('counts every other break', () => {
    expect(textOf('<div data-pb="1">a<br>b</div>')).toBe('a\nb')
    expect(textOf('<div data-pb="1">a<br><br>b</div>')).toBe('a\n\nb')
    expect(textOf('<div data-pb="1"><br>b</div>')).toBe('\nb')
    // A lone `<br>` that ends a line of text is a break (nothing holds a line after it).
    expect(textOf('<div data-pb="1">a<br></div>')).toBe('a\n')
  })

  it('round-trips a closing soft break and its caret positions', () => {
    for (const body of ['a\n', 'a\n\n', `a\n${PARAGRAPH_SEP}b`, 'a\nb\n', '\n']) {
      const yt = makeYText(body)
      const el = renderToDom(yt)
      expect(getElementInnerText(el)).toBe(editable(yt))
      for (let i = 0; i <= editable(yt).length; i++) {
        const dom = charIndexToDomPosition(el, i)
        expect(domPositionToCharIndex(el, dom.node, dom.offset)).toBe(i)
      }
    }
  })

  it("puts the caret on the closing break's line before its placeholder", () => {
    const yt = makeYText('a\n')
    const el = renderToDom(yt)
    const placeholder = el.querySelector('br[data-empty]')!
    const dom = charIndexToDomPosition(el, 2)
    expect(dom.node.childNodes[dom.offset]).toBe(placeholder)
  })
})

describe('line breaks the browser types into pre-wrap text', () => {
  const textOf = (html: string): string => {
    const el = document.createElement('div')
    el.innerHTML = html
    return getElementInnerText(el)
  }

  it('counts a newline that holds the last line open as no character', () => {
    expect(textOf('<div data-pb="1">One\n\n</div>')).toBe('One\n')
    expect(textOf('<div data-pb="1"><u>One</u>\n\n</div>')).toBe('One\n')
    expect(textOf('<div data-pb="1">One\n\n\n</div>')).toBe('One\n\n')
    expect(textOf('<div data-pb="1">One<br>\n</div>')).toBe('One\n')
    expect(textOf('<div data-pb="1">\n</div>')).toBe('')
  })

  it('counts every other newline', () => {
    expect(textOf('<div data-pb="1">One\nTwo</div>')).toBe('One\nTwo')
    expect(textOf('<div data-pb="1">One\n</div>')).toBe('One\n')
    expect(textOf('<div data-pb="1">One\n\nTwo</div>')).toBe('One\n\nTwo')
  })

  it('maps the caret around a held line', () => {
    const el = document.createElement('div')
    el.innerHTML = '<div data-pb="1">One\n\n</div>'
    const text = el.firstChild!.firstChild!
    // The caret on the held line (after the break) is character 4, the end.
    expect(domPositionToCharIndex(el, text, 4)).toBe(4)
    expect(domPositionToCharIndex(el, text, 5)).toBe(4)
    expect(charIndexToDomPosition(el, 4)).toEqual({ node: text, offset: 4 })
  })
})
