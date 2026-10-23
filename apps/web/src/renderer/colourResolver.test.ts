// @vitest-environment node
/**
 * renderer/colourResolver.test.ts
 *
 * The resolver's change broadcast and the diff that decides which objects a
 * change makes stale (`tokenColoursDiffer`) — the input side of the
 * token-colour repaint (SceneGraph.tokenColours.test.ts covers the scene).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import {
  getColourResolver,
  resolveAlpha,
  resolveColour,
  setColourResolver,
  setRenderingSurface,
  subscribeColourResolver,
  tokenColoursDiffer,
  type ColourResolverFn,
  withRenderingSurface,
} from './colourResolver'

const PINK = { $token: 'colors.pink' }
const INK = { $token: 'colors.ink' }

/** A resolver over a fixed palette; anything else is unresolved. */
function palette(colours: Record<string, string>): ColourResolverFn {
  return (value) => {
    if (typeof value === 'object' && value !== null && '$token' in value) {
      return colours[value.$token] ?? 'transparent'
    }
    return 'transparent'
  }
}

afterEach(() => {
  setColourResolver(null)
})

describe('setColourResolver / subscribeColourResolver', () => {
  it('reports the previous and the next resolver to every subscriber', () => {
    const a = palette({ 'colors.pink': '#ff2bd6' })
    const b = palette({ 'colors.pink': '#00ffff' })
    const seen: Array<[ColourResolverFn | null, ColourResolverFn | null]> = []
    const unsubscribe = subscribeColourResolver(({ prev, next }) => seen.push([prev, next]))

    setColourResolver(a)
    setColourResolver(b)
    setColourResolver(null)
    unsubscribe()

    expect(seen).toEqual([
      [null, a],
      [a, b],
      [b, null],
    ])
  })

  it('installing the resolver that is already installed tells nobody', () => {
    const a = palette({})
    setColourResolver(a)
    const listener = vi.fn()
    const unsubscribe = subscribeColourResolver(listener)
    setColourResolver(a)
    unsubscribe()
    expect(listener).not.toHaveBeenCalled()
  })

  it('an unsubscribed listener is not called again', () => {
    const listener = vi.fn()
    subscribeColourResolver(listener)()
    setColourResolver(palette({}))
    expect(listener).not.toHaveBeenCalled()
  })

  it('resolveColour uses the installed resolver, 0 without one', () => {
    expect(resolveColour(PINK)).toBe(0)
    setColourResolver(palette({ 'colors.pink': '#ff2bd6' }))
    expect(getColourResolver()).not.toBeNull()
    expect(resolveColour(PINK)).toBe(0xff2bd6)
    expect(resolveColour(0x123456)).toBe(0x123456)
    expect(resolveColour(INK)).toBe(0)
  })
})

describe('tokenColoursDiffer', () => {
  const before = palette({ 'colors.pink': '#ff2bd6', 'colors.ink': '#111111' })
  const pinkMoved = palette({ 'colors.pink': '#00ffff', 'colors.ink': '#111111' })
  const sameColours = palette({ 'colors.pink': '#ff2bd6', 'colors.ink': '#111111' })

  it('an object without token refs is never stale', () => {
    const rect = { type: 'rectangle', fill: 0xff0000, stroke: 0x00ff00, x: 0, y: 0 }
    expect(tokenColoursDiffer(rect, null, before)).toBe(false)
    expect(tokenColoursDiffer(rect, before, pinkMoved)).toBe(false)
  })

  it('a token painted before any resolver is stale once one resolves it', () => {
    expect(tokenColoursDiffer({ fill: PINK }, null, before)).toBe(true)
  })

  it('a new resolver that resolves every ref the same is not a change', () => {
    expect(tokenColoursDiffer({ fill: PINK, stroke: INK }, before, sameColours)).toBe(false)
  })

  it('only the objects linked to the moved token are stale', () => {
    expect(tokenColoursDiffer({ fill: PINK }, before, pinkMoved)).toBe(true)
    expect(tokenColoursDiffer({ fill: INK }, before, pinkMoved)).toBe(false)
  })

  it('an unresolved ref that stays unresolved is not a change', () => {
    const ghost = { fill: { $token: 'colors.deleted' } }
    expect(tokenColoursDiffer(ghost, null, before)).toBe(false)
  })

  it('finds refs nested in table cells, cell borders and defaults', () => {
    const table = {
      type: 'table',
      defaults: { color: 0x111111, fill: 0xffffff },
      rows: [
        [{ text: 'a' }, { text: 'b', border: { top: { color: PINK, width: 1 } } }],
        [{ text: 'c', fill: 0xeeeeee }, { text: 'd' }],
      ],
    }
    expect(tokenColoursDiffer(table, before, pinkMoved)).toBe(true)
    const byDefaults = { type: 'table', defaults: { color: PINK }, rows: [[{ text: 'a' }]] }
    expect(tokenColoursDiffer(byDefaults, before, pinkMoved)).toBe(true)
  })

  it('does not walk into class instances (a Y.Text body)', () => {
    const doc = new Y.Doc()
    const body = doc.getText('t')
    body.insert(0, 'hello')
    const walked = vi.fn(before)
    expect(tokenColoursDiffer({ text: body, color: 0 }, walked, pinkMoved)).toBe(false)
    expect(walked).not.toHaveBeenCalled()
    doc.destroy()
  })

  it('skip leaves out the named top-level fields only', () => {
    const shadowOnly = { fill: 0xffffff, shadow: { color: PINK, blur: 4 } }
    expect(tokenColoursDiffer(shadowOnly, before, pinkMoved, { skip: ['shadow'] })).toBe(false)
    expect(tokenColoursDiffer(shadowOnly.shadow, before, pinkMoved)).toBe(true)
    const nested = { defaults: { shadow: PINK } }
    expect(tokenColoursDiffer(nested, before, pinkMoved, { skip: ['shadow'] })).toBe(true)
  })

  it('the same resolver twice is never a change', () => {
    expect(tokenColoursDiffer({ fill: PINK }, before, before)).toBe(false)
  })
})

describe('surface and alpha (A4.2d)', () => {
  const tok = { $token: 'colors.text' }
  const base = (_v: unknown, ctx?: { surface?: string }): string =>
    ctx?.surface === 'dark' ? '#ffffff' : '#00112233'

  it('binds the canvas surface, repainting once, and lets a thumbnail use its own', () => {
    const changes: unknown[] = []
    const off = subscribeColourResolver((c) => changes.push(c))
    setColourResolver(base)
    expect(resolveColour(tok)).toBe(0x001122)
    expect(resolveAlpha(tok)).toBe(0.2)
    setRenderingSurface('dark')
    expect(resolveColour(tok)).toBe(0xffffff)
    expect(resolveAlpha(tok)).toBe(1)
    expect(changes.length).toBe(2)
    // A thumbnail of another slide: its surface for the call, nobody told.
    expect(withRenderingSurface(undefined, () => resolveColour(tok))).toBe(0x001122)
    expect(resolveColour(tok)).toBe(0xffffff)
    expect(changes.length).toBe(2)
    setRenderingSurface(undefined)
    setColourResolver(null)
    off()
  })
})
