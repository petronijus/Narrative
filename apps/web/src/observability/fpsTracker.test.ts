// @vitest-environment node
/**
 * observability/fpsTracker.test.ts
 *
 * Unit testy pro FPS tracker.
 * Mock rAF — simulujeme frame callbacks ručně.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createFpsTracker } from './fpsTracker.js'

describe('createFpsTracker', () => {
  let rafCallbacks: Map<number, FrameRequestCallback>
  let rafCounter: number

  beforeEach(() => {
    rafCallbacks = new Map()
    rafCounter = 0

    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      const id = ++rafCounter
      rafCallbacks.set(id, cb)
      return id
    })

    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      rafCallbacks.delete(id)
    })

    // Mock performance.now()
    let mockTime = 0
    vi.stubGlobal('performance', {
      now: () => mockTime,
    })
    // Expose setter pro testy
    ;(globalThis as unknown as { __setMockTime: (t: number) => void }).__setMockTime = (t) => {
      mockTime = t
    }
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    rafCallbacks.clear()
  })

  function setTime(ms: number): void {
    ;(globalThis as unknown as { __setMockTime: (t: number) => void }).__setMockTime(ms)
  }

  function tickRaf(timestamp: number): void {
    setTime(timestamp)
    // Spusť všechny pending callbacks (simulace rAF)
    const callbacks = [...rafCallbacks.values()]
    rafCallbacks.clear()
    for (const cb of callbacks) {
      cb(timestamp)
    }
  }

  it('vrátí nulové stats při inicializaci bez ticků', () => {
    const tracker = createFpsTracker()
    const stats = tracker.stats()

    expect(stats.fps).toBe(0)
    expect(stats.frameTimeAvg).toBe(0)
    expect(stats.frameTimeP95).toBe(0)
    expect(stats.frameTimeP99).toBe(0)

    tracker.destroy()
  })

  it('vypočítá frameTimeAvg po několika tickách', () => {
    const tracker = createFpsTracker()

    // Simuluj 5 framů po 16.67ms (~60fps)
    tickRaf(0)
    tickRaf(16.67)
    tickRaf(33.34)
    tickRaf(50.01)
    tickRaf(66.68)

    const stats = tracker.stats()

    // frameTimeAvg by měl být přibližně 16.67ms
    expect(stats.frameTimeAvg).toBeGreaterThan(0)
    expect(stats.frameTimeAvg).toBeLessThan(100)

    tracker.destroy()
  })

  it('ignoruje frame time > 1000ms (tab background)', () => {
    const tracker = createFpsTracker()

    tickRaf(0)
    // Simuluj tab switch — velký skok
    tickRaf(5000)
    // Normální framy dál
    tickRaf(5016.67)

    const stats = tracker.stats()
    // Nesmí obsahovat 5000ms spike
    expect(stats.frameTimeP99).toBeLessThan(1000)

    tracker.destroy()
  })

  it('destroy zastaví rAF loop', () => {
    const tracker = createFpsTracker()
    expect(rafCallbacks.size).toBe(1) // Jeden pending rAF

    tracker.destroy()
    expect(rafCallbacks.size).toBe(0) // rAF byl zrušen

    // Druhý destroy nesmí hodit error
    expect(() => tracker.destroy()).not.toThrow()
  })

  it('p95 >= p99 je false — p99 >= p95', () => {
    const tracker = createFpsTracker()

    // Simuluj smíšené frame times: většina 16ms, jeden spike 100ms
    const frameTimes = [16, 16, 16, 16, 16, 16, 16, 16, 16, 100]
    let ts = 0
    tickRaf(ts)
    for (const dt of frameTimes) {
      ts += dt
      tickRaf(ts)
    }

    const stats = tracker.stats()
    expect(stats.frameTimeP99).toBeGreaterThanOrEqual(stats.frameTimeP95)

    tracker.destroy()
  })
})
