/**
 * renderer/RenderScheduler.test.ts
 *
 * The scheduler is the only thing that paints the canvas (Pixi runs with
 * `autoStart: false`), so its two entry points have to behave differently
 * under one specific condition: a frame that was scheduled while the tab had
 * no animation frames to give.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RenderScheduler } from './RenderScheduler.js'
import type { Application } from 'pixi.js'

function makeApp(): { app: Application; renders: () => number } {
  let renders = 0
  const app = {
    renderer: {
      render: () => {
        renders += 1
      },
    },
    stage: {},
  } as unknown as Application
  return { app, renders: () => renders }
}

describe('RenderScheduler', () => {
  let frames: Array<() => void>

  beforeEach(() => {
    frames = []
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      frames.push(cb)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
      frames[handle - 1] = () => undefined
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('coalesces repeated markDirty calls into a single frame', () => {
    const { app, renders } = makeApp()
    const scheduler = new RenderScheduler(app)
    scheduler.markDirty()
    scheduler.markDirty()
    scheduler.markDirty()
    expect(renders()).toBe(0)
    frames.forEach((f) => f())
    expect(renders()).toBe(1)
  })

  it('markDirty does nothing while a frame is still pending', () => {
    // This is the trap the visibility handler used to fall into: a tab with
    // no animation frames leaves a handle pending forever, and every later
    // markDirty() is a no-op — so the canvas can never be rescued.
    const { app, renders } = makeApp()
    const scheduler = new RenderScheduler(app)
    scheduler.markDirty() // frame scheduled, never fires (tab hidden)
    scheduler.markDirty() // would be the visibility handler's attempt
    expect(renders()).toBe(0)
  })

  it('renderNow paints immediately even with a stalled frame pending', () => {
    const { app, renders } = makeApp()
    const scheduler = new RenderScheduler(app)
    scheduler.markDirty()
    scheduler.renderNow()
    expect(renders()).toBe(1)
    // The stalled frame must not paint a second time once it is drained.
    frames.forEach((f) => f())
    expect(renders()).toBe(1)
  })

  it('reports a render that throws — once per run of failures, not every frame', () => {
    // A throwing render leaves Pixi's render group half-updated, so every
    // later frame throws as well and the canvas stops drawing. It used to be
    // swallowed as if the renderer had been torn down.
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let fail = true
    const app = {
      renderer: {
        render: () => {
          if (fail) throw new TypeError("Cannot read properties of null (reading 'alphaMode')")
        },
      },
      stage: {},
    } as unknown as Application
    const scheduler = new RenderScheduler(app)
    scheduler.renderNow()
    scheduler.renderNow()
    scheduler.renderNow()
    expect(error).toHaveBeenCalledTimes(1)

    fail = false
    scheduler.renderNow()
    fail = true
    scheduler.renderNow()
    expect(error).toHaveBeenCalledTimes(2)
    error.mockRestore()
  })

  it('stays quiet when the app was torn down between schedule and fire', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const app = { renderer: null, stage: null } as unknown as Application
    const scheduler = new RenderScheduler(app)
    scheduler.markDirty()
    frames.forEach((f) => f())
    expect(error).not.toHaveBeenCalled()
    error.mockRestore()
  })
})
