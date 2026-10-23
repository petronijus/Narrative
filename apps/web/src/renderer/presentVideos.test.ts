/**
 * renderer/presentVideos.test.ts — which file the present-mode video pool
 * opens, and how it switches when the display changes (performance.md → P3):
 * the other file buffered on its first frame first, the switch made only
 * while the video is off stage, a change taken back cancelled.
 *
 * jsdom loads no media: `load()` is stubbed to report `canplaythrough` on
 * the next task, as a buffered element would.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VideoObject } from '@narrative/shared'

const attached = vi.hoisted(() => [] as Array<{ id: string; el: HTMLVideoElement }>)
vi.mock('./objectRenderers/videoRenderer.js', () => ({
  attachLiveVideo: (id: string, el: HTMLVideoElement) => attached.push({ id, el }),
  releaseLiveVideoElement: () => undefined,
}))

import { PresentVideoPool } from './presentVideos.js'
import {
  _resetDefaultVideoInfoResolver,
  setDefaultVideoInfoResolver,
  type VideoInfoResult,
} from './videoInfo.js'

const ORIGINAL = 'https://s/playback.mp4'
const RENDITION = 'https://s/present.mp4'

const info: VideoInfoResult = {
  assetId: 'a1',
  transcodeStatus: 'done',
  durationSec: 10,
  width: 3840,
  height: 2160,
  posterUrl: null,
  thumbnailUrl: null,
  playbackUrl: ORIGINAL,
  presentPlayback: { url: RENDITION, width: 1920, height: 1080 },
  transcodeError: null,
}

const video: VideoObject = {
  id: 'v1',
  type: 'video',
  assetId: 'a1',
  x: 0,
  y: 0,
  width: 1920,
  height: 1080,
  rotation: 0,
  opacity: 1,
} as VideoObject

/** The src of an element, without jsdom resolving it against the page. */
const srcOf = (el: HTMLVideoElement | undefined): string | null => el?.getAttribute('src') ?? null

describe('PresentVideoPool (performance.md P3)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    attached.length = 0
    setDefaultVideoInfoResolver(() => Promise.resolve(info))
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(function (
      this: HTMLMediaElement,
    ) {
      if (this.getAttribute('src') !== null)
        setTimeout(() => this.dispatchEvent(new Event('canplaythrough')), 0)
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    _resetDefaultVideoInfoResolver()
  })

  it('opens the rendition where the presentation shows no more pixels than it has', async () => {
    const pool = new PresentVideoPool({ deviceScale: () => 1 })
    const prepared = pool.prepare([video])
    await vi.advanceTimersByTimeAsync(10)
    await prepared
    expect(pool.get('v1')?.kind).toBe('present')
    expect(srcOf(pool.get('v1')?.element)).toBe(RENDITION)
    expect(attached.map((a) => a.id)).toEqual(['v1'])
    pool.destroy()
  })

  it('opens the original where more pixels are shown', async () => {
    const pool = new PresentVideoPool({ deviceScale: () => 2 })
    const prepared = pool.prepare([video])
    await vi.advanceTimersByTimeAsync(10)
    await prepared
    expect(pool.get('v1')?.kind).toBe('playback')
    expect(srcOf(pool.get('v1')?.element)).toBe(ORIGINAL)
    pool.destroy()
  })

  it('switches files after a display change, off stage, once the other is buffered', async () => {
    let scale = 2
    let offStage = false
    const switched: string[] = []
    const pool = new PresentVideoPool({
      deviceScale: () => scale,
      canSwitch: () => offStage,
      onSwitched: (id) => switched.push(id),
    })
    const prepared = pool.prepare([video])
    await vi.advanceTimersByTimeAsync(10)
    await prepared
    const first = pool.get('v1')!.element
    expect(srcOf(first)).toBe(ORIGINAL)

    // Fullscreen on a 1080p projector: the rendition is enough now.
    scale = 1
    pool.displayChanged()
    pool.displayChanged() // a resize is many events: acted on once
    await vi.advanceTimersByTimeAsync(1000)
    // Buffered, but the video is on stage: it plays its file on.
    expect(pool.get('v1')!.element).toBe(first)
    expect(pool.get('v1')!.kind).toBe('playback')
    expect(switched).toEqual([])

    offStage = true
    await vi.advanceTimersByTimeAsync(300)
    const second = pool.get('v1')!.element
    expect(second).not.toBe(first)
    expect(srcOf(second)).toBe(RENDITION)
    expect(pool.get('v1')!.kind).toBe('present')
    // Every scene draws the new element; the old one let go of its file.
    expect(attached.at(-1)).toEqual({ id: 'v1', el: second })
    expect(srcOf(first)).toBeNull()
    expect(switched).toEqual(['v1'])
    pool.destroy()
  })

  it('cancels a switch the display took back', async () => {
    let scale = 2
    const created: HTMLVideoElement[] = []
    const createElement = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = createElement(tag)
      if (tag === 'video') created.push(el as HTMLVideoElement)
      return el
    }) as typeof document.createElement)
    const pool = new PresentVideoPool({ deviceScale: () => scale, canSwitch: () => false })
    const prepared = pool.prepare([video])
    await vi.advanceTimersByTimeAsync(10)
    await prepared
    const first = pool.get('v1')!.element

    scale = 1
    pool.displayChanged()
    await vi.advanceTimersByTimeAsync(1000)
    expect(created).toHaveLength(2)
    // Back to the laptop before the video left the stage.
    scale = 2
    pool.displayChanged()
    await vi.advanceTimersByTimeAsync(1000)
    expect(pool.get('v1')!.element).toBe(first)
    expect(srcOf(created[1])).toBeNull()
    pool.destroy()
  })

  it('reports a switch still buffering (the load waits for it)', async () => {
    let scale = 2
    const pool = new PresentVideoPool({ deviceScale: () => scale })
    const prepared = pool.prepare([video])
    await vi.advanceTimersByTimeAsync(10)
    await prepared
    scale = 1
    pool.displayChanged()
    let done = false
    void pool.whenSwitched().then(() => {
      done = true
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(done).toBe(true)
    expect(pool.get('v1')!.kind).toBe('present')
    pool.destroy()
  })
})
