/**
 * renderer/settleScene.test.ts
 *
 * The "slide is settled" loop the render page reports on: it waits for the
 * slide's objects to mount, for tracked loads and fonts, and for every
 * HTMLText raster a frame starts; it gives up with what was missing, and it
 * stops when aborted. A fake scene graph (mounted ids, a container tree with
 * Pixi's per-renderer raster promises) stands in for Pixi.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Container } from 'pixi.js'
import { settleScene, type SettleScene } from './settleScene'
import { _resetRenderWorkForTests, trackRenderWork } from './renderWork'

const UID = 7

interface FakeNode {
  children: FakeNode[]
  _gpuData?: Record<number, { texturePromise?: Promise<unknown> }>
}

function fakeScene() {
  const mounted: string[] = []
  const root: FakeNode = { children: [] }
  const scene: SettleScene = {
    getMountedIds: () => [...mounted],
    getApp: () => ({ renderer: { uid: UID } }) as unknown as ReturnType<SettleScene['getApp']>,
    getRoot: () => root as unknown as Container,
  }
  /** A text node whose raster is still in flight. */
  const addRaster = (promise: Promise<unknown>) =>
    root.children.push({ children: [], _gpuData: { [UID]: { texturePromise: promise } } })
  return { scene, mounted, addRaster }
}

function deferred<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const later = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
  _resetRenderWorkForTests()
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 1),
  )
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
  Object.defineProperty(document, 'fonts', {
    value: { ready: Promise.resolve() },
    configurable: true,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('settleScene', () => {
  it('settles a mounted, idle slide and draws the final frame', async () => {
    const { scene, mounted } = fakeScene()
    mounted.push('a', 'b')
    const renderNow = vi.fn()
    const result = await settleScene(scene, {
      expectedIds: () => ['a', 'b'],
      renderNow,
      timeoutMs: 2_000,
    })
    expect(result).toMatchObject({ settled: true, missingIds: [], pendingLoads: 0, failedLoads: 0 })
    expect(renderNow).toHaveBeenCalled()
  })

  it('waits for objects that are not mounted yet', async () => {
    const { scene, mounted } = fakeScene()
    setTimeout(() => mounted.push('late'), 30)
    const result = await settleScene(scene, {
      expectedIds: () => ['late'],
      renderNow: () => {},
      timeoutMs: 2_000,
    })
    expect(result.settled).toBe(true)
    expect(result.elapsedMs).toBeGreaterThanOrEqual(25)
  })

  it('waits for tracked loads and counts the ones that failed', async () => {
    const { scene } = fakeScene()
    const image = deferred()
    const font = deferred()
    trackRenderWork(image.promise)
    trackRenderWork(font.promise).catch(() => {})
    let settled = false
    const run = settleScene(scene, { expectedIds: () => [], renderNow: () => {}, timeoutMs: 2_000 })
    void run.then(() => (settled = true))
    await later(20)
    image.resolve()
    await later(20)
    expect(settled).toBe(false)
    font.reject(new Error('404'))
    const result = await run
    expect(result).toMatchObject({ settled: true, failedLoads: 1 })
  })

  it('waits for every text raster, including one a later frame starts', async () => {
    const { scene, addRaster } = fakeScene()
    const first = deferred()
    const second = deferred()
    addRaster(first.promise)
    const renderNow = vi.fn()
    let settled = false
    const run = settleScene(scene, { expectedIds: () => [], renderNow, timeoutMs: 2_000 })
    void run.then(() => (settled = true))
    await later(10)
    expect(settled).toBe(false)
    // A font landing re-rasterises: a new raster appears as the first lands.
    addRaster(second.promise)
    first.resolve()
    await later(20)
    expect(settled).toBe(false)
    second.resolve()
    expect((await run).settled).toBe(true)
    // A frame after each landed raster, and the last one.
    expect(renderNow.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('gives up at the deadline, saying what was still missing', async () => {
    const { scene } = fakeScene()
    trackRenderWork(new Promise(() => {}))
    const result = await settleScene(scene, {
      expectedIds: () => ['never'],
      renderNow: () => {},
      timeoutMs: 60,
    })
    expect(result).toMatchObject({ settled: false, reason: 'timeout', missingIds: ['never'] })
  })

  it('stops when aborted', async () => {
    const { scene } = fakeScene()
    trackRenderWork(new Promise(() => {}))
    const stop = new AbortController()
    const run = settleScene(scene, {
      expectedIds: () => [],
      renderNow: () => {},
      timeoutMs: 10_000,
      signal: stop.signal,
    })
    stop.abort()
    const result = await run
    expect(result).toMatchObject({ settled: false, reason: 'aborted', pendingLoads: 1 })
    expect(result.elapsedMs).toBeLessThan(1_000)
  })
})
