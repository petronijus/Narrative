/**
 * renderer/RenderScheduler.test.ts
 *
 * The scheduler is the only thing that paints the canvas (Pixi runs with
 * `autoStart: false`), so its two entry points have to behave differently
 * under one specific condition: a frame that was scheduled while the tab had
 * no animation frames to give. And since nothing else paints, one frame that
 * throws must not leave the canvas blank for good — nor spin in a retry loop.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MAX_CONSECUTIVE_RENDER_FAILURES, RenderScheduler } from './RenderScheduler.js'
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

/** A render group double: the two fields the scheduler's recovery touches. */
interface FakeRenderGroup {
  structureDidChange: boolean
  renderGroupChildren: FakeRenderGroup[]
}

/** An app whose render throws while `failing()` says so. */
function makeFailingApp(failing: () => boolean): {
  app: Application
  attempts: () => number
  root: FakeRenderGroup
  nested: FakeRenderGroup
} {
  let attempts = 0
  const nested: FakeRenderGroup = { structureDidChange: false, renderGroupChildren: [] }
  const root: FakeRenderGroup = { structureDidChange: false, renderGroupChildren: [nested] }
  const app = {
    renderer: {
      render: () => {
        attempts += 1
        if (failing()) throw new TypeError("Cannot read properties of null (reading 'geometry')")
        root.structureDidChange = false
        nested.structureDidChange = false
      },
    },
    stage: { renderGroup: root },
  } as unknown as Application
  return { app, attempts: () => attempts, root, nested }
}

describe('RenderScheduler', () => {
  let frames: Array<() => void>
  let ran: number
  /** Run every animation frame requested so far, and the ones those request. */
  const flushFrames = (): void => {
    while (ran < frames.length) frames[ran++]!()
  }

  beforeEach(() => {
    frames = []
    ran = 0
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

  it('skips a frame that throws and paints on the retry', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let fail = true
    const { app, attempts } = makeFailingApp(() => fail)
    const scheduler = new RenderScheduler(app)
    let painted = 0
    scheduler.onAfterRender(() => {
      painted += 1
    })

    scheduler.renderNow()
    expect(attempts()).toBe(1)
    expect(painted).toBe(0)
    expect(error).toHaveBeenCalledTimes(1)

    // Nothing else marks the scene dirty: the scheduler retries by itself.
    fail = false
    flushFrames()
    expect(attempts()).toBe(2)
    expect(painted).toBe(1)
    expect(warn).toHaveBeenCalledTimes(1)
    error.mockRestore()
    warn.mockRestore()
  })

  it('has every render group rebuild its instructions before the retry', () => {
    // Pixi replays a render group's instruction set until its structure
    // changes; one left half-built (or holding batches destroyed under it)
    // throws the same way on every later frame. A retry without a rebuild
    // can never succeed.
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let fail = true
    const { app, root, nested } = makeFailingApp(() => fail)
    const scheduler = new RenderScheduler(app)
    scheduler.renderNow()
    expect(root.structureDidChange).toBe(true)
    expect(nested.structureDidChange).toBe(true)
    fail = false
    flushFrames()
    expect(root.structureDidChange).toBe(false)
    error.mockRestore()
  })

  it('stops retrying after repeated failures and tries again on the next scene change', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let fail = true
    const { app, attempts } = makeFailingApp(() => fail)
    const scheduler = new RenderScheduler(app)

    scheduler.renderNow()
    flushFrames()
    // A bounded number of attempts, then no frame is pending: no error loop.
    expect(attempts()).toBe(MAX_CONSECUTIVE_RENDER_FAILURES)
    expect(ran).toBe(frames.length)
    // Reported when the streak starts and when the retries run out.
    expect(error).toHaveBeenCalledTimes(2)

    // A scene change still gets its frame, quietly, and schedules no retry.
    scheduler.markDirty()
    flushFrames()
    expect(attempts()).toBe(MAX_CONSECUTIVE_RENDER_FAILURES + 1)
    expect(error).toHaveBeenCalledTimes(2)

    // Once the renderer works again, the next change paints and ends the streak.
    fail = false
    scheduler.markDirty()
    flushFrames()
    expect(attempts()).toBe(MAX_CONSECUTIVE_RENDER_FAILURES + 2)
    expect(warn).toHaveBeenCalledTimes(1)

    // A later failure is a new streak, reported again.
    fail = true
    scheduler.renderNow()
    expect(error).toHaveBeenCalledTimes(3)
    error.mockRestore()
    warn.mockRestore()
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
