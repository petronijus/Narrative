/**
 * renderer/thumbnailStore.test.ts — what is rendered when (performance.md →
 * B2): a thumbnail only for a new picture, visible first, the rest at idle,
 * edits after the debounce and the gesture, the live slide without an
 * offscreen render per change, retries, and the lifetime of the URLs.
 *
 * The store runs on vitest's fake timers; an idle callback is a 50 ms timer
 * here (`requestIdle` is counted, so a test can tell idle work from urgent).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SlideObject } from '@narrative/shared'
import { LIVE_ATTEMPTS, pendingThumbnailWork, ThumbnailStore } from './thumbnailStore.js'
import type { ThumbnailEnvironment, ThumbnailInputs } from './thumbnailKey.js'

const IDLE_MS = 50

function rect(id: string, x = 0): SlideObject {
  return { id, type: 'rectangle', x, y: 0, width: 10, height: 10, rotation: 0, opacity: 1, fill: 0 }
}

function slideNumberText(id: string): SlideObject {
  return {
    id,
    type: 'text',
    x: 0,
    y: 0,
    width: 100,
    height: 20,
    rotation: 0,
    opacity: 1,
    text: '#',
    isSlideNumber: true,
  } as unknown as SlideObject
}

function inputs(objects: SlideObject[], slideNumber = 1): ThumbnailInputs {
  return { objects, background: undefined, surface: undefined, slideNumber }
}

interface Rig {
  store: ThumbnailStore
  /** The objects of every offscreen render, in order (ids). */
  rendered: string[][]
  render: ReturnType<typeof vi.fn>
  live: ReturnType<typeof vi.fn>
  idleRequests: () => number
  revoked: string[]
  env: { colours: Map<string, string>; fonts: Map<string, number> }
  advance: (ms: number) => Promise<void>
}

