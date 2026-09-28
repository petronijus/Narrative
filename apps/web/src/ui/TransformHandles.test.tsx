/**
 * ui/TransformHandles.test.tsx
 *
 * Testy pro TransformHandles komponentu (M7).
 *
 * - Render handles pro single-select
 * - Render handles pro multi-select (bez rotation handle)
 * - Klik na handle triggerne pointermove mode (via pointerdown event)
 * - Handles mají správné aria-label atributy
 */

import { describe, it, expect, vi } from 'vitest'
import { screen, fireEvent } from '@testing-library/react'
import { renderWithProviders as render } from '../test/renderWithProviders'
import { TransformHandles } from './TransformHandles'
import type { SceneGraph } from '../renderer/SceneGraph.js'
import type { ObjectBounds } from '../renderer/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Jednoduchý mock SceneGraph s getBounds + getMultiBounds */
function createMockSceneGraph(
  bounds: ObjectBounds | null,
  multiBounds: ObjectBounds | null = bounds,
): SceneGraph {
  return {
    getBounds: vi.fn().mockReturnValue(bounds),
    getMultiBounds: vi.fn().mockReturnValue(multiBounds),
    hitTest: vi.fn().mockReturnValue(null),
    render: vi.fn(),
    addObject: vi.fn(),
    updateObject: vi.fn(),
    removeObject: vi.fn(),
    applyChanges: vi.fn(),
    destroy: vi.fn(),
    getNode: vi.fn(),
    objectCount: 0,
  } as unknown as SceneGraph
}

/** Vytvoří ObjectBounds pro axis-aligned rectangle (rotation=0). */
function makeAxisAlignedBounds(x: number, y: number, w: number, h: number): ObjectBounds {
  return {
    world: { x, y, width: w, height: h },
    corners: [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ],
    center: { x: x + w / 2, y: y + h / 2 },
    rotation: 0,
  }
}

const RECT_BOUNDS = makeAxisAlignedBounds(100, 100, 200, 150)

const OTHER_BOUNDS = [{ id: 'other', x: 0, y: 0, width: 50, height: 50 }]

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TransformHandles — single-select', () => {
  it('renders 8 resize handles + 1 rotation handle for single-select', () => {
    const sg = createMockSceneGraph(RECT_BOUNDS)

    render(
      <TransformHandles
        objectIds={['obj-1']}
        sceneGraph={sg}
        slideId="slide-1"
        otherBounds={OTHER_BOUNDS}
      />,
    )

    // 8 resize + 1 rotation = 9 handles
    const handles = screen.getAllByRole('button')
    expect(handles).toHaveLength(9)
  })

  it('handles have correct aria-labels', () => {
    const sg = createMockSceneGraph(RECT_BOUNDS)

    render(
      <TransformHandles
        objectIds={['obj-1']}
        sceneGraph={sg}
        slideId="slide-1"
        otherBounds={OTHER_BOUNDS}
      />,
    )

    expect(screen.getByLabelText('Resize top-left handle')).toBeInTheDocument()
    expect(screen.getByLabelText('Resize top-center handle')).toBeInTheDocument()
    expect(screen.getByLabelText('Resize top-right handle')).toBeInTheDocument()
    expect(screen.getByLabelText('Resize middle-left handle')).toBeInTheDocument()
    expect(screen.getByLabelText('Resize middle-right handle')).toBeInTheDocument()
    expect(screen.getByLabelText('Resize bottom-left handle')).toBeInTheDocument()
    expect(screen.getByLabelText('Resize bottom-center handle')).toBeInTheDocument()
    expect(screen.getByLabelText('Resize bottom-right handle')).toBeInTheDocument()
    expect(screen.getByLabelText('Rotate handle')).toBeInTheDocument()
  })

  it('renders nothing when bounds are null', () => {
    const sg = createMockSceneGraph(null)

    const { container } = render(
      <TransformHandles
        objectIds={['obj-1']}
        sceneGraph={sg}
        slideId="slide-1"
        otherBounds={OTHER_BOUNDS}
      />,
    )

    expect(container.firstChild).toBeNull()
  })

  it('pointerdown on handle calls getBounds', () => {
    const sg = createMockSceneGraph(RECT_BOUNDS)

    render(
      <TransformHandles
        objectIds={['obj-1']}
        sceneGraph={sg}
        slideId="slide-1"
        otherBounds={OTHER_BOUNDS}
      />,
    )

    const tlHandle = screen.getByLabelText('Resize top-left handle')

    // setPointerCapture není dostupný v JSDOM — mockneme
    Object.defineProperty(tlHandle, 'setPointerCapture', {
      value: vi.fn(),
      writable: true,
    })

    fireEvent.pointerDown(tlHandle, { button: 0, clientX: 100, clientY: 100, pointerId: 1 })

    // getBounds se volá při pointerdown pro zjištění initial bounds
    expect(sg.getBounds).toHaveBeenCalled()
  })
})

describe('TransformHandles — multi-select', () => {
  it('renders 8 resize handles but NO rotation handle for multi-select', () => {
    const multiBounds = makeAxisAlignedBounds(80, 80, 250, 200)
    const sg = createMockSceneGraph(RECT_BOUNDS, multiBounds)

    render(
      <TransformHandles
        objectIds={['obj-1', 'obj-2']}
        sceneGraph={sg}
        slideId="slide-1"
        otherBounds={OTHER_BOUNDS}
      />,
    )

    const handles = screen.getAllByRole('button')
    // 8 handles, bez rotation
    expect(handles).toHaveLength(8)
    expect(screen.queryByLabelText('Rotate handle')).not.toBeInTheDocument()
  })

  it('uses getMultiBounds for multi-select', () => {
    const multiBounds = makeAxisAlignedBounds(80, 80, 250, 200)
    const sg = createMockSceneGraph(RECT_BOUNDS, multiBounds)

    render(
      <TransformHandles
        objectIds={['obj-1', 'obj-2']}
        sceneGraph={sg}
        slideId="slide-1"
        otherBounds={OTHER_BOUNDS}
      />,
    )

    expect(sg.getMultiBounds).toHaveBeenCalledWith(['obj-1', 'obj-2'])
    expect(sg.getBounds).not.toHaveBeenCalledWith(['obj-1', 'obj-2'])
  })

  it('renders nothing when objectIds is empty', () => {
    const sg = createMockSceneGraph(null)

    const { container } = render(
      <TransformHandles
        objectIds={[]}
        sceneGraph={sg}
        slideId="slide-1"
        otherBounds={OTHER_BOUNDS}
      />,
    )

    expect(container.firstChild).toBeNull()
  })
})

describe('TransformHandles — snap guides callback', () => {
  it('calls onSnapGuides with empty array on pointerup', () => {
    const sg = createMockSceneGraph(RECT_BOUNDS)
    const onSnapGuides = vi.fn()

    render(
      <TransformHandles
        objectIds={['obj-1']}
        sceneGraph={sg}
        slideId="slide-1"
        otherBounds={OTHER_BOUNDS}
        onSnapGuides={onSnapGuides}
      />,
    )

    const tlHandle = screen.getByLabelText('Resize top-left handle')
    Object.defineProperty(tlHandle, 'setPointerCapture', {
      value: vi.fn(),
      writable: true,
    })

    // Start drag
    fireEvent.pointerDown(tlHandle, { button: 0, clientX: 100, clientY: 100, pointerId: 1 })

    // Pointerup (global event)
    fireEvent.pointerUp(window)

    expect(onSnapGuides).toHaveBeenCalledWith([])
  })
})
