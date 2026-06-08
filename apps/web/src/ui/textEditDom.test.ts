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
