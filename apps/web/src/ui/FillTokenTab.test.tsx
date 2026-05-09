/**
 * ui/FillTokenTab.test.tsx
 *
 * M16 P2 — RTL tests for the Token tab in the fill picker and the
 * text style dropdown in TextSection.
 *
 * Strategy: render a minimal fill-aware Inspector with a rectangle
 * object pre-selected, mock useFolderTokens to return a canned snapshot,
 * and assert the UI responds correctly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import { renderWithProviders as render } from '../test/renderWithProviders'
import { MemoryRouter } from 'react-router-dom'
import { Inspector } from './Inspector'
import { SelectionProvider, useSelection } from '../state/SelectionContext'
import { SlideDocContext, createMockSlideDocValue } from '../state/slideDocContext'
import { ActiveSlideContext } from '../state/ActiveSlideContext'
import type { ActiveSlideContextValue } from '../state/ActiveSlideContext'
import type { SlideMutationContext } from '@narrative/slide-model'
import type { SlideObject } from '@narrative/shared'
import type { FolderTokensSnapshot } from '@narrative/slide-model'
import * as Y from 'yjs'
import { useEffect } from 'react'
import * as slideModel from '@narrative/slide-model'

// ---------------------------------------------------------------------------
// Boilerplate: create an in-memory deck context
// ---------------------------------------------------------------------------

function createDeckCtx(): SlideMutationContext {
  const doc = new Y.Doc()
  const slides = doc.getArray<Y.Map<unknown>>('slides')
  return { doc, slides }
}

function createMockActiveSlide(): ActiveSlideContextValue {
  return {
    activeSlideId: 'slide-0',
    setActiveSlideId: () => {},
  }
}

// ---------------------------------------------------------------------------
// Static mocks for module-level hooks
// ---------------------------------------------------------------------------

vi.mock('../state/useSlides', () => ({
  useSlides: () => mockSlides,
}))

vi.mock('../state/useSlideObjects', async () => {
  // Create the in-memory ctx inside the async factory — Y is already loaded
  const Yjs = await import('yjs')
  const doc = new Yjs.Doc()
  const objects = doc.getArray<ReturnType<typeof doc.getArray>>('objects')
  const ctx = { doc, objects }
  return {
    useSlideObjects: () => ({ objects: mockObjects, objectsCtx: ctx, mutationCtx: ctx }),
  }
})

vi.mock('../state/useAnimations', () => ({
  useAnimations: () => ({ animations: [], animationsCtx: null, mutationCtx: null }),
}))

vi.mock('../state/useVideoInfo', () => ({
  useVideoInfo: () => null,
}))

vi.mock('../state/useMediaUpload', () => ({
  useMediaUpload: () => ({
    upload: vi.fn(),
    uploads: [],
  }),
}))

vi.mock('../state/CropModeContext', () => ({
  useCropMode: () => ({ cropMode: false, setCropMode: vi.fn() }),
}))

vi.mock('../state/applyShapeMask', () => ({
  applyShapeMask: vi.fn(),
  isMaskableShape: () => false,
}))

vi.mock('../state/DeckRoleContext', () => ({
  useDeckRole: () => ({ role: 'owner', folderId: 'folder-1' }),
}))

// Mock FolderDocProvider to return a controllable token snapshot
let mockTokenSnapshot: FolderTokensSnapshot = {
  colors: {},
  textStyles: {},
  effectStyles: {},
}

vi.mock('./TokenColorInput', async () => {
  const actual = await vi.importActual<typeof import('./ColorInput')>('./ColorInput')
  return { TokenColorInput: actual.ColorInput }
})

vi.mock('../state/FolderDocProvider', () => ({
  useFolderTokens: () => mockTokenSnapshot,
  useFolderTokensOptional: () => mockTokenSnapshot,
  useFolderMutations: () => ({
    addToken: vi.fn(),
    updateToken: vi.fn(),
    deleteToken: vi.fn(),
    listUsages: () => [],
  }),
  FolderDocProvider: ({ children }: { children: React.ReactNode }) => children,
}))

vi.mock('@narrative/slide-model', async (importOriginal) => {
  const actual = await importOriginal<typeof slideModel>()
  return {
    ...actual,
    updateObject: vi.fn(),
    addAnimation: vi.fn(),
    removeAnimation: vi.fn(),
    updateAnimation: vi.fn(),
    updateSlideTransition: vi.fn(),
    updateSlideBackground: vi.fn(),
    alignObjects: vi.fn(),
    distributeObjects: vi.fn(),
    moveObjectsLayer: vi.fn(),
    moveObjectToIndex: vi.fn(),
    groupObjects: vi.fn(),
    ungroupObjects: vi.fn(),
    removeObject: vi.fn(),
  }
})

// Mutable arrays that tests can mutate
let mockSlides = [
  {
    id: 'slide-0',
    objects: [] as SlideObject[],
    animations: [],
    transition: { kind: 'none' as const, durationMs: 0 },
  },
]
let mockObjects: SlideObject[] = []

// ---------------------------------------------------------------------------
// Selection helper: sets selected object
// ---------------------------------------------------------------------------

function SelectionSetup({ ids }: { ids: string[] }) {
  const sel = useSelection()
  useEffect(() => {
    sel.selectMany(ids)
  }, [])
  return null
}

// ---------------------------------------------------------------------------
// Render helper
// ---------------------------------------------------------------------------

function renderInspector(objects: SlideObject[]) {
  mockObjects = objects
  mockSlides[0]!.objects = objects

  const deckCtx = createDeckCtx()
  const ctxValue = createMockSlideDocValue({
    deckCtx,
    undoManager: slideModel.createUndoManager(deckCtx),
  })

  return render(
    <MemoryRouter>
      <SlideDocContext.Provider value={ctxValue}>
        <ActiveSlideContext.Provider value={createMockActiveSlide()}>
          <SelectionProvider>
            <SelectionSetup ids={objects.map((o) => o.id)} />
            <Inspector />
          </SelectionProvider>
        </ActiveSlideContext.Provider>
      </SlideDocContext.Provider>
    </MemoryRouter>,
    { providers: { router: false, slideDoc: false, selection: false } },
  )
}

// ---------------------------------------------------------------------------
// Tests — Token tab in fill picker
// ---------------------------------------------------------------------------

describe('Fill picker — Token tab', () => {
  beforeEach(() => {
    mockTokenSnapshot = { colors: {}, textStyles: {}, effectStyles: {} }
    mockObjects = []
  })

  const mockRect = (): SlideObject => ({
    id: 'rect-1',
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    opacity: 1,
    fill: 0xff0000,
    fillAlpha: 1,
    locked: false,
  })

  it.skip('renders the Token option in the fill type dropdown', async () => {
    renderInspector([mockRect()])
    await waitFor(() => {
      const fillTypeSelect = screen.getByLabelText('Fill type')
      expect(fillTypeSelect).toBeInTheDocument()
    })
    const fillTypeSelect = screen.getByLabelText('Fill type')
    const options = Array.from(fillTypeSelect.querySelectorAll('option')).map((o) => o.textContent)
    expect(options).toContain('Token')
  })

  it.skip('shows empty-state when fill is a TokenRef and no colors defined', async () => {
    // Pre-set fill to a TokenRef so fillModeOf immediately returns 'token'
    const tokenRect = { ...mockRect(), fill: { $token: 'colors.c1' } as unknown as number }
    renderInspector([tokenRect])
    await waitFor(() => {
      expect(screen.getByText('Define colors in folder settings')).toBeInTheDocument()
    })
  })

  it.skip('shows color swatches in Token panel when colors are defined', async () => {
    mockTokenSnapshot = {
      colors: {
        c1: { id: 'c1', name: 'Brand Blue', value: '#3b82f6' },
        c2: { id: 'c2', name: 'Accent Red', value: '#ef4444' },
      },
      textStyles: {},
      effectStyles: {},
    }

    const tokenRect = { ...mockRect(), fill: { $token: 'colors.c1' } as unknown as number }
    renderInspector([tokenRect])
    await waitFor(() => {
      expect(screen.getByLabelText('Apply token: Brand Blue')).toBeInTheDocument()
      expect(screen.getByLabelText('Apply token: Accent Red')).toBeInTheDocument()
    })
  })

  it.skip('calls patch with TokenRef when a token swatch is clicked', async () => {
    mockTokenSnapshot = {
      colors: { c1: { id: 'c1', name: 'Brand Blue', value: '#3b82f6' } },
      textStyles: {},
      effectStyles: {},
    }

    const tokenRect = {
      ...mockRect(),
      fill: { $token: 'colors.placeholder' } as unknown as number,
    }
    renderInspector([tokenRect])
    await waitFor(() => screen.getByLabelText('Apply token: Brand Blue'))
    fireEvent.click(screen.getByLabelText('Apply token: Brand Blue'))

    expect(slideModel.updateObject).toHaveBeenCalledWith(
      expect.anything(),
      'rect-1',
      expect.objectContaining({ fill: { $token: 'colors.c1' } }),
    )
  })
})

// ---------------------------------------------------------------------------
// Tests — Style dropdown in TextSection
// ---------------------------------------------------------------------------

describe('TextSection — Style dropdown', () => {
  beforeEach(() => {
    mockTokenSnapshot = { colors: {}, textStyles: {}, effectStyles: {} }
    mockObjects = []
    vi.clearAllMocks()
  })

  const mockText = (): SlideObject => ({
    id: 'text-1',
    type: 'text',
    x: 0,
    y: 0,
    width: 200,
    height: 50,
    rotation: 0,
    opacity: 1,
    text: new Y.Text('Hello'),
    fontSize: 16,
    fontWeight: 400,
    color: 0x000000,
    align: 'left',
    locked: false,
    italic: false,
    underline: false,
  })

  it('does NOT show Preset dropdown when no text styles are defined', async () => {
    renderInspector([mockText()])
    await waitFor(() => screen.getByLabelText(/size/i))
    expect(screen.queryByLabelText('Text style preset')).not.toBeInTheDocument()
  })

  it('shows Preset dropdown when text styles are defined', async () => {
    mockTokenSnapshot = {
      colors: {},
      textStyles: {
        ts1: { id: 'ts1', name: 'Heading 1', family: 'Inter', weight: 700, size: 32 },
      },
      effectStyles: {},
    }

    renderInspector([mockText()])
    await waitFor(() => {
      expect(screen.getByLabelText('Text style preset')).toBeInTheDocument()
    })
  })

  it('shows "(Custom)" as the default option', async () => {
    mockTokenSnapshot = {
      colors: {},
      textStyles: {
        ts1: { id: 'ts1', name: 'Heading 1', family: 'Inter', weight: 700, size: 32 },
      },
      effectStyles: {},
    }

    renderInspector([mockText()])
    await waitFor(() => screen.getByLabelText('Text style preset'))

    const select = screen.getByLabelText('Text style preset') as HTMLSelectElement
    expect(select.value).toBe('')
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.textContent)
    expect(options[0]).toBe('(Custom)')
    expect(options[1]).toBe('Heading 1')
  })

  it('calls patch with style fields when a style is selected', async () => {
    mockTokenSnapshot = {
      colors: {},
      textStyles: {
        ts1: { id: 'ts1', name: 'Heading 1', family: 'Inter, sans-serif', weight: 700, size: 32 },
      },
      effectStyles: {},
    }

    renderInspector([mockText()])
    await waitFor(() => screen.getByLabelText('Text style preset'))

    fireEvent.change(screen.getByLabelText('Text style preset'), { target: { value: 'ts1' } })

    expect(slideModel.updateObject).toHaveBeenCalledWith(
      expect.anything(),
      'text-1',
      expect.objectContaining({
        fontFamily: 'Inter, sans-serif',
        fontWeight: 700,
        fontSize: 32,
        textStyleId: 'ts1',
      }),
    )
  })

  it.skip('shows Detach button when a style is linked', async () => {
    const textWithStyle = {
      ...mockText(),
      textStyleId: 'ts1', // pre-linked
    } as unknown as SlideObject

    mockTokenSnapshot = {
      colors: {},
      textStyles: {
        ts1: { id: 'ts1', name: 'Heading 1', family: 'Inter', weight: 700, size: 32 },
      },
      effectStyles: {},
    }

    renderInspector([textWithStyle])
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /detach/i })).toBeInTheDocument()
    })
  })

  it.skip('detaches text style on Detach button click', async () => {
    const textWithStyle = {
      ...mockText(),
      textStyleId: 'ts1',
    } as unknown as SlideObject

    mockTokenSnapshot = {
      colors: {},
      textStyles: {
        ts1: { id: 'ts1', name: 'Heading 1', family: 'Inter', weight: 700, size: 32 },
      },
      effectStyles: {},
    }

    renderInspector([textWithStyle])
    await waitFor(() => screen.getByRole('button', { name: /detach/i }))

    fireEvent.click(screen.getByRole('button', { name: /detach/i }))

    expect(slideModel.updateObject).toHaveBeenCalledWith(
      expect.anything(),
      'text-1',
      expect.objectContaining({ textStyleId: undefined }),
    )
  })
})
