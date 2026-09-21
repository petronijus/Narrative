/**
 * renderer/pixiHtmlTextStyleScope.test.ts
 *
 * The CSS Pixi injects into `document.body` while measuring HTML text must
 * never contain a rule that can match elements outside its own SVG. See the
 * module header for what an unscoped `div { … }` did to the slide panel.
 */

import { describe, it, expect } from 'vitest'
import { HTMLTextStyle } from 'pixi.js'
import { scopeHtmlTextCss, MEASUREMENT_SCOPE } from './pixiHtmlTextStyleScope.js'

/** Selector of every top-level rule in a flat stylesheet. */
function selectorsOf(css: string): string[] {
  return [...css.matchAll(/(?:^|\})\s*([^{}]+?)\s*\{/g)].map((m) => m[1]!.trim())
}

describe('scopeHtmlTextCss', () => {
  it('prefixes every rule with the measurement scope', () => {
    const scoped = scopeHtmlTextCss(
      'div { font-size: 158px; width: 986px } b { font-weight: bold }',
    )
    expect(selectorsOf(scoped)).toEqual([`${MEASUREMENT_SCOPE} > div`, `${MEASUREMENT_SCOPE} b`])
  })

  it('scopes each member of a selector list', () => {
    const scoped = scopeHtmlTextCss('i, em { font-style: italic }')
    expect(selectorsOf(scoped)).toEqual([`${MEASUREMENT_SCOPE} i, ${MEASUREMENT_SCOPE} em`])
  })

  it('keeps the container rule off the paragraph divs inside the text', () => {
    // Pixi's `div` rule carries the padding that makes room for glyph
    // overhang. Paragraphs are divs too; a descendant rule would pad each
    // of them and push the first line down instead of giving it room.
    const scoped = scopeHtmlTextCss('div { padding: 15px } marker { color: red }')
    expect(selectorsOf(scoped)).toEqual([
      `${MEASUREMENT_SCOPE} > div`,
      `${MEASUREMENT_SCOPE} marker`,
    ])
  })

  it('leaves declarations untouched', () => {
    const css = 'div { font-family: "Proseware Pro", sans-serif; line-height: 142px }'
    expect(scopeHtmlTextCss(css)).toContain(
      'font-family: "Proseware Pro", sans-serif; line-height: 142px',
    )
  })
})

describe('HTMLTextStyle.cssStyle once the scope is installed', () => {
  it('emits no rule that could match a div outside the measurement SVG', () => {
    const style = new HTMLTextStyle({
      fontSize: 158,
      fontFamily: 'Proseware Pro',
      lineHeight: 142,
      wordWrap: true,
      wordWrapWidth: 986,
      tagStyles: { b: { fontWeight: 'bold' }, marker: { fontStyle: 'italic' } },
    })
    const selectors = selectorsOf(style.cssStyle)
    expect(selectors.length).toBeGreaterThanOrEqual(3)
    for (const sel of selectors) {
      expect(sel, `unscoped rule: ${sel}`).toMatch(new RegExp(`^${MEASUREMENT_SCOPE} `))
    }
    // The one that matters most: the main rule targets Pixi's container div and nothing inside it.
    expect(selectors[0]).toBe(`${MEASUREMENT_SCOPE} > div`)
  })

  it('still carries the geometry Pixi needs for measurement', () => {
    const style = new HTMLTextStyle({
      fontSize: 60,
      lineHeight: 72,
      wordWrap: true,
      wordWrapWidth: 900,
    })
    expect(style.cssStyle).toContain('font-size: 60px')
    expect(style.cssStyle).toContain('line-height: 72px')
    expect(style.cssStyle).toContain('max-width: 900px')
  })
})
