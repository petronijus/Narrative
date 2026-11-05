/**
 * The zoom staging hands a new resolution to the texts a batch at a time
 * (SceneGraph.restageTextResolution, textResolutionStaging.ts): the drawn
 * ones a few per frame, the hidden ones at once (nothing rasterises for
 * them). Until 2026-10-30 every text counted as hidden — the visibility
 * check read Pixi v7's `worldVisible`, which v8 does not have — and a zoom
 * commit rasterised the whole slide in its first frame.
 */
import { describe, it, expect, vi } from 'vitest'
import { pixiMock } from '../test/pixiMock'

vi.mock('pixi.js', () => pixiMock())

import { Container } from 'pixi.js'
import type { Application } from 'pixi.js'
import { SceneGraph } from './SceneGraph'

/** A text as the staging sees one: an anchor, Pixi's text flags, a resolution of its own. */
class FakeText extends Container {
  anchor = { x: 0, y: 0 }
  _didTextUpdate = false
  _autoResolution = false
  _resolution: number | null = 1
  styleKey = 'k'
  get resolution(): number | null {
    return this._resolution
  }
  set resolution(v: number | null) {
    this._autoResolution = v === null
    this._resolution = v
  }
}

function scene(texts: number, hidden: number) {
  const stage = new Container()
  const app = { stage, renderer: { uid: 1, resolution: 1 } } as unknown as Application
  const sg = new SceneGraph(app)
  const root = sg.getRoot()
  // The hidden texts first in scene order: they must not use up the batch.
  const off = new Container()
  off.visible = false
  root.addChild(off)
  const hiddenTexts = Array.from({ length: hidden }, () => new FakeText())
  for (const t of hiddenTexts) off.addChild(t)
  const drawn = Array.from({ length: texts }, () => new FakeText())
  for (const t of drawn) root.addChild(t)
  return { sg, drawn, hiddenTexts }
}

describe('SceneGraph.restageTextResolution', () => {
  /** How many drawn texts the first batch gives the new resolution. */
  const firstBatch = (texts: number, hidden: number) => {
    const { sg, drawn, hiddenTexts } = scene(texts, hidden)
    sg.restageTextResolution(2, null)
    const out = {
      drawn: drawn.filter((t) => t.resolution === 2).length,
      hidden: hiddenTexts.filter((t) => t.resolution === 2).length,
      pending: sg.pendingTextRestage,
    }
    sg.destroy()
    return out
  }

  it('starts a batch of the drawn texts, not all of them', () => {
    const b = firstBatch(100, 0)
    expect(b.drawn).toBeGreaterThan(0)
    expect(b.drawn).toBeLessThan(100)
    expect(b.pending).toBe(100 - b.drawn)
  })

  it('gives a hidden text its resolution without a place in the batch', () => {
    const alone = firstBatch(100, 0).drawn
    const b = firstBatch(100, 30)
    expect(b.hidden).toBe(30)
    expect(b.drawn).toBe(alone)
  })

  it('on a page that draws a frame a second, one quick frame among them, hands the rest out at once', () => {
    vi.useFakeTimers()
    const queued: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => queued.push(cb))
    vi.stubGlobal('cancelAnimationFrame', () => {})
    const { sg } = scene(100, 0)
    try {
      sg.restageTextResolution(2, null)
      const first = 100 - sg.pendingTextRestage
      expect(first).toBeLessThan(100)
      // Software GL: frames ~a second apart, one of them quick. Every frame
      // runs what was asked of it (the frame watch and the staging alike).
      let t = 0
      for (const dt of [900, 16, 950, 1000, 900, 1100, 950, 1000, 900, 1000]) {
        t += dt
        for (const cb of queued.splice(0)) cb(t)
        if (sg.pendingTextRestage === 0) break
      }
      expect(sg.pendingTextRestage).toBe(0)
    } finally {
      sg.destroy()
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it('does nothing when every text is at the resolution already', () => {
    const { sg, drawn } = scene(5, 0)
    for (const t of drawn) t.resolution = 2
    sg.restageTextResolution(2, null)
    expect(sg.pendingTextRestage).toBe(0)
    expect(drawn.every((t) => t.resolution === 2)).toBe(true)
    sg.destroy()
  })
})
