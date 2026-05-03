/**
 * ComponentAnimationGroup.test.tsx
 *
 * M16 P8 — RTL coverage for the per-instance animation group:
 *   - Group renders one row per master step (resolved via
 *     resolveInstanceAnimations).
 *   - Editing a row's delay writes via setAnimationOverride.
 *   - Reset on a row writes via clearAnimationOverride.
 *   - Drag-reorder within the group writes a per-step `order` override
 *     for every step in the group (single Yjs transact wrapping the
 *     batch).
 *   - Master-missing instance shows the muted placeholder.
 *
 * The state-sync helpers are mocked — the Yjs ops are exercised in the
 * slide-model package's own tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import * as Y from 'yjs'
import type {
  ComponentInstanceObject,
  AnimationStep,
  ComponentInstanceOverrides,
} from '@narrative/shared'
import * as slideModel from '@narrative/slide-model'
import { ComponentAnimationGroup } from './ComponentAnimationGroup'
import type { ComponentSnapshot } from '../state/extractComponentSnapshot'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockSetAnimationOverride = vi.fn()
const mockClearAnimationOverride = vi.fn()

vi.mock('@narrative/slide-model', async (importOriginal) => {
  const actual = await importOriginal<typeof slideModel>()
  return {
    ...actual,
    setAnimationOverride: (...args: Parameters<typeof actual.setAnimationOverride>) => {
      mockSetAnimationOverride(...args)
    },
    clearAnimationOverride: (...args: Parameters<typeof actual.clearAnimationOverride>) => {
      mockClearAnimationOverride(...args)
    },
  }
})

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

function makeInstance(overrides?: ComponentInstanceOverrides): ComponentInstanceObject {
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
    ...(overrides !== undefined ? { overrides } : {}),
  }
}

const STEP_A: AnimationStep = {
  id: 'step-a',
  objectId: 'leaf-a',
  preset: 'fadeIn',
  trigger: 'afterPrevious',
  duration: 0.5,
  delay: 0,
  easing: 'power2.out',
}

const STEP_B: AnimationStep = {
  id: 'step-b',
  objectId: 'leaf-b',
  preset: 'slideIn',
  trigger: 'afterPrevious',
  duration: 0.6,
  delay: 0.2,
  easing: 'power2.out',
  params: { direction: 'up' },
}

function makeSnapshot(): ComponentSnapshot {
  return {
    objects: [],
    animations: [STEP_A, STEP_B],
    bbox: { x: 0, y: 0, width: 400, height: 300 },
  }
}

function fakeMutationCtx(): slideModel.ObjectsMutationContext {
  const doc = new Y.Doc()
  return { doc, objects: doc.getArray('objects') }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ComponentAnimationGroup (M16 P8)', () => {
  beforeEach(() => {
    mockSetAnimationOverride.mockReset()
    mockClearAnimationOverride.mockReset()
    mockMasterStatus = 'synced'
    mockMasterSnapshot = makeSnapshot()
    cleanup()
  })

  it('renders one row per master step', () => {
    render(
      <ComponentAnimationGroup
        instance={makeInstance()}
        mutationCtx={fakeMutationCtx()}
        disabled={false}
      />,
    )
    expect(screen.getByTestId('component-anim-row-inst-1-step-a')).toBeInTheDocument()
    expect(screen.getByTestId('component-anim-row-inst-1-step-b')).toBeInTheDocument()
  })

  it('shows the master name and step count in the header', () => {
    render(
      <ComponentAnimationGroup
        instance={makeInstance()}
        mutationCtx={fakeMutationCtx()}
        disabled={false}
      />,
    )
    const header = screen.getByTestId('component-anim-group-header-inst-1')
    expect(header).toHaveTextContent('Card')
    expect(header).toHaveTextContent('2 steps')
  })

  it('flags a step as Modified when an override exists', () => {
    render(
      <ComponentAnimationGroup
        instance={makeInstance({ animations: { 'step-a': { delay: 1.2 } } })}
        mutationCtx={fakeMutationCtx()}
        disabled={false}
      />,
    )
    expect(screen.getByTestId('component-anim-badge-inst-1-step-a')).toHaveTextContent('Modified')
    expect(screen.getByTestId('component-anim-badge-inst-1-step-b')).toHaveTextContent('Linked')
  })

  it("editing a step's delay writes via setAnimationOverride", () => {
    render(
      <ComponentAnimationGroup
        instance={makeInstance()}
        mutationCtx={fakeMutationCtx()}
        disabled={false}
      />,
    )
    const input = screen.getByTestId('component-anim-delay-inst-1-step-a') as HTMLInputElement
    fireEvent.change(input, { target: { value: '0.75' } })
    expect(mockSetAnimationOverride).toHaveBeenCalledTimes(1)
    expect(mockSetAnimationOverride.mock.calls[0]?.[1]).toBe('inst-1')
    expect(mockSetAnimationOverride.mock.calls[0]?.[2]).toBe('step-a')
    expect(mockSetAnimationOverride.mock.calls[0]?.[3]).toEqual({ delay: 0.75 })
  })

  it("Reset on a row clears that step's override", () => {
    render(
      <ComponentAnimationGroup
        instance={makeInstance({ animations: { 'step-a': { delay: 1.2 } } })}
        mutationCtx={fakeMutationCtx()}
        disabled={false}
      />,
    )
    const reset = screen.getByTestId('component-anim-reset-inst-1-step-a')
    expect(reset).toBeEnabled()
    fireEvent.click(reset)
    expect(mockClearAnimationOverride).toHaveBeenCalledTimes(1)
    expect(mockClearAnimationOverride.mock.calls[0]?.[1]).toBe('inst-1')
    expect(mockClearAnimationOverride.mock.calls[0]?.[2]).toBe('step-a')
  })

  it('drag-reordering within the group writes per-step `order` overrides in one transact', () => {
    const ctx = fakeMutationCtx()
    const transactSpy = vi.spyOn(ctx.doc, 'transact')
    render(<ComponentAnimationGroup instance={makeInstance()} mutationCtx={ctx} disabled={false} />)
    // Simulate drag of the second step (step-b) up to position 0.
    const handle = screen.getByLabelText('Reorder slideIn (up)')
    expect(handle).toBeInTheDocument()
    fireEvent.pointerDown(handle, { button: 0, clientY: 100, pointerId: 1 })
    // pointerMove must dispatch on the same handle — tests use fireEvent.pointerMove
    // on the captured target since jsdom doesn't simulate cross-element capture.
    fireEvent.pointerMove(handle, { button: 0, clientY: 0, pointerId: 1 })
    fireEvent.pointerUp(handle, { button: 0, clientY: 0, pointerId: 1 })

    // Two setAnimationOverride writes — one per step — and they ran
    // inside a single doc.transact.
    expect(mockSetAnimationOverride).toHaveBeenCalledTimes(2)
    expect(transactSpy).toHaveBeenCalledTimes(1)
    // Resulting order: [step-b at 0, step-a at 1]
    const calls = mockSetAnimationOverride.mock.calls
    const callForStepB = calls.find((c) => c[2] === 'step-b')
    const callForStepA = calls.find((c) => c[2] === 'step-a')
    expect(callForStepB?.[3]).toEqual({ order: 0 })
    expect(callForStepA?.[3]).toEqual({ order: 1 })
  })

  it('shows "Missing component" placeholder when master is missing', () => {
    mockMasterStatus = 'missing'
    mockMasterSnapshot = null
    render(
      <ComponentAnimationGroup
        instance={makeInstance()}
        mutationCtx={fakeMutationCtx()}
        disabled={false}
      />,
    )
    expect(screen.getByTestId('component-anim-group-missing-inst-1')).toHaveTextContent(
      'Missing component',
    )
    // No rows rendered.
    expect(screen.queryByTestId('component-anim-row-inst-1-step-a')).not.toBeInTheDocument()
  })
})
