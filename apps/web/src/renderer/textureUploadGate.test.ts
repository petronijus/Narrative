// @vitest-environment node
/**
 * renderer/textureUploadGate.test.ts — the per-frame upload budget, the
 * order (on screen first, placeholders before upgrades, off stage last, the
 * aged before all), that nothing starves, the hold, a hidden page, and the
 * counters. Frames, visibility and the upload target are driven by hand.
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { Container, TextureSource } from 'pixi.js'
import { readPerfCounters, startPerfCounters, stopPerfCounters } from '@narrative/shared'
import {
  SMALL_UPLOAD_PX,
  TextureUploadGate,
  type TextureUploadGateOptions,
  type UploadTarget,
  type VisibilitySource,
} from './textureUploadGate'
import type { Rect } from './textResolutionStaging'

/** A 2560 × 1707 `display` texture (4.37 Mpx) and a 1280 × 853 `medium` one (1.09 Mpx). */
const DISPLAY = { w: 2560, h: 1707 }
const MEDIUM = { w: 1280, h: 853 }
const BUDGET = 2_250_000

interface FakeSource {
  label: string
  pixelWidth: number
  pixelHeight: number
  destroyed: boolean
}

function source(label: string, size: { w: number; h: number }): TextureSource {
  const s: FakeSource = { label, pixelWidth: size.w, pixelHeight: size.h, destroyed: false }
  return s as unknown as TextureSource
}

const labelOf = (s: TextureSource): string => (s as unknown as FakeSource).label

/** Records uploads, frame by frame. */
function fakeTarget() {
  const onGpu = new Set<TextureSource>()
  const frames: string[][] = [[]]
  const target: UploadTarget = {
    isUploaded: (s) => onGpu.has(s),
    upload: (s) => {
      onGpu.add(s)
      frames[frames.length - 1]!.push(labelOf(s))
    },
  }
  return { target, onGpu, frames }
}

/** Animation frames run by hand (`tick`). */
function manualFrames() {
  let next = 1
  const pending = new Map<number, () => void>()
  return {
    pendingCount: () => pending.size,
    request: (cb: () => void) => {
      const id = next++
      pending.set(id, cb)
      return id
    },
    cancel: (id: number) => {
      pending.delete(id)
    },
    tick: () => {
      const cbs = [...pending.values()]
      pending.clear()
      for (const cb of cbs) cb()
    },
  }
}

function manualVisibility(): VisibilitySource & { setHidden(h: boolean): void } {
  let hidden = false
  const subs = new Set<() => void>()
  return {
    hidden: () => hidden,
    subscribe: (cb) => {
      subs.add(cb)
      return () => subs.delete(cb)
    },
    setHidden: (h) => {
      hidden = h
      for (const cb of subs) cb()
    },
  }
}

/** A stand-in node: `box` is where `locate` says it is drawn (null: off stage). */
function node(box: Rect | null): Container {
  return { box } as unknown as Container
}

function setup(opts: Partial<TextureUploadGateOptions> = {}) {
  const t = fakeTarget()
  const frames = manualFrames()
  const visibility = manualVisibility()
  const gate = new TextureUploadGate(t.target, {
    budget: BUDGET,
    frames,
    visibility,
    locate: (n) => (n as unknown as { box: Rect | null }).box,
    ...opts,
  })
  const settled = new Set<string>()
  const admit = (s: TextureSource, p?: Parameters<TextureUploadGate['admit']>[1]) =>
    gate.admit(s, p).then(() => {
      settled.add(labelOf(s))
    })
  /** One animation frame, then the microtasks its settlements queued. */
  const frame = async () => {
    t.frames.push([])
    frames.tick()
    await flush()
  }
  return { gate, ...t, frameSource: frames, visibility, settled, admit, frame }
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0))

afterEach(() => stopPerfCounters())

