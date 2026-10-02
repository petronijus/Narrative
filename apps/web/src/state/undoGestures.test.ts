/**
 * state/undoGestures.test.ts — the window's pointer gestures open and close
 * undo gestures (slide-model `beginUndoGesture` / `endUndoGesture`), with
 * the close deferred past the gesture's own pointerup handlers. The undo
 * behaviour itself is pinned in slide-model `undo.gesture.test.ts`; this
 * pins when the boundaries fall.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import * as Y from 'yjs'
import { UNDO_CAPTURE_TIMEOUT_MS } from '@narrative/slide-model'
import { usePointerUndoGestures } from './undoGestures.js'

function pointer(type: string, pointerId = 1, isPrimary = true): Event {
  // jsdom has no PointerEvent constructor; the hook reads only these fields.
  return Object.assign(new Event(type, { bubbles: true }), { pointerId, isPrimary })
}

function setup() {
  const undoManager = new Y.UndoManager(new Y.Doc().getArray('slides'))
  const stopCapturing = vi.spyOn(undoManager, 'stopCapturing')
  const hook = renderHook(() => usePointerUndoGestures(undoManager))
  const inGesture = () => undoManager.captureTimeout === Number.POSITIVE_INFINITY
  return { undoManager, stopCapturing, hook, inGesture }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('usePointerUndoGestures', () => {
  it('opens on pointerdown and closes a task after pointerup, not before', () => {
    const { undoManager, stopCapturing, inGesture } = setup()
    window.dispatchEvent(pointer('pointerdown'))
    expect(inGesture()).toBe(true)
    expect(stopCapturing).toHaveBeenCalledTimes(1)

    window.dispatchEvent(pointer('pointerup'))
    // The gesture's own pointerup handlers still write its final frame.
    expect(inGesture()).toBe(true)
    vi.runAllTimers()
    expect(undoManager.captureTimeout).toBe(UNDO_CAPTURE_TIMEOUT_MS)
    expect(stopCapturing).toHaveBeenCalledTimes(2)
  })

  it('keeps a gesture opened before the previous one finished closing', () => {
    const { inGesture } = setup()
    window.dispatchEvent(pointer('pointerdown'))
    window.dispatchEvent(pointer('pointerup'))
    window.dispatchEvent(pointer('pointerdown')) // a quick second drag
    vi.runAllTimers()
    expect(inGesture()).toBe(true)
  })

  it('stays open until the last of several pointers is released', () => {
    const { inGesture } = setup()
    window.dispatchEvent(pointer('pointerdown', 1, true))
    window.dispatchEvent(pointer('pointerdown', 2, false))
    window.dispatchEvent(pointer('pointerup', 1))
    vi.runAllTimers()
    expect(inGesture()).toBe(true)
    window.dispatchEvent(pointer('pointercancel', 2))
    vi.runAllTimers()
    expect(inGesture()).toBe(false)
  })

  it('starts a new gesture on a primary pointerdown even if a release was missed', () => {
    const { stopCapturing } = setup()
    window.dispatchEvent(pointer('pointerdown'))
    // The button was let go outside the window: no pointerup arrives.
    stopCapturing.mockClear()
    window.dispatchEvent(pointer('pointerdown'))
    // The old gesture closed (stopCapturing) and a new one opened (again).
    expect(stopCapturing).toHaveBeenCalledTimes(2)
  })

  it('closes on window blur and on unmount', () => {
    const { hook, inGesture } = setup()
    window.dispatchEvent(pointer('pointerdown'))
    window.dispatchEvent(new Event('blur'))
    expect(inGesture()).toBe(false)

    window.dispatchEvent(pointer('pointerdown'))
    hook.unmount()
    expect(inGesture()).toBe(false)
    window.dispatchEvent(pointer('pointerdown'))
    expect(inGesture()).toBe(false)
  })
})
