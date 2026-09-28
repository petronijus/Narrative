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
      <SlideDocContext value={ctxValue}>
        <ActiveSlideContext value={createMockActiveSlide()}>
          <SelectionProvider>
            <SelectionSetup ids={objects.map((o) => o.id)} />
            <Inspector />
          </SelectionProvider>
        </ActiveSlideContext>
      </SlideDocContext>
    </MemoryRouter>,
    { providers: { router: false, slideDoc: false, selection: false } },
  )
}

// ---------------------------------------------------------------------------
// Tests — Token tab in fill picker
// ---------------------------------------------------------------------------

// The dedicated "Token" tab in the fill picker was retired during the
// M16-P8 token-integration work. Tokens are now surfaced as swatches
// inside the colour picker popover (see Inspector.tsx ~3672, the
// `tokenColors={...}` prop on TokenColorInput) — no separate dropdown
// option, no aria-label='Apply token: <name>' button, no empty-state
// string. The four tests that used to live here asserted the old UX
// and are gone.
//
// Behaviour replacement:
//   - TokenRef payload writes through onTokenSelect: covered by the
//     CRDT-mutation unit tests in slide-model/src/tokens.test.ts
//   - Click-swatch-then-verify-Y.Doc-patch flow: candidate for an
//     end-to-end spec extension to apps/web/e2e/inspector-flows.spec.ts
//     once the popover-driven UI has stabilised.

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
})
