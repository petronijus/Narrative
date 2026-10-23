// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { HTMLTextStyle } from 'pixi.js'
import '../pixiHtmlTextStyleScope.js'
import { containerDeclarations } from './readRuns.js'

describe('containerDeclarations', () => {
  it('reads the declarations of the one container rule Pixi writes for a style', () => {
    const style = new HTMLTextStyle({
      fontFamily: ['nrf-1'],
      fontSize: 24,
      fill: '#112233',
      padding: 7,
      wordWrap: true,
      wordWrapWidth: 300,
      lineHeight: 30,
      cssOverrides: ['font-family: "Brand Sans", Arial', 'width: 300px', 'box-sizing: content-box'],
    })
    const decls = containerDeclarations(style.cssStyle)
    expect(decls).not.toBeNull()
    expect(decls).toContain('padding: 7px')
    expect(decls).toContain('font-size: 24px')
    // The override comes after Pixi's own family, so it still wins inline.
    expect(decls!.indexOf('font-family: "Brand Sans"')).toBeGreaterThan(
      decls!.indexOf('font-family: nrf-1'),
    )
    expect(decls).not.toMatch(/[{}]/u)
  })

  it('keeps the <style> path for anything but one container rule', () => {
    expect(
      containerDeclarations('foreignObject > div { color: red } foreignObject b { x: y }'),
    ).toBeNull()
    expect(containerDeclarations('div { color: red }')).toBeNull()
    expect(containerDeclarations('foreignObject > div { color: red </style> }')).toBeNull()
  })
})
