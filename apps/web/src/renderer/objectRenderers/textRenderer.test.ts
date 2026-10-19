/**
 * objectRenderers/textRenderer.test.ts
 *
 * Locks in the contract between `buildStyleOpts` and Pixi v8's HTMLText
 * pipeline. The pipeline does two distinct things with `style.fontFamily`:
 *
 *   1. `extractFontFamilies` uses each Array entry as the EXACT key into
 *      Pixi's asset Cache to find the `@font-face` rules to embed in the SVG
 *      it rasterises.
 *   2. `textStyleToCSS` interpolates it verbatim into the SVG's
 *      `font-family:` CSS rule.
 *
 * The entries are therefore the keys of the faces the text draws with
 * (renderer/fontChanges.ts → `htmlTextFontKeys`, from the text's face
 * request), and the CSS that draws is a `cssOverrides` entry with the
 * properly quoted, fallback-stacked family names, which wins the cascade.
 *
 * If either invariant breaks, fonts like "Northwind Sans ST Pro 60 Black"
 * silently fall back to system Arial in the SVG renderer — that's the
 * regression these tests prevent.
 */

import { afterEach, describe, it, expect, vi } from 'vitest'
import { pixiMock } from '../../test/pixiMock'

vi.mock('pixi.js', () => pixiMock())

import { Container, HTMLText } from 'pixi.js'
import {
  buildStyleOpts,
  htmlTextFaceRequest,
  lineOvershootFor,
  textRenderer,
} from './textRenderer.js'
import { _resetFontChangesForTests, setHtmlTextFace } from '../fontChanges.js'
import type { TextObject } from '@narrative/shared'
import * as Y from 'yjs'

function makeText(overrides: Partial<TextObject> = {}): TextObject {
  return {
    id: 't1',
    type: 'text',
    x: 0,
    y: 0,
    width: 200,
    height: 60,
    rotation: 0,
    opacity: 1,
    text: 'hi',
    fontSize: 18,
    fontWeight: 'normal',
    color: 0x111111,
    align: 'left',
    ...overrides,
  } as TextObject
}

