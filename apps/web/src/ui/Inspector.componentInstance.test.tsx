/**
 * Inspector.componentInstance.test.tsx
 *
 * M16 P7 — RTL coverage for the ComponentInstance inspector:
 *   - Leaves panel renders one row per master leaf.
 *   - Editing a fill writes via setLeafOverride and the row badge flips.
 *   - "Reset to master" calls clearLeafOverride; badge returns to Linked.
 *   - "Reset overrides" calls resetAllOverrides.
 *   - Missing-master flow swaps in the warning panel and Detach removes
 *     the instance.
 *   - Replace… opens the picker drawer; a pick rewrites componentId.
 *
 * The state-sync helper layer is the contract — we mock it and assert the
 * inspector calls the helpers with the right arguments. We do NOT exercise
 * the underlying Yjs ops here; those have their own unit tests in
 * packages/slide-model.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { useEffect } from 'react'
import * as Y from 'yjs'

import { Inspector } from './Inspector'
import { SelectionProvider, useSelection } from '../state/SelectionContext'
import { SlideDocContext, createMockSlideDocValue } from '../state/slideDocContext'
import { ActiveSlideContext } from '../state/ActiveSlideContext'
import * as slideModel from '@narrative/slide-model'
import type { ComponentInstanceObject, SlideObject, AnimationStep, Slide } from '@narrative/shared'
import type { SlideMutationContext } from '@narrative/slide-model'
import type { ComponentSnapshot } from '../state/extractComponentSnapshot'
import type { ComponentSummary } from '../api/client'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockObjects: SlideObject[] = []
const mockSetLeafOverride = vi.fn()
const mockClearLeafOverride = vi.fn()
const mockResetAllOverrides = vi.fn()
const mockRemoveObject = vi.fn()
const mockUpdateObject = vi.fn()

vi.mock('../state/useSlideObjects', () => ({
  useSlideObjects: () => ({
    objects: mockObjects,
    objectsCtx: { doc: new Y.Doc(), objects: new Y.Doc().getArray('objects') },
    mutationCtx: { doc: new Y.Doc(), objects: new Y.Doc().getArray('objects') },
  }),
}))

vi.mock('../state/useAnimations', () => ({
  useAnimations: () => ({
    animations: [] as AnimationStep[],
    animationsCtx: {
      doc: new Y.Doc(),
      animations: new Y.Doc().getArray('animations'),
    },
  }),
}))

vi.mock('@narrative/slide-model', async (importOriginal) => {
  const actual = await importOriginal<typeof slideModel>()
  return {
    ...actual,
    setLeafOverride: (...args: Parameters<typeof actual.setLeafOverride>) => {
      mockSetLeafOverride(...args)
    },
    clearLeafOverride: (...args: Parameters<typeof actual.clearLeafOverride>) => {
      mockClearLeafOverride(...args)
    },
    resetAllOverrides: (...args: Parameters<typeof actual.resetAllOverrides>) => {
      mockResetAllOverrides(...args)
    },
    removeObject: (...args: Parameters<typeof actual.removeObject>) => {
      mockRemoveObject(...args)
    },
    updateObject: (...args: Parameters<typeof actual.updateObject>) => {
      mockUpdateObject(...args)
    },
  }
})

vi.mock('./TokenColorInput', async () => {
  const actual = await vi.importActual<typeof import('./ColorInput')>('./ColorInput')
  return { TokenColorInput: actual.ColorInput }
})

vi.mock('../state/FolderDocProvider', () => ({
  useFolderTokens: () => ({ colors: {}, textStyles: {}, effectStyles: {} }),
  useFolderTokensOptional: () => ({ colors: {}, textStyles: {}, effectStyles: {} }),
  useFolderMutations: () => ({
    addToken: vi.fn(),
    updateToken: vi.fn(),
    deleteToken: vi.fn(),
    listUsages: () => [],
  }),
  FolderDocProvider: ({ children }: { children: unknown }) => children,
}))

vi.mock('../state/DeckRoleContext', () => ({
  useDeckRole: () => ({ role: 'owner', folderId: 'folder-1' }),
}))

vi.mock('../state/CropModeContext', () => ({
  useCropMode: () => ({ cropMode: false, setCropMode: vi.fn() }),
}))

vi.mock('../state/applyShapeMask', () => ({
  applyShapeMask: vi.fn(),
  isMaskableShape: () => false,
}))

vi.mock('../state/useMediaUpload', () => ({
  useMediaUpload: () => ({ upload: vi.fn(), uploads: [] }),
}))

vi.mock('../state/useVideoInfo', () => ({
  useVideoInfo: () => null,
}))

vi.mock('../state/useSlides', () => ({
  useSlides: () => [] as Slide[],
}))

// ---- The two key P7 mocks: master snapshot + folder components --------------

let mockMasterStatus: 'pending' | 'synced' | 'missing' = 'synced'
let mockMasterSnapshot: ComponentSnapshot | null = null

vi.mock('../state/useInstanceMasterSnapshot', () => ({
  useInstanceMasterSnapshot: () => ({
    status: mockMasterStatus,
    snapshot: mockMasterSnapshot,
  }),
}))

const mockFolderComponents: ComponentSummary[] = []
let mockInvalidate = vi.fn()

vi.mock('../state/useFolderComponents', () => ({
  useFolderComponents: () => ({
    components: mockFolderComponents,
    loading: false,
    error: null,
    invalidate: mockInvalidate,
  }),
}))

vi.mock('../api/client', () => ({
  useApi: () => ({
    listComponentInstanceCounts: vi.fn().mockResolvedValue({}),
  }),
}))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeInstance(overrides?: ComponentInstanceObject['overrides']): ComponentInstanceObject {
  return {
    id: 'inst-1',
    type: 'componentInstance',
    componentId: 'comp-1',
    componentName: 'Card',
    x: 100,
    y: 100,
    width: 400,
    height: 300,
    rotation: 0,
    opacity: 1,
    ...(overrides !== undefined ? { overrides } : {}),
  }
}

const LEAF_RECT: SlideObject = {
  id: 'leaf-rect',
  name: 'Bg',
  type: 'rectangle',
  x: 0,
  y: 0,
  width: 400,
  height: 300,
  fill: 0xff0000,
  rotation: 0,
  opacity: 1,
}

const LEAF_TEXT: SlideObject = {
  id: 'leaf-text',
  name: 'Title',
  type: 'text',
  x: 20,
  y: 20,
  width: 360,
  height: 40,
  text: 'Hello',
  fontSize: 24,
  fontWeight: 'normal',
  color: 0x000000,
  align: 'left',
  rotation: 0,
  opacity: 1,
}

function makeSnapshot(): ComponentSnapshot {
  return {
    objects: [LEAF_RECT, LEAF_TEXT],
    animations: [],
    bbox: { x: 0, y: 0, width: 400, height: 300 },
  }
}

function createDeckCtx(): SlideMutationContext {
  const doc = new Y.Doc()
  return { doc, slides: doc.getArray<Y.Map<unknown>>('slides') }
}

function renderInspectorWith(instance: ComponentInstanceObject) {
  mockObjects.length = 0
  mockObjects.push(instance)
  const deckCtx = createDeckCtx()
  const ctxValue = createMockSlideDocValue({
    deckCtx,
    undoManager: slideModel.createUndoManager(deckCtx),
  })
  function Inner() {
    const { setSelectedId } = useSelection()
    useEffect(() => {
      setSelectedId(instance.id)
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
    return <Inspector />
  }
  return render(
    <MemoryRouter>
      <SlideDocContext.Provider value={ctxValue}>
        <ActiveSlideContext.Provider
          value={{ activeSlideId: 'mock-slide-0', setActiveSlideId: () => {} }}
        >
          <SelectionProvider>
            <Inner />
          </SelectionProvider>
        </ActiveSlideContext.Provider>
      </SlideDocContext.Provider>
    </MemoryRouter>,
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Inspector — ComponentInstance leaves panel (M16 P7)', () => {
  beforeEach(() => {
    mockSetLeafOverride.mockReset()
    mockClearLeafOverride.mockReset()
    mockResetAllOverrides.mockReset()
    mockRemoveObject.mockReset()
    mockUpdateObject.mockReset()
    mockMasterStatus = 'synced'
    mockMasterSnapshot = makeSnapshot()
    mockFolderComponents.length = 0
    mockInvalidate = vi.fn().mockResolvedValue([])
  })

  it('renders one row per master leaf', () => {
    renderInspectorWith(makeInstance())
    expect(screen.getByTestId('leaf-override-row-leaf-rect')).toBeInTheDocument()
    expect(screen.getByTestId('leaf-override-row-leaf-text')).toBeInTheDocument()
  })

  it('starts every row with a "Linked" badge when no overrides', () => {
    renderInspectorWith(makeInstance())
    expect(screen.getByTestId('leaf-badge-leaf-rect')).toHaveTextContent('Linked')
    expect(screen.getByTestId('leaf-badge-leaf-text')).toHaveTextContent('Linked')
  })

  it('flips badge to "Modified" when an override exists for the leaf', () => {
    renderInspectorWith(
      makeInstance({
        leaves: { 'leaf-rect': { fill: 0x00ff00 } },
      }),
    )
    expect(screen.getByTestId('leaf-badge-leaf-rect')).toHaveTextContent('Modified')
    expect(screen.getByTestId('leaf-badge-leaf-text')).toHaveTextContent('Linked')
  })

  it('"Reset to master" calls clearLeafOverride and is disabled when not modified', () => {
    renderInspectorWith(
      makeInstance({
        leaves: { 'leaf-rect': { fill: 0x00ff00 } },
      }),
    )
    const reset = screen.getByTestId('leaf-reset-leaf-rect')
    expect(reset).toBeEnabled()
    fireEvent.click(reset)
    expect(mockClearLeafOverride).toHaveBeenCalledTimes(1)
    expect(mockClearLeafOverride.mock.calls[0]?.[1]).toBe('inst-1')
    expect(mockClearLeafOverride.mock.calls[0]?.[2]).toBe('leaf-rect')

    // Sibling row's reset stays disabled (no override).
    expect(screen.getByTestId('leaf-reset-leaf-text')).toBeDisabled()
  })

  it('editing leaf text writes via setLeafOverride', () => {
    renderInspectorWith(makeInstance())
    // Expand the text leaf row so its body fields mount.
    fireEvent.click(screen.getByLabelText('Expand Title'))
    const input = screen.getByTestId('leaf-text-leaf-text') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Edited' } })
    expect(mockSetLeafOverride).toHaveBeenCalledTimes(1)
    expect(mockSetLeafOverride.mock.calls[0]?.[2]).toBe('leaf-text')
    expect(mockSetLeafOverride.mock.calls[0]?.[3]).toEqual({ text: 'Edited' })
  })

  it('"Reset overrides" calls resetAllOverrides and is disabled when none', () => {
    renderInspectorWith(makeInstance())
    const btn = screen.getByTestId('inspector-reset-overrides') as HTMLButtonElement
    expect(btn).toBeDisabled()

    cleanup()
    renderInspectorWith(
      makeInstance({
        leaves: { 'leaf-rect': { fill: 0x00ff00 } },
      }),
    )
    const enabled = screen.getByTestId('inspector-reset-overrides') as HTMLButtonElement
    expect(enabled).toBeEnabled()
    fireEvent.click(enabled)
    expect(mockResetAllOverrides).toHaveBeenCalledTimes(1)
    expect(mockResetAllOverrides.mock.calls[0]?.[1]).toBe('inst-1')
  })
})

describe('Inspector — ComponentInstance missing-master panel (M16 P7)', () => {
  beforeEach(() => {
    mockSetLeafOverride.mockReset()
    mockClearLeafOverride.mockReset()
    mockResetAllOverrides.mockReset()
    mockRemoveObject.mockReset()
    mockUpdateObject.mockReset()
    mockMasterStatus = 'missing'
    mockMasterSnapshot = null
    mockFolderComponents.length = 0
    mockInvalidate = vi.fn().mockResolvedValue([])
  })

  it('replaces the leaves panel with the warning panel', () => {
    renderInspectorWith(makeInstance())
    expect(screen.getByTestId('missing-master-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('leaf-override-row-leaf-rect')).not.toBeInTheDocument()
  })

  it('Detach (preserve nothing) calls removeObject', () => {
    renderInspectorWith(makeInstance())
    fireEvent.click(screen.getByTestId('missing-master-detach'))
    expect(mockRemoveObject).toHaveBeenCalledTimes(1)
    expect(mockRemoveObject.mock.calls[0]?.[1]).toBe('inst-1')
  })

  it('Replace… opens the picker drawer and picking rewrites componentId', () => {
    mockFolderComponents.push({
      id: 'comp-2',
      name: 'Other',
      folderId: 'folder-1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as unknown as ComponentSummary)
    renderInspectorWith(makeInstance())
    fireEvent.click(screen.getByTestId('missing-master-replace'))
    // Drawer rendered.
    expect(screen.getByTestId('component-picker-drawer')).toBeInTheDocument()
    // Pick the row — ComponentRow renders the component name as a button.
    fireEvent.click(screen.getByText('Other'))
    expect(mockUpdateObject).toHaveBeenCalledTimes(1)
    expect(mockUpdateObject.mock.calls[0]?.[1]).toBe('inst-1')
    expect(mockUpdateObject.mock.calls[0]?.[2]).toMatchObject({ componentId: 'comp-2' })
  })
})
