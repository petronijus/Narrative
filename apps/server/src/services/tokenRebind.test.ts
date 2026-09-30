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
    expect(plan.refs.get('colors.c_accent')).toEqual({ kind: 'literal', value: 0xff8800 })
    expect(plan.refs.get('textStyles.ts_note')).toEqual({ kind: 'literal', value: 0x777777 })
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