function rig(options: { live?: boolean; cacheSize?: number } = {}): Rig {
  const rendered: string[][] = []
  let n = 0
  const render = vi.fn((i: ThumbnailInputs) => {
    rendered.push(i.objects.map((o) => o.id))
    n += 1
    return Promise.resolve(new Blob([`png-${n}`], { type: 'image/png' }))
  })
  const live = vi.fn((): Promise<Blob | null> | null => null)
  let idle = 0
  const revoked: string[] = []
  let urls = 0
  const colours = new Map<string, string>()
  const fonts = new Map<string, number>()
  const env: ThumbnailEnvironment = {
    tokenColours: (value) => {
      const json = JSON.stringify(value)
      return [...colours].filter(([token]) => json.includes(token)).join(',')
    },
    fontVersions: () => fonts,
  }
  const store = new ThumbnailStore({
    env,
    urls: {
      create: () => `blob:thumb-${++urls}`,
      revoke: (url) => revoked.push(url),
    },
    clock: {
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (h) => window.clearTimeout(h),
      requestIdle: (fn) => {
        idle += 1
        return window.setTimeout(fn, IDLE_MS)
      },
      cancelIdle: (h) => window.clearTimeout(h),
    },
    ...(options.cacheSize !== undefined ? { cacheSize: options.cacheSize } : {}),
  })
  store.start()
  if (options.live === true) store.setLiveCapture(live)
  store.setRenderer(render)
  return {
    store,
    rendered,
    render,
    live,
    idleRequests: () => idle,
    revoked,
    env: { colours, fonts },
    advance: (ms) => vi.advanceTimersByTimeAsync(ms).then(() => undefined),
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('ThumbnailStore — a render only for a new picture', () => {
  it('renders a slide once, and not again for the same content in a new copy', async () => {
    const r = rig()
    r.store.setSlide('s1', inputs([rect('a')]), { request: 'urgent' })
    await r.advance(0)
    expect(r.rendered).toEqual([['a']])
    expect(r.store.get('s1')).toBe('blob:thumb-1')

    // A deck event re-reads the slide: a fresh array of equal objects.
    r.store.setSlide('s1', inputs([rect('a')]), { request: 'urgent', debounce: true })
    await r.advance(1_000)
    expect(r.rendered).toHaveLength(1)
  })

  it('on a reorder renders only the slides that show their number', async () => {
    const r = rig()
    r.store.setSlide('plain', inputs([rect('a')], 1), { request: 'urgent' })
    r.store.setSlide('numbered', inputs([rect('b'), slideNumberText('n')], 2), {
      request: 'urgent',
    })
    await r.advance(0)
    expect(r.rendered).toHaveLength(2)

    // Moved: both numbers change.
    r.store.setSlide('plain', inputs([rect('a')], 2), { request: 'urgent' })
    r.store.setSlide('numbered', inputs([rect('b'), slideNumberText('n')], 1), {
      request: 'urgent',
    })
    await r.advance(0)
    expect(r.rendered).toEqual([['a'], ['b', 'n'], ['b', 'n']])
  })

  it('shows a cached picture again without rendering (an undo, a duplicate)', async () => {
    const r = rig()
    r.store.setSlide('s1', inputs([rect('a', 0)]), { request: 'urgent' })
    await r.advance(0)
    r.store.setSlide('s1', inputs([rect('a', 5)]), { request: 'urgent' })
    await r.advance(0)
    expect(r.store.get('s1')).toBe('blob:thumb-2')

    // Undo: back to the first content.
    r.store.setSlide('s1', inputs([rect('a', 0)]), { request: 'urgent' })
    expect(r.store.get('s1')).toBe('blob:thumb-1')
    // A duplicate of it.
    r.store.setSlide('copy', inputs([rect('a', 0)]), { request: 'urgent' })
    expect(r.store.get('copy')).toBe('blob:thumb-1')
    await r.advance(1_000)
    expect(r.rendered).toHaveLength(2)
  })

  it('renders again the slides whose token colours or font faces changed, at idle', async () => {
    const r = rig()
    const tokenRect = { ...rect('t'), fill: { $token: 'brand' } } as unknown as SlideObject
    const text = { ...slideNumberText('x'), isSlideNumber: false, fontFamily: 'Fraunces' }
    r.store.setSlide('tokens', inputs([tokenRect]), { request: 'urgent' })
    r.store.setSlide('font', inputs([text as unknown as SlideObject]), { request: 'urgent' })
    r.store.setSlide('plain', inputs([rect('p')]), { request: 'urgent' })
    await r.advance(0)
    expect(r.rendered).toHaveLength(3)

    r.env.colours.set('brand', '#ff0000')
    r.store.refreshKeys()
    await r.advance(IDLE_MS)
    expect(r.rendered.slice(3)).toEqual([['t']])

    r.env.fonts.set('Fraunces', 1)
    r.store.refreshKeys()
    await r.advance(IDLE_MS)
    expect(r.rendered.slice(4)).toEqual([['x']])
  })
})

describe('ThumbnailStore — order', () => {
  it('renders the slides in view first and the rest one per idle callback', async () => {
    const r = rig()
    r.store.setVisible(['s3', 's4'])
    for (const id of ['s1', 's2', 's3', 's4', 's5']) {
      r.store.setSlide(id, inputs([rect(id)]), { request: 'idle' })
    }
    await r.advance(0)
    // In view: at once, without waiting for an idle callback.
    expect(r.rendered).toEqual([['s3'], ['s4']])
    expect(pendingThumbnailWork()).toBe(3)

    await r.advance(IDLE_MS)
    expect(r.rendered.slice(2)).toEqual([['s1']])
    await r.advance(IDLE_MS * 2)
    expect(r.rendered.slice(2)).toEqual([['s1'], ['s2'], ['s5']])
    expect(r.idleRequests()).toBe(3)
    expect(pendingThumbnailWork()).toBe(0)
  })

  it('renders what the user did before the idle pass', async () => {
    const r = rig()
    r.store.setVisible([])
    for (const id of ['s1', 's2']) r.store.setSlide(id, inputs([rect(id)]), { request: 'idle' })
    r.store.setSlide('new', inputs([rect('new')]), { request: 'urgent' })
    await r.advance(IDLE_MS * 3)
    expect(r.rendered).toEqual([['new'], ['s1'], ['s2']])
  })

  it('debounces an edit, a burst into one render with the last state', async () => {
    const r = rig()
    r.store.setSlide('s1', inputs([rect('a')]), { request: 'urgent' })
    await r.advance(0)
    for (let x = 1; x <= 5; x++) {
      r.store.setSlide('s1', inputs([rect('a', x)]), { request: 'urgent', debounce: true })
      await r.advance(100)
    }
    expect(r.render).toHaveBeenCalledTimes(1)
    await r.advance(500)
    expect(r.render).toHaveBeenCalledTimes(2)
    expect((r.render.mock.calls[1]![0] as ThumbnailInputs).objects[0]).toMatchObject({ x: 5 })
  })

  it('holds edits while a pointer gesture lasts, however slow its moves', async () => {
    const r = rig()
    r.store.setSlide('s1', inputs([rect('a')]), { request: 'urgent' })
    await r.advance(0)
    r.store.setGestureActive(true)
    // Ninety moves, 600 ms apart: each past the debounce.
    for (let x = 1; x <= 90; x++) {
      r.store.setSlide('s1', inputs([rect('a', x)]), { request: 'urgent', debounce: true })
      await r.advance(600)
    }
    expect(r.render).toHaveBeenCalledTimes(1)
    expect(pendingThumbnailWork()).toBe(1)
    r.store.setGestureActive(false)
    await r.advance(0)
    expect(r.render).toHaveBeenCalledTimes(2)
    expect((r.render.mock.calls[1]![0] as ThumbnailInputs).objects[0]).toMatchObject({ x: 90 })
  })
})

describe("ThumbnailStore — the slide on the editor's canvas", () => {
  it('draws it from the canvas, and every other slide offscreen', async () => {
    const r = rig({ live: true })
    r.live.mockImplementation((slideId: string) =>
      slideId === 'active' ? Promise.resolve(new Blob(['live'])) : null,
    )
    r.store.setSlide('active', inputs([rect('a')]), { request: 'urgent' })
    r.store.setSlide('other', inputs([rect('o')]), { request: 'urgent' })
    await r.advance(0)
    expect(r.live).toHaveBeenCalledTimes(2)
    expect(r.rendered).toEqual([['o']])
    expect(r.store.get('active')).toBeDefined()
  })

  it('renders offscreen at once when the canvas misses and there is no picture yet', async () => {
    const r = rig({ live: true })
    r.live.mockReturnValue(Promise.resolve(null))
    r.store.setSlide('active', inputs([rect('a')]), { request: 'urgent' })
    await r.advance(0)
    expect(r.rendered).toEqual([['a']])
  })

  it('keeps the last picture when the canvas misses, and tries it again at idle', async () => {
    const r = rig({ live: true })
    r.live.mockReturnValue(Promise.resolve(new Blob(['live'])))
    r.store.setSlide('active', inputs([rect('a')]), { request: 'urgent' })
    await r.advance(0)
    const first = r.store.get('active')

    // A slow GPU: every capture misses. Ten nudges, 600 ms apart.
    r.live.mockReturnValue(Promise.resolve(null))
    for (let x = 1; x <= 10; x++) {
      r.store.setSlide('active', inputs([rect('a', x)]), { request: 'urgent', debounce: true })
      await r.advance(600)
    }
    // No offscreen render per nudge: the old picture stays meanwhile.
    expect(r.render).not.toHaveBeenCalled()
    expect(r.store.get('active')).toBe(first)

    // The last content: retried, then rendered offscreen once.
    await r.advance(10_000)
    expect(r.live.mock.calls.length).toBeGreaterThanOrEqual(10 + LIVE_ATTEMPTS - 1)
    expect(r.rendered).toEqual([['a']])
    expect((r.render.mock.calls[0]![0] as ThumbnailInputs).objects[0]).toMatchObject({ x: 10 })
    expect(r.store.get('active')).not.toBe(first)
    expect(pendingThumbnailWork()).toBe(0)
  })

  it('falls back to offscreen when reading the canvas fails and there is no picture', async () => {
    const r = rig({ live: true })
    r.live.mockReturnValue(Promise.reject(new Error('the WebGL context was lost')))
    r.store.setSlide('active', inputs([rect('a')]), { request: 'urgent' })
    await r.advance(0)
    expect(r.rendered).toEqual([['a']])
  })
})

describe('ThumbnailStore — failed renders', () => {
  const fail = () => Promise.reject(new Error('[ThumbnailRenderer] render failed: geometry'))

  it('retries a failed render with backoff, and the thumbnail arrives', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = rig()
    r.render.mockImplementationOnce(fail)
    r.store.setSlide('s1', inputs([rect('a')]), { request: 'urgent' })
    await r.advance(0)
    expect(r.render).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledTimes(1)
    await r.advance(900)
    expect(r.render).toHaveBeenCalledTimes(1)
    await r.advance(200)
    expect(r.render).toHaveBeenCalledTimes(2)
    expect(r.store.get('s1')).toBeDefined()
  })

  it('stops retrying a slide once its budget is spent', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = rig()
    r.render.mockImplementation(fail)
    r.store.setSlide('s1', inputs([rect('a')]), { request: 'urgent' })
    await r.advance(120_000)
    // The first render and four retries, then nothing more.
    expect(r.render).toHaveBeenCalledTimes(5)
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('giving up on the thumbnail'))
  })

  it('parks retries while every render fails, and resumes them after a success', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = rig()
    r.render.mockImplementation(fail)
    r.store.setSlide('s1', inputs([rect('a')]), { request: 'urgent' })
    r.store.setSlide('s2', inputs([rect('b')]), { request: 'urgent' })
    await r.advance(120_000)
    const callsWhileGone = r.render.mock.calls.length
    expect(callsWhileGone).toBeLessThanOrEqual(7)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed in a row'))
    await r.advance(120_000)
    expect(r.render).toHaveBeenCalledTimes(callsWhileGone)

    // The renderer works again: an edit to s1 renders it, and the parked s2 follows.
    r.render.mockImplementation(() => Promise.resolve(new Blob(['ok'])))
    r.store.setSlide('s1', inputs([rect('a', 1)]), { request: 'urgent' })
    await r.advance(IDLE_MS)
    expect(r.store.get('s1')).toBeDefined()
    expect(r.store.get('s2')).toBeDefined()
  })

  it('stays silent about a render rejected because its renderer was let go', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = rig()
    let reject!: (err: Error) => void
    r.render.mockImplementation(() => new Promise((_, rej) => (reject = rej)))
    r.store.setSlide('s1', inputs([rect('a')]), { request: 'urgent' })
    await r.advance(0)
    r.store.stop()
    reject(new Error('[ThumbnailRenderer] renderer has been destroyed'))
    await r.advance(60_000)
    expect(error).not.toHaveBeenCalled()
    expect(r.render).toHaveBeenCalledTimes(1)
  })
})

