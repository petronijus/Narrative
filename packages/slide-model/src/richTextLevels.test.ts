/**
 * richTextLevels.test.ts — list level defaults (agentic A4.2b): a paragraph
 * that sets nothing takes its level's list kind, glyph and look; `'none'`
 * keeps it plain against them; a box without levels is unchanged.
 */

import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'
import {
  buildListedHtml,
  effectiveParagraphAttrs,
  getParagraphDeltas,
  getParagraphs,
  plainListValue,
  readParagraphAttrsForRange,
  toggleListKind,
  type ListLevelLook,
} from './richText.js'
import { PARAGRAPH_SEP } from './richText.js'

const LEVELS: ListLevelLook[] = [
  {
    list: 'bullet',
    bulletChar: '–',
    bulletColor: 0xf50537,
    bulletScale: 1.5,
    indent: 40,
    hanging: 24,
  },
  { list: 'number', numberFormat: 'lowerAlpha', fontSize: 20, fontWeight: 700, color: 0x123456 },
]

function body(): Y.Text {
  const doc = new Y.Doc()
  const t = doc.getText('t')
  doc.transact(() => {
    t.insert(0, 'One')
    t.insert(3, PARAGRAPH_SEP)
    t.insert(4, 'Two')
    t.insert(7, PARAGRAPH_SEP, { level: 1 })
    t.insert(8, 'Plain')
    t.insert(13, PARAGRAPH_SEP, { list: 'none' })
  })
  return t
}

describe('effectiveParagraphAttrs', () => {
  it("takes the level's kind and glyph, keeps own attributes, and 'none' plain", () => {
    expect(effectiveParagraphAttrs({}, LEVELS)).toEqual({ list: 'bullet', bulletChar: '–' })
    expect(effectiveParagraphAttrs({ level: 1 }, LEVELS)).toEqual({
      level: 1,
      list: 'number',
      numberFormat: 'lowerAlpha',
    })
    expect(effectiveParagraphAttrs({ list: 'none' }, LEVELS)).toEqual({})
    expect(effectiveParagraphAttrs({ list: 'bullet', bulletChar: '•' }, LEVELS)).toEqual({
      list: 'bullet',
      bulletChar: '•',
    })
    // No levels: exactly as stored.
    expect(effectiveParagraphAttrs({}, undefined)).toEqual({})
  })

  it("says 'none' only where the level would make a list", () => {
    expect(plainListValue(0, LEVELS)).toBe('none')
    expect(plainListValue(4, LEVELS)).toBeNull()
    expect(plainListValue(0, undefined)).toBeNull()
  })
})

describe('buildListedHtml with level defaults', () => {
  it('draws the level marker, its colour and size, px indents and the level type', () => {
    const html = buildListedHtml(getParagraphDeltas(body()), { fontSize: 32, listLevels: LEVELS })
    const [first, second, third] = html.split('</div>')
    expect(first).toContain('padding-left:40px')
    expect(first).toContain('text-indent:-24px')
    expect(first).toContain('color:#f50537')
    expect(first).toContain('font-size:150%')
    expect(first).toContain('>–</span>')
    // Level 1: numbered a., its paragraph set in the level's size, weight and colour.
    expect(second).toContain('>a.</span>')
    expect(second).toContain('font-size:20px')
    expect(second).toContain('font-weight:700')
    expect(second).toContain('color:#123456')
    // 'none': no marker.
    expect(third).not.toContain('data-marker')
  })

  it('a box without levels draws as before', () => {
    const html = buildListedHtml(getParagraphDeltas(body()), { fontSize: 32 })
    expect(html).not.toContain('data-marker')
  })
})

describe('list editing against level defaults', () => {
  it('reads what the paragraphs show and toggles a default list off explicitly', () => {
    const t = body()
    expect(readParagraphAttrsForRange(t, 0, 2, LEVELS).list).toBe('bullet')
    expect(readParagraphAttrsForRange(t, 0, 2).list).toBeUndefined()
    t.doc!.transact(() => toggleListKind(t, 0, 2, 'bullet', LEVELS))
    expect(getParagraphs(t)[0]!.attrs.list).toBe('none')
    t.doc!.transact(() => toggleListKind(t, 0, 2, 'bullet', LEVELS))
    expect(getParagraphs(t)[0]!.attrs.list).toBe('bullet')
  })
})
