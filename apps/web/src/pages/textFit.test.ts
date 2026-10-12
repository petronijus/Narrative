/**
 * pages/textFit.test.ts — which text boxes the render page reports as
 * overflowing: a text box whose laid-out text ends below its box, beyond
 * the rounding tolerance; never another object, a box not drawn yet, or a
 * text not measured yet. (The measurement itself — the browser laying the
 * text out in the real fonts — is the e2e's: query-render.spec.ts.)
 */

import { describe, expect, it, vi } from 'vitest'
import type { SlideObject } from '@narrative/shared'

vi.mock('../renderer/objectRenderers/textRenderer.js', () => ({
  laidOutTextBottom: (container: { bottom: number | null }, data: { type: string }) =>
    data.type === 'text' ? container.bottom : null,
}))

import { measureTextOverflow } from './textFit'

const box = (id: string, height: number, type: SlideObject['type'] = 'text') =>
  ({ id, type, x: 0, y: 0, width: 400, height }) as SlideObject

function scene(bottoms: Record<string, number | null>) {
  return {
    getNode: (id: string) =>
      id in bottoms
        ? ({ container: { bottom: bottoms[id] }, data: {} } as unknown as ReturnType<
            Parameters<typeof measureTextOverflow>[0]['getNode']
          >)
        : undefined,
  }
}

describe('measureTextOverflow', () => {
  it('reports the text boxes whose text runs below them, rounded to slide px', () => {
    const objects = [box('fits', 100), box('runs-over', 100), box('exactly', 80)]
    expect(
      measureTextOverflow(scene({ fits: 96, 'runs-over': 141.6, exactly: 80.7 }), objects, 's1'),
    ).toEqual([{ slideId: 's1', objectId: 'runs-over', boxHeight: 100, textHeight: 142 }])
  })

  it('ignores other objects, a box not in the scene and a text not measured yet', () => {
    const objects = [box('shape', 10, 'rectangle'), box('missing', 10), box('pending', 10)]
    expect(measureTextOverflow(scene({ shape: 500, pending: null }), objects, 's1')).toEqual([])
  })

  it('never reports a box that grows with its text; a shrinking one as it is drawn', () => {
    const grows = { ...box('grows', 100), autofit: 'grow-down' } as SlideObject
    const shrinks = { ...box('shrinks', 100), autofit: 'shrink' } as SlideObject
    expect(measureTextOverflow(scene({ grows: 300, shrinks: 130 }), [grows, shrinks], 's1')).toEqual(
      [{ slideId: 's1', objectId: 'shrinks', boxHeight: 100, textHeight: 130 }],
    )
  })
})
