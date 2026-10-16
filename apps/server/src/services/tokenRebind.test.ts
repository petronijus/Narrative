/**
 * services/tokenRebind.test.ts — the token-rebinding rule a deck move (and a
 * cross-folder deck.insertFrom) applies: match by category + normalised
 * name, otherwise literal colour / detached text style / untouched effect,
 * at every depth a reference can sit.
 */

import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  addObjects,
  addSlide,
  createSlideDoc,
  getSlideObjectsCtx,
  type FolderTokensSnapshot,
} from '@narrative/slide-model'
import type { RectangleObject, TextObject } from '@narrative/shared'
import { applyTokenRebinding, planTokenRebinding } from './tokenRebind.js'

const SOURCE: FolderTokensSnapshot = {
  colors: {
    c_brand: { id: 'c_brand', name: 'Brand Blue', value: '#0033aa' },
    c_accent: { id: 'c_accent', name: 'Accent', value: '#ff8800' },
    c_same: { id: 'c_same', name: 'Ink', value: '#111111' },
  },
  textStyles: {
    ts_head: { id: 'ts_head', name: 'Headline', color: { $token: 'colors.c_accent' } },
    ts_note: { id: 'ts_note', name: 'Footnote', color: '#777777' },
  },
  effectStyles: {
    fx_soft: { id: 'fx_soft', name: 'Soft shadow', kind: 'shadow', params: {} },
    fx_glow: { id: 'fx_glow', name: 'Glow', kind: 'shadow', params: {} },
  },
}

const DEST: FolderTokensSnapshot = {
  colors: {
    // Same name, other spelling: matches.
    d_brand_b: { id: 'd_brand_b', name: '  brand   blue ', value: '#0044bb' },
    d_brand_a: { id: 'd_brand_a', name: 'Brand Blue', value: '#0055cc' },
    c_same: { id: 'c_same', name: 'ink', value: '#000000' },
  },
  textStyles: { d_head: { id: 'd_head', name: 'headline' } },
  effectStyles: { d_soft: { id: 'd_soft', name: 'SOFT SHADOW', kind: 'shadow', params: {} } },
}

describe('planTokenRebinding', () => {
  const plan = planTokenRebinding(SOURCE, DEST)

  it('matches by normalised name, taking the smallest destination id on a tie', () => {
    expect(plan.refs.get('colors.c_brand')).toEqual({ kind: 'rebind', to: 'colors.d_brand_a' })
    expect(plan.refs.get('textStyles.ts_head')).toEqual({
      kind: 'rebind',
      to: 'textStyles.d_head',
    })
    expect(plan.refs.get('effectStyles.fx_soft')).toEqual({
      kind: 'rebind',
      to: 'effectStyles.d_soft',
    })
    expect(plan.textStyleLinks.get('ts_head')).toBe('d_head')
  })

  it('falls back to the literal colour, a detached link, or leaving an effect alone', () => {
    expect(plan.refs.get('colors.c_accent')).toEqual({ kind: 'literal' })
    expect(plan.refs.get('textStyles.ts_note')).toEqual({ kind: 'literal' })
    expect(plan.textStyleLinks.get('ts_note')).toBeNull()
    expect(plan.refs.get('effectStyles.fx_glow')).toEqual({ kind: 'keep' })
  })
})

function deckWithReferences(): Y.Doc {
  const deck = createSlideDoc()
  addSlide(deck)
  const [s1, s2] = deck.slides.toArray().map((m) => m.get('id') as string)
  const objects = getSlideObjectsCtx(deck, s1!)!
  const rect: RectangleObject = {
    id: 'r1',
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    rotation: 0,
    opacity: 1,
    fill: { $token: 'colors.c_brand' },
    stroke: { $token: 'colors.c_accent' },
    shadow: { color: { $token: 'colors.c_same' }, blur: 4, offsetX: 1, offsetY: 1, opacity: 0.5 },
  }
  const text: TextObject = {
    id: 't1',
    type: 'text',
    x: 0,
    y: 0,
    width: 100,
    height: 40,
    rotation: 0,
    opacity: 1,
    text: 'Hello world',
    fontSize: 20,
    fontWeight: 'normal',
    color: { $token: 'textStyles.ts_head' },
    align: 'left',
    textStyleId: 'ts_head',
  }
  const note: TextObject = { ...text, id: 't2', textStyleId: 'ts_note', color: 0x222222 }
  const dangling: TextObject = {
    ...text,
    id: 't3',
    textStyleId: 'gone',
    color: { $token: 'colors.gone' },
  }
  addObjects(objects, [rect, text, note, dangling])
  // A run coloured with a token.
  const body = objects.objects.get(1).get('text') as Y.Text
  deck.doc.transact(() => body.format(0, 5, { color: { $token: 'colors.c_accent' } }))
  // A background on the second slide.
  deck.slides.get(1).set('background', { kind: 'solid', color: { $token: 'colors.c_brand' } })
  void s2
  return deck.doc
}

