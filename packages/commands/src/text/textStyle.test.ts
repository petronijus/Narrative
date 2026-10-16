/**
 * textStyle.test.ts — the fields a box linked to a text style takes: a
 * width, list levels and a shrink floor exist on the box only through its
 * style, so a style that does not set them takes them off — unless the box
 * overrides them, or is a table.
 */

import { describe, expect, it } from 'vitest'
import type { FolderTokensSnapshot } from '@narrative/slide-model'
import { textStyleFields } from './textStyle.js'

const tokens: FolderTokensSnapshot = { colors: {}, textStyles: {}, effectStyles: {} }

describe('textStyleFields', () => {
  it('takes off a width, levels and floor the style does not set', () => {
    const fields = textStyleFields({ id: 'b', name: 'Body', size: 32 }, tokens)
    expect(fields['fontSize']).toBe(32)
    for (const key of ['fontStretch', 'listLevels', 'minFontSize']) {
      expect(key in fields).toBe(true)
      expect(fields[key]).toBeUndefined()
    }
  })

  it('writes them when the style sets them', () => {
    const fields = textStyleFields(
      { id: 'b', name: 'Body', fontStretch: 125, minSize: 20, levels: [{ list: 'bullet' }] },
      tokens,
    )
    expect(fields).toMatchObject({
      fontStretch: 125,
      minFontSize: 20,
      listLevels: [{ list: 'bullet' }],
    })
  })

  it("leaves an override and a table's defaults alone", () => {
    expect('fontStretch' in textStyleFields({ id: 'b', name: 'B' }, tokens, ['fontStretch'])).toBe(
      false,
    )
    const table = textStyleFields({ id: 'b', name: 'B' }, tokens, [], 'table')
    expect('listLevels' in table || 'fontStretch' in table || 'minFontSize' in table).toBe(false)
  })
})