describe('TextureUploadGate', () => {
  it('lets small textures and textures already on the GPU through at once, without a frame', async () => {
    const g = setup()
    const icon = source('icon', { w: 512, h: 512 })
    const shared = source('shared', DISPLAY)
    g.onGpu.add(shared)
    expect(512 * 512).toBe(SMALL_UPLOAD_PX)
    void g.admit(icon)
    void g.admit(shared)
    await flush()
    expect([...g.settled].sort()).toEqual(['icon', 'shared'])
    expect(g.frameSource.pendingCount()).toBe(0)
    expect(g.frames.flat()).toEqual([])
  })

  it('uploads a frame’s budget, the first texture whatever its size, and keeps the rest for later frames', async () => {
    const g = setup()
    void g.admit(source('d1', DISPLAY))
    void g.admit(source('m1', MEDIUM))
    void g.admit(source('m2', MEDIUM))
    void g.admit(source('m3', MEDIUM))
    await flush()
    // Nothing before a frame: the texture waits; its object shows what it showed.
    expect(g.settled.size).toBe(0)

    await g.frame()
    expect(g.frames.at(-1)).toEqual(['d1']) // larger than the budget: a frame to itself
    expect([...g.settled]).toEqual(['d1'])
    await g.frame()
    expect(g.frames.at(-1)).toEqual(['m1', 'm2']) // 2.18 Mpx ≤ 2.25
    await g.frame()
    expect(g.frames.at(-1)).toEqual(['m3'])
    expect(g.gate.pending).toBe(0)
    // Done: no more frames asked for.
    expect(g.frameSource.pendingCount()).toBe(0)
  })

  it('fills a frame first-fit: a smaller texture behind one that does not fit still goes', async () => {
    const g = setup()
    void g.admit(source('m1', MEDIUM))
    void g.admit(source('d1', DISPLAY))
    void g.admit(source('m2', MEDIUM))
    await g.frame()
    expect(g.frames.at(-1)).toEqual(['m1', 'm2'])
    await g.frame()
    expect(g.frames.at(-1)).toEqual(['d1'])
  })

  it('orders what the window shows first, placeholders before upgrades, off stage last', async () => {
    const viewport: Rect = { x: 0, y: 0, width: 1000, height: 600 }
    const g = setup({ viewport: () => viewport, budget: 1 })
    const onScreen = { x: 100, y: 100, width: 200, height: 200 }
    const below = { x: 100, y: 2000, width: 200, height: 200 }
    void g.admit(source('offStage', DISPLAY), { node: node(null) })
    void g.admit(source('belowUpgrade', DISPLAY), { node: node(below), upgrade: true })
    void g.admit(source('below', DISPLAY), { node: node(below) })
    void g.admit(source('visibleUpgrade', DISPLAY), { node: node(onScreen), upgrade: true })
    void g.admit(source('visible', DISPLAY), { node: node(onScreen) })
    void g.admit(source('background', DISPLAY)) // no node: assumed on screen
    for (let i = 0; i < 6; i++) await g.frame()
    expect(g.frames.flat()).toEqual([
      'visible',
      'background',
      'visibleUpgrade',
      'below',
      'belowUpgrade',
      'offStage',
    ])
  })

  it('a texture admitted twice is uploaded once, as urgent as its most urgent waiter', async () => {
    const viewport: Rect = { x: 0, y: 0, width: 1000, height: 600 }
    const g = setup({ viewport: () => viewport, budget: 1 })
    const shared = source('shared', DISPLAY)
    void g.admit(source('other', DISPLAY), { node: node(null) })
    void g.admit(shared, { node: node(null) })
    // A second object, on screen, wants the same picture while it waits.
    const second = g.gate.admit(shared, { node: node({ x: 0, y: 0, width: 10, height: 10 }) })
    expect(g.gate.pending).toBe(2)
    await g.frame()
    expect(g.frames.at(-1)).toEqual(['shared'])
    await second
    await g.frame()
    expect(g.frames.flat()).toEqual(['shared', 'other'])
  })

  it('starves nothing: a texture off stage goes first once it has waited maxWaitFrames', async () => {
    const g = setup({ budget: 1, maxWaitFrames: 5 })
    void g.admit(source('offStage', DISPLAY), { node: node(null) })
    let uploadedAt = -1
    for (let f = 1; f <= 12 && uploadedAt < 0; f++) {
      // A steady stream of on-screen pictures, one more than a frame takes.
      void g.admit(source(`v${f}a`, DISPLAY))
      void g.admit(source(`v${f}b`, DISPLAY))
      await g.frame()
      if (g.frames.at(-1)!.includes('offStage')) uploadedAt = f
    }
    expect(uploadedAt).toBe(5)
    expect(g.settled.has('offStage')).toBe(true)
  })

  it('a texture destroyed or uploaded elsewhere while it waits goes without an upload or a slot', async () => {
    const g = setup()
    const gone = source('gone', DISPLAY)
    const drawn = source('drawn', DISPLAY)
    void g.admit(gone)
    void g.admit(drawn)
    void g.admit(source('m1', MEDIUM))
    ;(gone as unknown as FakeSource).destroyed = true
    g.onGpu.add(drawn)
    await g.frame()
    expect(g.frames.at(-1)).toEqual(['m1'])
    expect([...g.settled].sort()).toEqual(['drawn', 'gone', 'm1'])
  })

  it('holds the queue while the hold says so, and goes on after', async () => {
    const g = setup()
    let busy = true
    g.gate.setHold(() => busy)
    void g.admit(source('d1', DISPLAY))
    await g.frame()
    await g.frame()
    expect(g.frames.flat()).toEqual([])
    expect(g.frameSource.pendingCount()).toBe(1) // still asking: nothing waits for a scene change
    busy = false
    await g.frame()
    expect(g.frames.flat()).toEqual(['d1'])
  })

  it('drains at once and unbudgeted on a hidden page (no frames come there)', async () => {
    const g = setup()
    g.visibility.setHidden(true)
    void g.admit(source('d1', DISPLAY))
    void g.admit(source('d2', DISPLAY))
    await flush()
    expect(g.frames.flat()).toEqual(['d1', 'd2'])
    expect(g.frameSource.pendingCount()).toBe(0)
  })

  it('drains what waits for a frame when the page becomes hidden', async () => {
    const g = setup()
    void g.admit(source('d1', DISPLAY))
    void g.admit(source('d2', DISPLAY))
    await g.frame()
    expect(g.frames.flat()).toEqual(['d1'])
    g.visibility.setHidden(true)
    await flush()
    expect(g.frames.flat()).toEqual(['d1', 'd2'])
    expect(g.frameSource.pendingCount()).toBe(0)
  })

  it('destroy lets every waiter go without an upload, and admits at once after', async () => {
    const g = setup()
    void g.admit(source('d1', DISPLAY))
    g.gate.destroy()
    void g.admit(source('d2', DISPLAY))
    await flush()
    expect([...g.settled].sort()).toEqual(['d1', 'd2'])
    expect(g.frames.flat()).toEqual([])
  })

  it('counts deferrals, frames waited, uploads, kpx and the largest frame', async () => {
    startPerfCounters()
    const g = setup()
    void g.admit(source('d1', DISPLAY))
    void g.admit(source('m1', MEDIUM))
    void g.admit(source('m2', MEDIUM))
    void g.admit(source('m3', MEDIUM))
    for (let i = 0; i < 3; i++) await g.frame()
    const c = readPerfCounters()
    expect(c['rm.upload.count']).toBe(4)
    expect(c['rm.upload.frames']).toBe(3)
    expect(c['rm.upload.kpx']).toBe(4370 + 3 * 1092)
    expect(c['rm.upload.frameKpxMax']).toBe(4370)
    // m1–m3 missed frame 1, m3 frame 2 too: 1 + 1 + 2 frames past their first chance.
    expect(c['rm.upload.deferred']).toBe(3)
    expect(c['rm.upload.waitFrames']).toBe(1 + 1 + 2)
  })
})
