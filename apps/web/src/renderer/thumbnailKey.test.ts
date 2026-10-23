// @vitest-environment node
/**
 * renderer/thumbnailKey.test.ts — a thumbnail's key changes with every input
 * of its picture and with nothing else (renderer/thumbnailKey.ts).
 */

import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import type { SlideObject } from '@narrative/shared'
import { thumbnailKey, type ThumbnailEnvironment, type ThumbnailInputs } from './thumbnailKey.js'
import { setColourResolver, tokenColourSignature } from './colourResolver.js'

const env: ThumbnailEnvironment = { tokenColours: () => '', fontVersions: () => new Map() }

function text(body: Y.Text | string, extra: Record<string, unknown> = {}): SlideObject {
  return {
    id: 't',
    type: 'text',
    x: 0,
    y: 0,
    width: 100,
    height: 20,
    rotation: 0,
    opacity: 1,
    text: body,
    ...extra,
  } as unknown as SlideObject
}

function inputs(objects: SlideObject[], more: Partial<ThumbnailInputs> = {}): ThumbnailInputs {
  return { objects, background: undefined, surface: undefined, slideNumber: 1, ...more }
}

/** A Y.Text attached to a document (a detached one cannot be read). */
function yText(build: (t: Y.Text) => void): Y.Text {
  const t = new Y.Doc().getText('t')
  build(t)
  return t
}

afterEach(() => setColourResolver(null))

describe('thumbnailKey', () => {
  it('is the same for equal content in new copies', () => {
    const a = inputs([text('Hello')])
    const b = inputs([text('Hello')])
    expect(thumbnailKey(a, env)).toBe(thumbnailKey(b, env))
  })

  it('changes with a run’s formatting, not only with the words', () => {
    const plain = yText((t) => t.insert(0, 'Hello'))
    const bold = yText((t) => t.insert(0, 'Hello', { bold: true }))
    expect(plain.toJSON()).toBe(bold.toJSON())
    expect(thumbnailKey(inputs([text(plain)]), env)).not.toBe(
      thumbnailKey(inputs([text(bold)]), env),
    )
  })

  it('changes with the background and the surface', () => {
    const base = thumbnailKey(inputs([]), env)
    const red = thumbnailKey(
      inputs([], { background: { kind: 'color', color: 0xff0000, alpha: 1 } }),
      env,
    )
    const dark = thumbnailKey(inputs([], { surface: 'dark' }), env)
    expect(new Set([base, red, dark]).size).toBe(3)
  })

  it('depends on the slide number only for a slide that shows it', () => {
    const plain = [text('x')]
    expect(thumbnailKey(inputs(plain, { slideNumber: 1 }), env)).toBe(
      thumbnailKey(inputs(plain, { slideNumber: 7 }), env),
    )
    const numbered = [text('#', { isSlideNumber: true })]
    expect(thumbnailKey(inputs(numbered, { slideNumber: 1 }), env)).not.toBe(
      thumbnailKey(inputs(numbered, { slideNumber: 7 }), env),
    )
  })

  it('depends on the faces of the font families the slide names', () => {
    const versions = new Map<string, number>()
    const fonts: ThumbnailEnvironment = { ...env, fontVersions: () => versions }
    const fraunces = inputs([text('x', { fontFamily: 'Fraunces' })])
    const inter = inputs([text('x', { fontFamily: 'Inter' })])
    const before = [thumbnailKey(fraunces, fonts), thumbnailKey(inter, fonts)]
    versions.set('Fraunces', 1)
    expect(thumbnailKey(fraunces, fonts)).not.toBe(before[0])
    expect(thumbnailKey(inter, fonts)).toBe(before[1])
  })
})

describe('tokenColourSignature', () => {
  const ref = { $token: 'brand' }

  it('is empty without token references, whatever the resolver', () => {
    setColourResolver(() => '#123456')
    expect(tokenColourSignature([{ fill: 0xff0000 }], undefined)).toBe('')
  })

  it('follows what the references resolve to, on the slide’s surface', () => {
    setColourResolver((_value, ctx) => (ctx?.surface === 'dark' ? '#ffffff' : '#000000'))
    const light = tokenColourSignature([{ fill: ref }], undefined)
    const dark = tokenColourSignature([{ fill: ref }], 'dark')
    expect(light).not.toBe(dark)
    setColourResolver(() => '#000000')
    expect(tokenColourSignature([{ fill: ref }], undefined)).toBe(light)
  })

  it('reads token colours inside a text body’s runs', () => {
    setColourResolver(() => '#00ff00')
    const body = yText((t) => t.insert(0, 'Hi', { color: ref }))
    expect(tokenColourSignature([{ text: body }], undefined)).toBe('#00ff00')
  })
})
