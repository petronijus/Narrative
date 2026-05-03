/**
 * AnimationTimeline.componentInstance.test.tsx
 *
 * M16 P8 — Coverage for the per-instance Component group rendered above
 * the slide-native swimlanes in the timeline panel.
 *
 * Scope of this file:
 *   - Renders a component group when the active slide has a
 *     componentInstance object.
 *   - Renders a "Missing component" placeholder when the master can't
 *     resolve (cache reports synced + null snapshot).
 *
 * The fine-grained interactions (delay edit, drag reorder, reset) live
 * in `ComponentAnimationGroup.test.tsx` — there's no need to repeat the
 * same RTL gymnastics through the entire timeline tree.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import * as Y from 'yjs'
import type { ComponentInstanceObject, AnimationStep, SlideObject } from '@narrative/shared'
import { AnimationTimeline } from './AnimationTimeline'
import { SelectionProvider } from '../state/SelectionContext'
import { ActiveSlideContext } from '../state/ActiveSlideContext'
import type { ComponentSnapshot } from '../state/extractComponentSnapshot'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const slideObjects: SlideObject[] = []
const animations: AnimationStep[] = []

vi.mock('../state/useAnimations', () => ({
  useAnimations: () => ({
    animations,
    animationsCtx: {
      doc: new Y.Doc(),
      animations: new Y.Doc().getArray('animations'),
    },
  }),
}))

vi.mock('../state/useSlideObjects', () => ({
  useSlideObjects: () => ({
    objects: slideObjects,
    objectsCtx: { doc: new Y.Doc(), objects: new Y.Doc().getArray('objects') },
  }),
}))

vi.mock('../state/useShortcuts', () => ({
  useShortcuts: () => {},
}))

vi.mock('../state/DeckRoleContext', () => ({
  useDeckRole: () => ({ role: 'owner', folderId: 'folder-1' }),
}))

vi.mock('../renderer/CanvasInstanceContext', () => ({
  useCanvasInstance: () => null,
}))

vi.mock('../state/useVideoInfo', () => ({
  useVideoInfo: () => ({ info: null }),
}))

let mockMasterStatus: 'pending' | 'synced' | 'missing' = 'synced'
let mockMasterSnapshot: ComponentSnapshot | null = null

vi.mock('../state/useInstanceMasterSnapshot', () => ({
  useInstanceMasterSnapshot: () => ({
    status: mockMasterStatus,
    snapshot: mockMasterSnapshot,
  }),
}))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STEP_A: AnimationStep = {
  id: 'step-a',
  objectId: 'leaf-a',
  preset: 'fadeIn',
  trigger: 'afterPrevious',
  duration: 0.5,
  delay: 0,
  easing: 'power2.out',
}

function makeInstance(): ComponentInstanceObject {
  return {
    id: 'inst-1',
    type: 'componentInstance',
    componentId: 'comp-1',
    componentName: 'Card',
    x: 0,
    y: 0,
    width: 400,
    height: 300,
    rotation: 0,
    opacity: 1,
  }
}

function renderTimeline(): void {
  render(
    <ActiveSlideContext.Provider
      value={{ activeSlideId: 'mock-slide-0', setActiveSlideId: () => {} }}
    >
      <SelectionProvider>
        <AnimationTimeline />
      </SelectionProvider>
    </ActiveSlideContext.Provider>,
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AnimationTimeline — component group (M16 P8)', () => {
  beforeEach(() => {
    cleanup()
    slideObjects.length = 0
    animations.length = 0
    mockMasterStatus = 'synced'
    mockMasterSnapshot = {
      objects: [],
      animations: [STEP_A],
      bbox: { x: 0, y: 0, width: 400, height: 300 },
    }
  })

  it('renders a component group when the slide has a componentInstance', () => {
    slideObjects.push(makeInstance())
    // Stub one native animation so the timeline renders past the empty-state
    // branch (where component groups still belong, but the empty-state
    // placeholder takes priority above).
    animations.push({
      id: 'native-1',
      objectId: 'inst-1',
      preset: 'fadeIn',
      trigger: 'afterPrevious',
      duration: 0.5,
      delay: 0,
      easing: 'power2.out',
    })
    renderTimeline()
    expect(screen.getByTestId('animation-timeline-component-groups')).toBeInTheDocument()
    expect(screen.getByTestId('component-anim-group-inst-1')).toBeInTheDocument()
    expect(screen.getByTestId('component-anim-row-inst-1-step-a')).toBeInTheDocument()
  })

  it('renders the Missing component placeholder when master is missing', () => {
    slideObjects.push(makeInstance())
    animations.push({
      id: 'native-1',
      objectId: 'inst-1',
      preset: 'fadeIn',
      trigger: 'afterPrevious',
      duration: 0.5,
      delay: 0,
      easing: 'power2.out',
    })
    mockMasterStatus = 'missing'
    mockMasterSnapshot = null
    renderTimeline()
    expect(screen.getByTestId('component-anim-group-missing-inst-1')).toHaveTextContent(
      'Missing component',
    )
  })
})
