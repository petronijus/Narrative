/**
 * state/undoGestures.test.ts — what one pointer gesture undoes, through the
 * window's real pointer events and a real undo manager: the boundaries fall
 * where the gesture starts and ends, never at a time limit, and a release
 * the window did not see cannot keep a gesture open. slide-model
 * `undo.gesture.test.ts` pins `beginUndoGesture` / `endUndoGesture`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type * as Y from 'yjs'
import { LOCAL_ORIGIN, addSlide, createSlideDoc, createUndoManager } from '@narrative/slide-model'
import { usePointerUndoGestures } from './undoGestures.js'

interface PointerInit {
  pointerId?: number
  isPrimary?: boolean
  button?: number
  buttons?: number
}

/** jsdom has no PointerEvent; the hook reads only these fields. */
function pointer(type: string, init: PointerInit = {}, target: EventTarget = window): void {
  const e = Object.assign(new Event(type, { bubbles: true }), {
    pointerId: 1,
    isPrimary: true,
    button: 0,
    buttons: type === 'pointerdown' || type === 'pointermove' ? 1 : 0,
    ...init,
  })
  target.dispatchEvent(e)
}

function editor() {
  const { doc, slides } = createSlideDoc()
  addSlide({ doc, slides })
  const undoManager = createUndoManager({ doc, slides })
  const slide = slides.get(0) as Y.Map<unknown>
  const hook = renderHook(() => usePointerUndoGestures(undoManager))
  /**
   * One local change, `ms` after the previous one (Yjs keeps its own clock,
   * out of reach of fake timers: the time since the last change is moved
   * back instead — what the capture decision compares).
   */
  const write = (value: number, ms = 16) => {
    if (undoManager.lastChange > 0) undoManager.lastChange -= ms
    doc.transact(() => slide.set('probe', value), LOCAL_ORIGIN)
  }
  const undo = () => {
    undoManager.undo()
    return slide.get('probe')
  }
  return { write, undo, hook }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('usePointerUndoGestures', () => {
  it('makes a slow drag one step, its final write on pointerup included', () => {
    const { write, undo } = editor()
    write(0, 0)
    pointer('pointerdown')
    write(1, 1_000) // the copy an Alt-drag writes on pointerdown
    write(2, 2_000) // the pointer rests for two seconds
    pointer('pointerup')
    write(3, 16) // the gesture's own pointerup / click handler
    vi.runAllTimers()
    write(4, 10) // the next change, right after: a step of its own

    expect(undo()).toBe(3)
    expect(undo()).toBe(0)
  })

  it('keeps a quick second drag apart from the first', () => {
    const { write, undo } = editor()
    pointer('pointerdown')
    write(1)
    pointer('pointerup')
    pointer('pointerdown') // within the same task: the close never ran
    write(2, 10)
    pointer('pointerup')
    vi.runAllTimers()

    expect(undo()).toBe(1)
  })

  it('keeps a gesture open until the last of several fingers lifts', () => {
    const { write, undo } = editor()
    write(0, 0)
    pointer('pointerdown', { pointerId: 1 })
    write(1)
    pointer('pointerdown', { pointerId: 2, isPrimary: false })
    pointer('pointerup', { pointerId: 1 })
    vi.runAllTimers()
    write(2, 2_000)
    pointer('pointercancel', { pointerId: 2 })
    vi.runAllTimers()

    expect(undo()).toBe(0)
  })

  it('opens no gesture for the right button, so typing after a native menu stays apart', () => {
    const { write, undo } = editor()
    pointer('pointerdown', { button: 2 })
    // The native context menu took the release; the user goes on typing.
    write(1, 1_000)
    write(2, 1_000)

    expect(undo()).toBe(1)
  })

  it('opens no gesture on a <select>, whose popup may swallow the release', () => {
    const { write, undo } = editor()
    const select = document.body.appendChild(document.createElement('select'))
    pointer('pointerdown', {}, select)
    write(1, 1_000)
    write(2, 1_000)

    expect(undo()).toBe(1)
  })

  it('notices a release the window never saw on the next move without a button', () => {
    const { write, undo } = editor()
    pointer('pointerdown')
    write(1)
    pointer('pointermove', { buttons: 0 }) // let go outside the window
    vi.runAllTimers()
    write(2, 1_000) // typing afterwards
    write(3, 1_000)

    expect(undo()).toBe(2)
  })

  it('closes on window blur and on unmount', () => {
    const { write, undo, hook } = editor()
    pointer('pointerdown')
    write(1)
    window.dispatchEvent(new Event('blur'))
    write(2, 1_000)
    expect(undo()).toBe(1)

    pointer('pointerdown')
    hook.unmount()
    write(3, 1_000)
    write(4, 1_000)
    expect(undo()).toBe(3)
  })
})