describe('buildStyleOpts — Pixi HTMLText cache + CSS bridge', () => {
  afterEach(() => _resetFontChangesForTests())

  const face = (key: string, family: string, weight: string, style = 'normal') =>
    setHtmlTextFace({ key, family, weight, style, bytes: new Uint8Array([0, 1, 0, 0]).buffer })

  it('names the BARE families the text draws with in its face request', () => {
    const request = htmlTextFaceRequest(makeText({ fontFamily: 'Northwind Sans ST Pro 60 Black' }))
    expect(request.families).toEqual(['Northwind Sans ST Pro 60 Black'])
    expect(request.weights).toEqual([400])
    expect(request.styles).toEqual(['normal'])
    expect(request.stretch).toBe(100)
  })

  it('leaves out names that cannot be embedded (a quote, </style>)', () => {
    const doc = new Y.Doc()
    const text = doc.getText('t')
    text.insert(0, 'a', { fontFamily: "O'Brien Sans" })
    text.insert(1, 'b', { fontFamily: 'Brand Sans' })
    const data = makeText({ fontFamily: 'X</style><img src=x>', text } as Partial<TextObject>)
    expect(htmlTextFaceRequest(data).families).toEqual(['Arial', 'Brand Sans'])
    // The override's quoted stack cannot end the <style> either.
    expect(buildStyleOpts(data).cssOverrides[0]).not.toContain('<')
  })

  it("adds every run's and level's family, weight and slope", () => {
    const doc = new Y.Doc()
    const text = doc.getText('t')
    text.insert(0, 'Run ')
    text.insert(4, 'Wide', { fontFamily: 'Brand Sans', fontWeight: 700 })
    text.insert(8, ' more', { fontFamily: '"Brand Sans", Druk Wide', italic: true })
    const request = htmlTextFaceRequest(
      makeText({
        fontFamily: 'Inter',
        fontWeight: 300,
        fontStretch: 87.5,
        text,
        listLevels: [{ fontFamily: 'Level Serif', fontWeight: 'bold' }],
      } as Partial<TextObject>),
    )
    expect(request.families).toEqual(['Inter', 'Level Serif', 'Brand Sans', 'Druk Wide'])
    expect(request.weights).toEqual([300, 700])
    expect(request.styles).toEqual(['normal', 'italic'])
    expect(request.stretch).toBe(87.5)
  })

  it('gives Pixi the keys of the matched faces, none for families with no faces', () => {
    face('r', 'Brand Sans', '400')
    face('b', 'Brand Sans', '700')
    face('i', 'Brand Sans', '400', 'italic')
    const plain = buildStyleOpts(makeText({ fontFamily: 'Brand Sans, Arial' }))
    expect(plain.fontFamily).toHaveLength(1)
    expect(plain.fontFamily[0]).toMatch(/^nrf-\d+$/)
    // A system font has nothing to embed: no key, so Pixi embeds nothing
    // (and WebKit skips its 100 ms wait).
    expect(buildStyleOpts(makeText()).fontFamily).toEqual([])
    expect(buildStyleOpts(makeText({ fontFamily: 'Roboto, sans-serif' })).fontFamily).toEqual([])
    // Bold needs another face: another key.
    const bold = buildStyleOpts(makeText({ fontFamily: 'Brand Sans', fontWeight: 700 }))
    expect(bold.fontFamily).not.toEqual(plain.fontFamily)
  })

  it('emits a cssOverrides entry that re-declares font-family with CSS-safe quoting', () => {
    const opts = buildStyleOpts(makeText({ fontFamily: 'Northwind Sans ST Pro 60 Black' }))
    expect(Array.isArray(opts.cssOverrides)).toBe(true)
    const decl = opts.cssOverrides.find((s: string) => s.startsWith('font-family:')) as
      string | undefined
    expect(decl).toBeDefined()
    // The override must wrap the multi-word + digit-containing family
    // in double quotes; without quotes, CSS tokenises "60" as a number
    // and drops the whole declaration.
    expect(decl!).toContain('"Northwind Sans ST Pro 60 Black"')
    // And the override must include a fallback stack — otherwise text
    // styled with an uninstalled folder font would render as the
    // browser's default serif while waiting for FolderFontLoader's
    // FontFace to resolve.
    expect(decl!).toMatch(/sans-serif$/)
  })

  it('falls back to Arial when fontFamily is undefined', () => {
    const opts = buildStyleOpts(makeText())
    expect(htmlTextFaceRequest(makeText()).families).toEqual(['Arial'])
    expect(opts.cssOverrides[0]).toContain('Arial')
  })

  it('preserves single-word family names as-is (Inter → Inter)', () => {
    const opts = buildStyleOpts(makeText({ fontFamily: 'Inter' }))
    expect(htmlTextFaceRequest(makeText({ fontFamily: 'Inter' })).families).toEqual(['Inter'])
    // The CSS override still applies a fallback stack on top, which is
    // fine — `Inter` resolves first when installed, fallback when not.
    expect(opts.cssOverrides[0]).toContain('Inter')
    expect(opts.cssOverrides[0]).toMatch(/sans-serif$/)
  })

  it('handles author-supplied stacks (comma-separated fontFamily) name by name', () => {
    const opts = buildStyleOpts(makeText({ fontFamily: 'Roboto, sans-serif' }))
    // Author included their own fallback stack — each name is asked for
    // (a folder font anywhere in the stack is embedded).
    expect(htmlTextFaceRequest(makeText({ fontFamily: 'Roboto, sans-serif' })).families).toEqual([
      'Roboto',
      'sans-serif',
    ])
    // The override should respect the author's stack rather than appending
    // another generic — cssFontFamily detects the comma and returns the
    // input unchanged.
    expect(opts.cssOverrides[0]).toContain('Roboto, sans-serif')
  })
})

/**
 * PERF-4 — text-only patches must NOT rebuild the HTMLTextStyle.
 *
 * The file header promises "text-only → set textNode.text only, NO
 * style rebuild", but the old single branch reassigned
 * `textNode.style = new HTMLTextStyle(...)` on every keystroke. Even
 * though the styleKey is unchanged (so no GPU re-raster), the `.style`
 * setter forces an extra text measure per keystroke. These tests lock
 * the split: only a typography change swaps the style instance.
 */