describe('across style packs (A5.4)', () => {
  // Two folders' compiled packs: every role token is called "Text" or
  // "Accent" in both, so only the compile's origin pairs them right.
  const contoso: FolderTokensSnapshot = {
    colors: {
      'p-contoso-role-text': {
        id: 'p-contoso-role-text',
        name: 'Accent',
        value: '#001e50',
        byVariant: { axis: 'background', values: { dark: '#ffffff' } },
        origin: { pack: 'contoso', key: 'role:text' },
      },
      'p-contoso-role-accent': {
        id: 'p-contoso-role-accent',
        name: 'Text',
        value: '#00b0f0',
        origin: { pack: 'contoso', key: 'role:accent' },
      },
      'p-contoso-color-blue': {
        id: 'p-contoso-color-blue',
        name: 'Blue',
        value: '#0040c5',
        origin: { pack: 'contoso', key: 'color:blue' },
      },
    },
    textStyles: {},
    effectStyles: {},
  }
  const fabrikam: FolderTokensSnapshot = {
    colors: {
      'p-fabrikam-role-accent': {
        id: 'p-fabrikam-role-accent',
        name: 'Accent',
        value: '#bb0a30',
        origin: { pack: 'fabrikam', key: 'role:accent' },
      },
      'p-fabrikam-role-text': {
        id: 'p-fabrikam-role-text',
        name: 'Text',
        value: '#000000',
        origin: { pack: 'fabrikam', key: 'role:text' },
      },
    },
    textStyles: {},
    effectStyles: {},
  }

  it("pairs a pack's tokens by what they are for, not by their names", () => {
    const plan = planTokenRebinding(contoso, fabrikam)
    expect(plan.refs.get('colors.p-contoso-role-text')).toEqual({
      kind: 'rebind',
      to: 'colors.p-fabrikam-role-text',
    })
    expect(plan.refs.get('colors.p-contoso-role-accent')).toEqual({
      kind: 'rebind',
      to: 'colors.p-fabrikam-role-accent',
    })
    // Fabrikam has no blue: it becomes the colour it was.
    expect(plan.refs.get('colors.p-contoso-color-blue')).toEqual({ kind: 'literal' })
  })

  it("prefers the destination's current pack where an earlier pack left tokens behind", () => {
    const withOld: FolderTokensSnapshot = {
      ...fabrikam,
      colors: {
        ...fabrikam.colors,
        'p-aaa-role-text': {
          id: 'p-aaa-role-text',
          name: 'Text',
          value: '#333333',
          origin: { pack: 'aaa', key: 'role:text' },
        },
      },
    }
    // By id alone the old pack's token sorts first.
    expect(planTokenRebinding(contoso, withOld).refs.get('colors.p-contoso-role-text')).toEqual({
      kind: 'rebind',
      to: 'colors.p-aaa-role-text',
    })
    expect(
      planTokenRebinding(contoso, withOld, { destPackId: 'fabrikam' }).refs.get(
        'colors.p-contoso-role-text',
      ),
    ).toEqual({ kind: 'rebind', to: 'colors.p-fabrikam-role-text' })
  })

  it("literalises a colour as it was drawn: on the deck's variant", () => {
    const deck = createSlideDoc()
    deck.doc.getMap('meta').set('variant', { background: 'dark' })
    const objects = getSlideObjectsCtx(deck, deck.slides.get(0).get('id') as string)!
    addObjects(objects, [
      {
        id: 'r1',
        type: 'rectangle',
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        rotation: 0,
        opacity: 1,
        fill: { $token: 'colors.p-contoso-role-text' },
      } as RectangleObject,
    ])
    const onlyBlue: FolderTokensSnapshot = { colors: {}, textStyles: {}, effectStyles: {} }
    applyTokenRebinding(deck.doc, planTokenRebinding(contoso, onlyBlue))
    // White, the dark variant's text colour — not the light default navy.
    expect(objects.objects.get(0).get('fill')).toBe(0xffffff)
  })
})

describe('applyTokenRebinding', () => {
  it('rewrites references at every depth and counts what it did', () => {
    const doc = deckWithReferences()
    const counts = applyTokenRebinding(doc, planTokenRebinding(SOURCE, DEST))
    const s1 = doc.getArray<Y.Map<unknown>>('slides').get(0)
    const objects = (s1.get('objects') as Y.Array<Y.Map<unknown>>).toArray()
    const byId = new Map(objects.map((m) => [m.get('id'), m]))

    const r1 = byId.get('r1')!
    expect(r1.get('fill')).toEqual({ $token: 'colors.d_brand_a' })
    expect(r1.get('stroke')).toBe(0xff8800)
    // Same id, same name in both folders: untouched but counted as rebound.
    expect((r1.get('shadow') as { color: unknown }).color).toEqual({ $token: 'colors.c_same' })

    const t1 = byId.get('t1')!
    expect(t1.get('color')).toEqual({ $token: 'textStyles.d_head' })
    expect(t1.get('textStyleId')).toBe('d_head')
    const run = (t1.get('text') as Y.Text).toDelta()[0] as { attributes?: { color?: unknown } }
    expect(run.attributes?.color).toBe(0xff8800)

    const t2 = byId.get('t2')!
    expect(t2.has('textStyleId')).toBe(false)
    expect(t2.get('color')).toBe(0x222222)

    const t3 = byId.get('t3')!
    expect(t3.get('textStyleId')).toBe('gone')
    expect(t3.get('color')).toEqual({ $token: 'colors.gone' })

    const bg = doc.getArray<Y.Map<unknown>>('slides').get(1).get('background') as { color: unknown }
    expect(bg.color).toEqual({ $token: 'colors.d_brand_a' })

    expect(counts).toEqual({ rebound: 5, literalised: 2, detached: 1, unmatched: 2 })
  })

  it('touches only the slides it is given', () => {
    const doc = deckWithReferences()
    const second = doc.getArray<Y.Map<unknown>>('slides').get(1)
    applyTokenRebinding(doc, planTokenRebinding(SOURCE, DEST), [second])
    const r1 = (
      doc.getArray<Y.Map<unknown>>('slides').get(0).get('objects') as Y.Array<Y.Map<unknown>>
    ).get(0)
    expect(r1.get('fill')).toEqual({ $token: 'colors.c_brand' })
    expect((second.get('background') as { color: unknown }).color).toEqual({
      $token: 'colors.d_brand_a',
    })
  })
})
