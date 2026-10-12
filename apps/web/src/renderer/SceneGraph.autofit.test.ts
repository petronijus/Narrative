/**
 * renderer/SceneGraph.autofit.test.ts — a text box that grows with its text
 * is hit and bounded where it is drawn (agentic A4.2a): its laid-out height,
 * not the `height` the document may still hold from before an agent's edit.
 *
 * HTMLText "measures" 300 px of text here (the mock's own measurement is 0).
 */

import { describe, it, expect, vi } from 'vitest'
import { pixiMock } from '../test/pixiMock'

vi.mock('pixi.js', () => {
  const mock = pixiMock()
  const Base = mock.HTMLText as unknown as new (opts?: Record<string, unknown>) => {
    scale: { y: number }
  }
  class MeasuredHTMLText extends Base {
    constructor(opts: Record<string, unknown> = {}) {
      super(opts)
      Object.defineProperty(this, 'height', {
        configurable: true,
        get: () => 300 * this.scale.y,
        set: () => {},
      })
    }
  }
  return { ...mock, HTMLText: MeasuredHTMLText }
})

import { Container, type Application } from 'pixi.js'
import { SceneGraph } from './SceneGraph'
import type { TextObject } from '@narrative/shared'

function makeGraph(): SceneGraph {
  return new SceneGraph({ stage: new Container() } as unknown as Application)
}

function text(overrides: Partial<TextObject> = {}): TextObject {
  return {
    id: 't',
    type: 'text',
    x: 100,
    y: 100,
    width: 400,
    height: 100,
    rotation: 0,
    opacity: 1,
    text: 'Grown by an agent',
    fontSize: 32,
    fontWeight: 400,
    color: 0,
    align: 'left',
    ...overrides,
  } as TextObject
}

describe('SceneGraph — a growing text box', () => {
  it('is bounded and hit at its drawn height', () => {
    const sg = makeGraph()
    sg.addObject(text({ autofit: 'grow-down' }))
    expect(sg.drawnSize('t')).toEqual({ width: 400, height: 300 })
    const b = sg.getBounds('t')!
    expect(b.world.y).toBeCloseTo(100)
    expect(b.world.height).toBeCloseTo(300)
    // Below the stored 100 px, inside the drawn 300.
    expect(sg.hitTest(200, 350)).toBe('t')
    expect(sg.hitTest(200, 420)).toBeNull()
  })

  it('a fixed box keeps its own height', () => {
    const sg = makeGraph()
    sg.addObject(text())
    expect(sg.drawnSize('t')).toEqual({ width: 400, height: 100 })
    expect(sg.hitTest(200, 350)).toBeNull()
  })
})
