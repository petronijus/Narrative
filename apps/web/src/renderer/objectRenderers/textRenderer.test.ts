/**
 * objectRenderers/textRenderer.test.ts
 *
 * Locks in the contract between `buildStyleOpts` and Pixi v8's HTMLText
 * pipeline. The pipeline does two distinct things with `style.fontFamily`:
 *
 *   1. `extractFontFamilies` uses it (or each Array entry) as the EXACT
 *      key into Pixi's asset Cache to find an `@font-face` URL to embed
 *      in the SVG it rasterises.
 *   2. `textStyleToCSS` interpolates it verbatim into the SVG's
 *      `font-family:` CSS rule.
 *
 * FolderFontLoader registers folder-uploaded fonts under their BARE
 * family name (e.g. `Northwind Sans ST Pro 60 Black-and-url`). For the
 * cache lookup to hit, `style.fontFamily` must equal the bare name. For
 * the resulting CSS to be VALID for family names containing digits or
 * spaces, the rendered rule needs CSS-side quoting. We square that
 * circle by passing the bare name as `style.fontFamily` AND layering a
 * `cssOverrides` entry with a properly quoted + fallback-stacked
 * declaration that wins the cascade.
 *
 * If either invariant breaks, fonts like "Northwind Sans ST Pro 60 Black"
 * silently fall back to system Arial in the SVG renderer — that's the
 * regression these tests prevent.
 */

import { describe, it, expect, vi } from 'vitest'
import { pixiMock } from '../../test/pixiMock'

vi.mock('pixi.js', () => pixiMock())

import { Container, HTMLText } from 'pixi.js'
import { buildStyleOpts, textRenderer } from './textRenderer.js'
import type { TextObject } from '@narrative/shared'

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
  it('passes BARE family name as style.fontFamily (cache lookup hits)', () => {
    const opts = buildStyleOpts(makeText({ fontFamily: 'Northwind Sans ST Pro 60 Black' }))
    // Pixi's extractFontFamilies uses style.fontFamily verbatim as the
    // cache key. The bare name matches FolderFontLoader's registration.
    expect(opts.fontFamily).toBe('Northwind Sans ST Pro 60 Black')
  })

  it('emits a cssOverrides entry that re-declares font-family with CSS-safe quoting', () => {
    const opts = buildStyleOpts(makeText({ fontFamily: 'Northwind Sans ST Pro 60 Black' }))
    expect(Array.isArray(opts.cssOverrides)).toBe(true)
    const decl = opts.cssOverrides.find((s: string) => s.startsWith('font-family:')) as
      | string
      | undefined
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
    // No custom family → no cache lookup needed → pass a CSS-valid
    // system font as the bare name.
    expect(opts.fontFamily).toBe('Arial')
    expect(opts.cssOverrides[0]).toContain('Arial')
  })

  it('preserves single-word family names as-is (Inter → Inter)', () => {
    const opts = buildStyleOpts(makeText({ fontFamily: 'Inter' }))
    expect(opts.fontFamily).toBe('Inter')
    // The CSS override still applies a fallback stack on top, which is
    // fine — `Inter` resolves first when installed, fallback when not.
    expect(opts.cssOverrides[0]).toContain('Inter')
    expect(opts.cssOverrides[0]).toMatch(/sans-serif$/)
  })

  it('handles author-supplied stacks (comma-separated fontFamily) by passing through', () => {
    const opts = buildStyleOpts(makeText({ fontFamily: 'Roboto, sans-serif' }))
    // Author included their own fallback stack — pass through as the
    // bare value (Pixi's cache lookup will miss, which is fine because
    // none of the families are folder-uploaded).
    expect(opts.fontFamily).toBe('Roboto, sans-serif')
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