describe('ThumbnailStore — URLs', () => {
  it('revokes a picture once no slide shows it and it leaves the cache', async () => {
    const r = rig({ cacheSize: 1 })
    for (let x = 0; x < 3; x++) {
      r.store.setSlide('s1', inputs([rect('a', x)]), { request: 'urgent' })
      await r.advance(0)
    }
    // Shown: thumb-3; cached: thumb-2; revoked: thumb-1.
    expect(r.revoked).toEqual(['blob:thumb-1'])
    expect(r.store.get('s1')).toBe('blob:thumb-3')
  })

  it('keeps a picture another slide still shows', async () => {
    const r = rig({ cacheSize: 0 })
    r.store.setSlide('s1', inputs([rect('a')]), { request: 'urgent' })
    await r.advance(0)
    r.store.setSlide('s2', inputs([rect('a')]), { request: 'urgent' })
    r.store.setSlide('s1', inputs([rect('a', 9)]), { request: 'urgent' })
    await r.advance(0)
    expect(r.revoked).toEqual([])
    expect(r.store.get('s2')).toBe('blob:thumb-1')
  })

  it('forgets a slide that left the deck, and revokes every URL on stop', async () => {
    const r = rig({ cacheSize: 0 })
    r.store.setSlide('s1', inputs([rect('a')]), { request: 'urgent' })
    r.store.setSlide('s2', inputs([rect('b')]), { request: 'urgent' })
    await r.advance(0)
    const listener = vi.fn()
    r.store.subscribe(listener)
    r.store.retain(['s2'])
    expect(r.store.get('s1')).toBeUndefined()
    expect(r.store.snapshot()).toEqual(new Map([['s2', 'blob:thumb-2']]))
    expect(r.revoked).toEqual(['blob:thumb-1'])
    expect(listener).toHaveBeenCalledTimes(1)
    r.store.stop()
    expect(r.revoked).toEqual(['blob:thumb-1', 'blob:thumb-2'])
  })
})
