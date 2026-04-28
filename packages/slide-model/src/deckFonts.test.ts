/**
 * deckFonts.test.ts
 *
 * Verifies the Y.Doc-backed deck font registry — add / remove / list
 * round trip and the subscribe callback fires after each mutation.
 */

import * as Y from 'yjs'
import { describe, it, expect, vi } from 'vitest'
import {
  addDeckFont,
  getDeckFontsCtx,
  listDeckFonts,
  removeDeckFont,
  subscribeToDeckFonts,
} from './deckFonts.js'
import type { DeckFontEntry } from '@narrative/shared'

function sample(overrides: Partial<DeckFontEntry> = {}): DeckFontEntry {
  return {
    id: 'asset-inter-700',
    family: 'Inter',
    weight: 700,
    style: 'normal',
    postscriptName: 'Inter-Bold',
    addedBy: 'user-42',
    addedAt: 1_700_000_000_000,
    ...overrides,
  }
}

describe('deckFonts', () => {
  it('starts empty on a fresh doc', () => {
    const doc = new Y.Doc()
    const ctx = getDeckFontsCtx(doc)
    expect(listDeckFonts(ctx)).toEqual([])
  })

  it('addDeckFont + listDeckFonts round-trips every field', () => {
    const doc = new Y.Doc()
    const ctx = getDeckFontsCtx(doc)
    const entry = sample({ originalFilename: 'Inter-Bold.ttf' })
    addDeckFont(ctx, entry)
    expect(listDeckFonts(ctx)).toEqual([entry])
  })

  it('addDeckFont is idempotent on a duplicate id', () => {
    const doc = new Y.Doc()
    const ctx = getDeckFontsCtx(doc)
    addDeckFont(ctx, sample())
    addDeckFont(ctx, sample({ family: 'AnotherName' }))
    expect(listDeckFonts(ctx)).toHaveLength(1)
    // The first entry wins; the second call is a no-op.
    expect(listDeckFonts(ctx)[0]?.family).toBe('Inter')
  })

  it('multiple weights of the same family co-exist as separate ids', () => {
    const doc = new Y.Doc()
    const ctx = getDeckFontsCtx(doc)
    addDeckFont(ctx, sample({ id: 'a', weight: 400, postscriptName: 'Inter-Regular' }))
    addDeckFont(ctx, sample({ id: 'b', weight: 700, postscriptName: 'Inter-Bold' }))
    const fonts = listDeckFonts(ctx)
    expect(fonts).toHaveLength(2)
    expect(fonts.map((f) => f.weight).sort()).toEqual([400, 700])
  })

  it('removeDeckFont drops the entry by id', () => {
    const doc = new Y.Doc()
    const ctx = getDeckFontsCtx(doc)
    addDeckFont(ctx, sample({ id: 'a' }))
    addDeckFont(ctx, sample({ id: 'b', weight: 400 }))
    removeDeckFont(ctx, 'a')
    expect(listDeckFonts(ctx).map((f) => f.id)).toEqual(['b'])
  })

  it('removeDeckFont is a no-op for an unknown id', () => {
    const doc = new Y.Doc()
    const ctx = getDeckFontsCtx(doc)
    addDeckFont(ctx, sample())
    removeDeckFont(ctx, 'does-not-exist')
    expect(listDeckFonts(ctx)).toHaveLength(1)
  })

  it('subscribeToDeckFonts emits initial + on every mutation', () => {
    const doc = new Y.Doc()
    const ctx = getDeckFontsCtx(doc)
    const cb = vi.fn()
    const unsub = subscribeToDeckFonts(ctx, cb)

    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb.mock.calls[0]?.[0]).toEqual([])

    addDeckFont(ctx, sample())
    expect(cb).toHaveBeenCalledTimes(2)
    expect(cb.mock.calls[1]?.[0]).toEqual([sample()])

    removeDeckFont(ctx, sample().id)
    expect(cb).toHaveBeenCalledTimes(3)
    expect(cb.mock.calls[2]?.[0]).toEqual([])

    unsub()
    addDeckFont(ctx, sample())
    expect(cb).toHaveBeenCalledTimes(3) // no further calls
  })

  it('survives a Y.Doc encode → decode round trip (multiplayer sync)', () => {
    const docA = new Y.Doc()
    const ctxA = getDeckFontsCtx(docA)
    addDeckFont(ctxA, sample({ id: 'a', weight: 400 }))
    addDeckFont(ctxA, sample({ id: 'b', weight: 700 }))

    const docB = new Y.Doc()
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA))

    const ctxB = getDeckFontsCtx(docB)
    expect(
      listDeckFonts(ctxB)
        .map((f) => f.id)
        .sort(),
    ).toEqual(['a', 'b'])
  })

  it('skips malformed entries (defensive against schema drift)', () => {
    const doc = new Y.Doc()
    const ctx = getDeckFontsCtx(doc)
    // Inject a malformed Y.Map directly so we exercise yMapToFont's guards.
    doc.transact(() => {
      const m = new Y.Map<unknown>()
      m.set('id', 'broken')
      // Missing required fields — should be silently skipped.
      ctx.fonts.push([m])
    })
    expect(listDeckFonts(ctx)).toEqual([])
  })
})