describe('textRenderer.applyPatch — PERF-4 style-rebuild gating', () => {
  function makeText(overrides: Partial<TextObject> = {}): TextObject {
    return {
      id: 't1',
      type: 'text',
      x: 0,
      y: 0,
      width: 200,
      height: 60,
      rotation: 0,
      opacity: 1,
      text: 'hi',
      fontSize: 18,
      fontWeight: 'normal',
      color: 0x111111,
      align: 'left',
      ...overrides,
    } as TextObject
  }

  function getTextNode(node: Container): HTMLText {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const child = node.children.find((c) => (c as any).anchor !== undefined)
    return child as unknown as HTMLText
  }

  it('does NOT swap the style instance on a text-only patch', () => {
    const node = textRenderer.mount(makeText())
    const textNode = getTextNode(node)
    const styleBefore = textNode.style
    const htmlBefore = textNode.text

    textRenderer.applyPatch(node, { text: 'hello there' })

    // Same HTMLTextStyle reference — not rebuilt.
    expect(textNode.style).toBe(styleBefore)
    // But the HTML body DID update.
    expect(textNode.text).not.toBe(htmlBefore)
  })

  it('does NOT swap the style instance on a transform-only patch', () => {
    const node = textRenderer.mount(makeText())
    const textNode = getTextNode(node)
    const styleBefore = textNode.style

    textRenderer.applyPatch(node, { x: 42, y: 7 })

    expect(textNode.style).toBe(styleBefore)
  })

  it('DOES swap the style instance when a typography field changes', () => {
    const node = textRenderer.mount(makeText())
    const textNode = getTextNode(node)
    const styleBefore = textNode.style

    textRenderer.applyPatch(node, { fontSize: 36 })

    expect(textNode.style).not.toBe(styleBefore)
  })
})

describe('textRenderer — room for ink outside the line boxes', () => {
  function makeText(overrides: Partial<TextObject> = {}): TextObject {
    return {
      id: 't1',
      type: 'text',
      x: 0,
      y: 0,
      width: 1200,
      height: 400,
      rotation: 0,
      opacity: 1,
      text: 'Sell',
      fontSize: 160,
      fontWeight: 'normal',
      color: 0x111111,
      align: 'left',
      ...overrides,
    } as TextObject
  }

  function getMask(node: Container): { rect: { mock: { calls: unknown[][] } } } {
    // The mask is the Graphics child; the HTMLText child carries `anchor`.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const child = node.children.find((c) => (c as any).anchor === undefined && (c as any).rect)
    return child as unknown as { rect: { mock: { calls: unknown[][] } } }
  }

  it('pads the HTMLText texture by the same allowance the mask opens', () => {
    // HTMLText rasterises through an SVG exactly the line boxes tall; without
    // padding the ink a short line box cannot hold is not in the texture at
    // all, and no mask can bring it back.
    const data = makeText({ lineHeight: 0.5 })
    const opts = buildStyleOpts(data)
    expect(opts.padding).toBe(lineOvershootFor(data))
    // A quarter em of margin is the floor, whatever the metrics say.
    expect(opts.padding).toBeGreaterThanOrEqual(160 * 0.25)
  })

  it('opens more room the shorter the line box', () => {
    const tight = buildStyleOpts(makeText({ lineHeight: 0.5 })).padding as number
    const roomy = buildStyleOpts(makeText({ lineHeight: 1.5 })).padding as number
    expect(tight).toBeGreaterThan(roomy)
  })

  it('rebuilds the mask when only the line height changes', () => {
    const node = textRenderer.mount(makeText({ lineHeight: 1.5 }))
    const mask = getMask(node)
    const before = mask.rect.mock.calls.length
    const topBefore = mask.rect.mock.calls[before - 1]![1] as number

    textRenderer.applyPatch(node, { lineHeight: 0.5 })

    expect(mask.rect.mock.calls.length).toBeGreaterThan(before)
    const topAfter = mask.rect.mock.calls[mask.rect.mock.calls.length - 1]![1] as number
    // The mask starts higher above the box once the glyphs overhang more.
    expect(topAfter).toBeLessThan(topBefore)
  })
})
