/**
 * routes/pptxExport.test.ts
 *
 * Unit tests for the token-resolution step that the PPTX export route runs
 * before handing slides to `writeDeck`. Token refs in Narrative live at
 * arbitrary depth (top-level on shapes/text, nested under
 * `shadow`/`defaults`/`border`, deeply under `rows[r][c]` for tables, and
 * inside the `borderSegments` record-map). Each layer must resolve so the
 * exported `.pptx` carries concrete colours; a reference that cannot be
 * resolved is written as a neutral grey (`replaceUnresolvedTokens`).
 */

import { describe, it, expect } from 'vitest'
import {
  replaceUnresolvedTokens,
  resolveSlideTokens,
  UNRESOLVED_TOKEN_COLOUR,
} from './pptxExport.js'
import { DEFAULT_TRANSITION } from '@narrative/shared'
import type {
  Slide,
  TextObject,
  RectangleObject,
  TableObject,
  ShadowStyle,
} from '@narrative/shared'
import type { FolderTokensSnapshot } from '@narrative/slide-model'

const TOKENS: FolderTokensSnapshot = {
  colors: {
    brand: { id: 'brand', name: 'Brand', value: '#ff8800' },
    ink: { id: 'ink', name: 'Ink', value: '#112233' },
  },
  textStyles: {},
  effectStyles: {},
}

function wrap(objects: Slide['objects']): Slide {
  return {
    id: 's1',
    objects,
    animations: [],
    transition: DEFAULT_TRANSITION,
  }
}

describe('resolveSlideTokens', () => {
  it('resolves a top-level TokenRef on TextObject.color', () => {
    const t: TextObject = {
      id: 't1',
      type: 'text',
      x: 0,
      y: 0,
      width: 100,
      height: 50,
      rotation: 0,
      opacity: 1,
      text: 'hi',
      fontSize: 18,
      fontWeight: 'normal',
      color: { $token: 'colors.brand' },
      align: 'left',
    }
    const out = resolveSlideTokens(wrap([t]), TOKENS)
    expect((out.objects[0] as TextObject).color).toBe(0xff8800)
  })

  it('resolves a nested TokenRef on RectangleObject.shadow.color', () => {
    const shadow: ShadowStyle = {
      color: { $token: 'colors.ink' },
      blur: 4,
      offsetX: 2,
      offsetY: 2,
      opacity: 0.5,
    }
    const r: RectangleObject = {
      id: 'r1',
      type: 'rectangle',
      x: 0,
      y: 0,
      width: 100,
      height: 50,
      rotation: 0,
      opacity: 1,
      fill: 0xffffff,
      shadow,
    }
    const out = resolveSlideTokens(wrap([r]), TOKENS)
    const rr = out.objects[0] as RectangleObject
    expect(rr.shadow?.color).toBe(0x112233)
  })

  it('resolves TokenRefs deep inside a TableObject (defaults, cell, border, segment)', () => {
    // Token refs sit at four depths: `defaults.color`, `defaults.border.color`,
    // `rows[0][0].color`, `rows[0][0].border.top.color`, and
    // `borderSegments['h:0:0'].color`. All five must come out as numbers.
    const table: TableObject = {
      id: 't1',
      type: 'table',
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      rotation: 0,
      opacity: 1,
      colWidths: [200],
      rowHeights: [50, 50],
      rows: [
        [
          {
            text: 'A1',
            color: { $token: 'colors.brand' },
            border: { top: { color: { $token: 'colors.ink' }, width: 2 } },
          },
        ],
        [{ text: 'A2' }],
      ],
      defaults: {
        fontSize: 18,
        fontWeight: 'normal',
        color: { $token: 'colors.ink' },
        align: 'left',
        vAlign: 'middle',
        border: { color: { $token: 'colors.brand' }, width: 1 },
        padding: { top: 8, right: 8, bottom: 8, left: 8 },
      },
      borderSegments: {
        'h:0:0': { color: { $token: 'colors.brand' }, width: 4 },
      },
    }
    const out = resolveSlideTokens(wrap([table]), TOKENS)
    const tbl = out.objects[0] as TableObject
    expect(tbl.defaults.color).toBe(0x112233)
    expect((tbl.defaults.border as { color: number; width: number }).color).toBe(0xff8800)
    expect(tbl.rows[0]![0]!.color).toBe(0xff8800)
    expect(tbl.rows[0]![0]!.border!.top!.color).toBe(0x112233)
    expect(tbl.borderSegments!['h:0:0']!.color).toBe(0xff8800)
  })

  it('leaves unresolvable token refs in place (unknown token id)', () => {
    const t: TextObject = {
      id: 't1',
      type: 'text',
      x: 0,
      y: 0,
      width: 100,
      height: 50,
      rotation: 0,
      opacity: 1,
      text: 'hi',
      fontSize: 18,
      fontWeight: 'normal',
      color: { $token: 'colors.does-not-exist' },
      align: 'left',
    }
    const out = resolveSlideTokens(wrap([t]), TOKENS)
    // Ref stays as-is — `replaceUnresolvedTokens` then writes it as grey.
    expect((out.objects[0] as TextObject).color).toEqual({
      $token: 'colors.does-not-exist',
    })
  })

  it('is idempotent on a slide with no token refs (concrete numbers pass through)', () => {
    const r: RectangleObject = {
      id: 'r1',
      type: 'rectangle',
      x: 0,
      y: 0,
      width: 100,
      height: 50,
      rotation: 0,
      opacity: 1,
      fill: 0xabcdef,
    }
    const slide = wrap([r])
    const out = resolveSlideTokens(slide, TOKENS)
    // Object reference is preserved when nothing changed — cheap fast path.
    expect(out.objects[0]).toBe(r)
  })
})

describe('replaceUnresolvedTokens', () => {
  it('writes every remaining token reference as the grey fallback, at any depth, and counts them', () => {
    const slide = wrap([
      {
        id: 'r',
        type: 'rectangle',
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        rotation: 0,
        opacity: 1,
        fill: { $token: 'colors.gone' },
        stroke: 0x123456,
        shadow: {
          color: { $token: 'colors.gone' },
          blur: 1,
          offsetX: 0,
          offsetY: 0,
          opacity: 1,
        } as ShadowStyle,
      } as RectangleObject,
    ])
    const counter = { count: 0 }
    const out = replaceUnresolvedTokens(slide, counter)
    const r = out.objects[0] as RectangleObject
    expect(r.fill).toBe(UNRESOLVED_TOKEN_COLOUR)
    expect(r.shadow?.color).toBe(UNRESOLVED_TOKEN_COLOUR)
    expect(r.stroke).toBe(0x123456)
    expect(counter.count).toBe(2)
  })

  it('returns the same objects when nothing needs replacing', () => {
    const slide = wrap([
      {
        id: 't',
        type: 'rectangle',
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        rotation: 0,
        opacity: 1,
        fill: 0xffffff,
      } as RectangleObject,
    ])
    const counter = { count: 0 }
    expect(replaceUnresolvedTokens(slide, counter).objects[0]).toBe(slide.objects[0])
    expect(counter.count).toBe(0)
  })
})
