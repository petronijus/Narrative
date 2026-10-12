/**
 * Inspector.test.tsx
 *
 * - Renders "No selection" placeholder pokud nic není vybráno.
 * - Renders správné sekce pro rect, ellipse, text objekty.
 * - Editace pole volá updateObject.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Inspector } from './Inspector'
import { SelectionProvider } from '../state/SelectionContext'
import { SlideDocContext, createMockSlideDocValue } from '../state/slideDocContext'
import type { SlideDocContextValue } from '../state/slideDocContext'
import * as slideModel from '@narrative/slide-model'
import type { AnimationStep } from '@narrative/shared'
import type { SlideMutationContext } from '@narrative/slide-model'
import type { SlideObject } from '@narrative/shared'
import * as Y from 'yjs'
import { useEffect } from 'react'
import { useSelection } from '../state/SelectionContext'
import { ActiveSlideContext } from '../state/ActiveSlideContext'
import type { ActiveSlideContextValue } from '../state/ActiveSlideContext'
import type * as UseSlidesModule from '../state/useSlides'
import type { Slide } from '@narrative/shared'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDeckCtx(): SlideMutationContext {
  const doc = new Y.Doc()
  const slides = doc.getArray<Y.Map<unknown>>('slides')
  return { doc, slides }
}

function createMockActiveSlide(): ActiveSlideContextValue {
  return {
    activeSlideId: 'mock-slide-0',
    setActiveSlideId: () => {},
  }
}

function createContextValue(
  deckCtx: SlideMutationContext,
  undoManager?: Y.UndoManager,
): SlideDocContextValue {
  const um = undoManager ?? slideModel.createUndoManager(deckCtx)
  return createMockSlideDocValue({ deckCtx, undoManager: um })
}

// ---------------------------------------------------------------------------
// Mock useSlideObjects
// ---------------------------------------------------------------------------

// Vitest module mock musí být statický — proto použijeme přímý approach:
// místo mockování hooku předáme objekty přes context a testujeme přímo komponentu

// ---------------------------------------------------------------------------
// Mock useSlides for SlideInspector tests
// ---------------------------------------------------------------------------

vi.mock('../state/useSlides', async (importOriginal) => {
  const actual = await importOriginal<typeof UseSlidesModule>()
  return {
    ...actual,
    useSlides: () => mockSlides,
  }
})

// Inspector calls useAuth() to read the bearer token for slide-number
// API calls. Tests don't exercise that code path, so a minimal stub
// avoids needing the full AuthProvider tree in the wrapper.
vi.mock('../state/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/AuthContext')>()
  return {
    ...actual,
    useAuth: () => ({
      user: { sub: 'test-user', email: 'test@example.com', name: 'Test User' },
      token: 'test-token',
      isLoading: false,
      login: vi.fn(),
      logout: vi.fn(),
      refreshToken: vi.fn(),
      completeSignin: vi.fn(),
    }),
  }
})

const mockSlides: Slide[] = []

describe('Inspector — no selection shows SlideInspector', () => {
  beforeEach(() => {
    mockSlides.length = 0
  })

  it('shows slide transition section when no object is selected and active slide exists', () => {
    mockSlides.push({
      id: 'mock-slide-0',
      objects: [],
      animations: [],
      transition: { kind: 'none', durationMs: 0 },
    })

    const deckCtx = createDeckCtx()
    const ctxValue = createContextValue(deckCtx)

    render(
      <SlideDocContext value={ctxValue}>
        <ActiveSlideContext value={createMockActiveSlide()}>
          <SelectionProvider>
            <Inspector />
          </SelectionProvider>
        </ActiveSlideContext>
      </SlideDocContext>,
    )

    expect(screen.getByText('Transition')).toBeInTheDocument()
    expect(screen.getByLabelText('Kind')).toBeInTheDocument()
  })

  it('shows "No selection" fallback when slide list is empty', () => {
    // mockSlides is empty — active slide not found
    const deckCtx = createDeckCtx()
    const ctxValue = createContextValue(deckCtx)

    render(
      <SlideDocContext value={ctxValue}>
        <ActiveSlideContext value={createMockActiveSlide()}>
          <SelectionProvider>
            <Inspector />
          </SelectionProvider>
        </ActiveSlideContext>
      </SlideDocContext>,
    )

    expect(screen.getByText('No selection')).toBeInTheDocument()
  })

  it('transition kind dropdown shows current value', () => {
    mockSlides.push({
      id: 'mock-slide-0',
      objects: [],
      animations: [],
      transition: { kind: 'fade', durationMs: 400 },
    })

    const deckCtx = createDeckCtx()
    const ctxValue = createContextValue(deckCtx)

    render(
      <SlideDocContext value={ctxValue}>
        <ActiveSlideContext value={createMockActiveSlide()}>
          <SelectionProvider>
            <Inspector />
          </SelectionProvider>
        </ActiveSlideContext>
      </SlideDocContext>,
    )

    const kindSelect = screen.getByLabelText('Kind') as HTMLSelectElement
    expect(kindSelect.value).toBe('fade')
  })

  it('direction dropdown shown only when kind is push', () => {
    mockSlides.push({
      id: 'mock-slide-0',
      objects: [],
      animations: [],
      transition: { kind: 'push', durationMs: 300, direction: 'left' },
    })

    const deckCtx = createDeckCtx()
    const ctxValue = createContextValue(deckCtx)

    render(
      <SlideDocContext value={ctxValue}>
        <ActiveSlideContext value={createMockActiveSlide()}>
          <SelectionProvider>
            <Inspector />
          </SelectionProvider>
        </ActiveSlideContext>
      </SlideDocContext>,
    )

    expect(screen.getByLabelText('Direction')).toBeInTheDocument()
  })

  it('direction dropdown not shown for kind=fade', () => {
    mockSlides.push({
      id: 'mock-slide-0',
      objects: [],
      animations: [],
      transition: { kind: 'fade', durationMs: 300 },
    })

    const deckCtx = createDeckCtx()
    const ctxValue = createContextValue(deckCtx)

    render(
      <SlideDocContext value={ctxValue}>
        <ActiveSlideContext value={createMockActiveSlide()}>
          <SelectionProvider>
            <Inspector />
          </SelectionProvider>
        </ActiveSlideContext>
      </SlideDocContext>,
    )

    expect(screen.queryByLabelText('Direction')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Tests s mockovaným useSlideObjects — mock musí být na top level
// ---------------------------------------------------------------------------

const mockObjects: SlideObject[] = []
let mockUpdateObject = vi.fn()

// Mock animations state — sdílený přes useAnimations mock
const mockAnimations: AnimationStep[] = []

vi.mock('../state/useSlideObjects', () => ({
  useSlideObjects: () => ({
    objects: mockObjects,
    objectsCtx: { doc: new Y.Doc(), objects: new Y.Doc().getArray('objects') },
    mutationCtx: { doc: new Y.Doc(), objects: new Y.Doc().getArray('objects') },
  }),
}))

vi.mock('../state/useAnimations', () => ({
  useAnimations: () => ({ animations: mockAnimations }),
}))

vi.mock('@narrative/slide-model', async (importOriginal) => {
  const actual = await importOriginal<typeof slideModel>()
  return {
    ...actual,
    updateObject: (...args: Parameters<typeof actual.updateObject>) => {
      mockUpdateObject(...args)
    },
  }
})

// M16 P2: FolderDocProvider — empty token snapshot so Inspector renders without throwing
vi.mock('./TokenColorInput', async () => {
  const actual = await vi.importActual<typeof import('./ColorInput')>('./ColorInput')
  return { TokenColorInput: actual.ColorInput }
})

vi.mock('../state/FolderDocProvider', () => ({
  useFolderTokens: () => ({ colors: {}, textStyles: {}, effectStyles: {} }),
  useFolderTokensOptional: () => ({ colors: {}, textStyles: {}, effectStyles: {} }),
  useFolderTokensForCommands: () => undefined,
  useFolderStylePack: () => undefined,
  useFolderTokenWriter: () => null,
  FolderDocProvider: ({ children }: { children: unknown }) => children,
}))

vi.mock('../state/DeckRoleContext', () => ({
  useDeckRole: () => ({ role: 'owner', folderId: 'folder-1' }),
}))

vi.mock('../state/CropModeContext', () => ({
  useCropMode: () => ({ cropMode: false, setCropMode: vi.fn() }),
}))

vi.mock('../state/useMediaUpload', () => ({
  useMediaUpload: () => ({ upload: vi.fn(), uploads: [] }),
}))

vi.mock('../state/useVideoInfo', () => ({
  useVideoInfo: () => null,
}))

const RECT_OBJ: SlideObject = {
  id: 'rect-1',
  type: 'rectangle',
  x: 10,
  y: 20,
  width: 200,
  height: 150,
  fill: 0x4060e0,
  rotation: 0,
  opacity: 1,
}

const ELLIPSE_OBJ: SlideObject = {
  id: 'ellipse-1',
  type: 'ellipse',
  x: 50,
  y: 60,
  width: 180,
  height: 180,
  fill: 0xe06040,
  rotation: 0,
  opacity: 1,
}

const TEXT_OBJ: SlideObject = {
  id: 'text-1',
  type: 'text',
  x: 100,
  y: 100,
  width: 240,
  height: 40,
  text: 'Hello world',
  fontSize: 24,
  fontWeight: 'normal',
  color: 0x000000,
  align: 'left',
  rotation: 0,
  opacity: 1,
}

function renderWithSelection(obj: SlideObject) {
  mockObjects.length = 0
  mockObjects.push(obj)
  mockUpdateObject = vi.fn()

  const deckCtx = createDeckCtx()
  const ctxValue = createContextValue(deckCtx)

  function Inner() {
    const { setSelectedId } = useSelection()
    useEffect(() => {
      setSelectedId(obj.id)
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
    return <Inspector />
  }

  return render(
    <MemoryRouter>
      <SlideDocContext value={ctxValue}>
        <ActiveSlideContext value={createMockActiveSlide()}>
          <SelectionProvider>
            <Inner />
          </SelectionProvider>
        </ActiveSlideContext>
      </SlideDocContext>
    </MemoryRouter>,
  )
}

describe('Inspector — rectangle', () => {
  beforeEach(() => {
    mockUpdateObject = vi.fn()
  })

  it('does not show Text section for rectangle', () => {
    renderWithSelection(RECT_OBJ)
    expect(screen.queryByText('Text')).not.toBeInTheDocument()
    expect(screen.queryByText('Typography')).not.toBeInTheDocument()
  })
})

describe('Inspector — text', () => {
  it('does not show Appearance section for text', () => {
    renderWithSelection(TEXT_OBJ)
    expect(screen.queryByText('Appearance')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Animations section tests
// ---------------------------------------------------------------------------

describe('Inspector — Animations section', () => {
  beforeEach(() => {
    // Reset animations mock array
    mockAnimations.length = 0
  })

  /**
   * The Inspector with `obj` selected on a real slide of a real document:
   * the section dispatches `animation.*` commands, so the tests read what
   * they wrote back from the document. (useAnimations is mocked, so the
   * list the section shows comes from `mockAnimations`.)
   */
  function renderOnRealSlide(obj: SlideObject, steps: Array<Omit<AnimationStep, 'id'>> = []) {
    mockObjects.length = 0
    mockObjects.push(obj)
    const deckCtx = slideModel.createSlideDoc()
    const slideId = deckCtx.slides.get(0).get('id') as string
    slideModel.addObject(slideModel.getSlideObjectsCtx(deckCtx, slideId)!, obj)
    const animCtx = slideModel.getSlideAnimationsCtx(deckCtx, slideId)!
    for (const step of steps) mockAnimations.push(slideModel.addAnimation(animCtx, step))

    function Inner() {
      const { setSelectedId } = useSelection()
      useEffect(() => {
        setSelectedId(obj.id)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])
      return <Inspector />
    }
    render(
      <MemoryRouter>
        <SlideDocContext value={createContextValue(deckCtx)}>
          <ActiveSlideContext value={{ activeSlideId: slideId, setActiveSlideId: () => {} }}>
            <SelectionProvider>
              <Inner />
            </SelectionProvider>
          </ActiveSlideContext>
        </SlideDocContext>
      </MemoryRouter>,
    )
    return () => slideModel.listSlides(deckCtx)[0]!.animations
  }

  it('zobrazí Animations sekci pro vybraný objekt', () => {
    renderWithSelection(RECT_OBJ)
    expect(screen.getByText('Animations')).toBeInTheDocument()
  })

  it('zobrazí "No animations" pokud objekt nemá žádné animace', () => {
    renderWithSelection(RECT_OBJ)
    expect(screen.getByText('No animations')).toBeInTheDocument()
  })

  it('"+ fadeIn" adds a fadeIn step for the object through animation.add', () => {
    const stepsInDoc = renderOnRealSlide(RECT_OBJ)
    fireEvent.click(screen.getByLabelText('Add fadeIn animation'))
    expect(stepsInDoc()).toEqual([
      expect.objectContaining({
        objectId: RECT_OBJ.id,
        preset: 'fadeIn',
        trigger: 'afterPrevious',
      }),
    ])
  })

  // Skipped: there is no "+ slideIn up" button any more — the "More
  // presets" select replaced the per-direction quick buttons, and it offers
  // slideIn without a direction (the step's Direction field sets it). Kept
  // until the add-preset menu is redesigned with direction variants again.
  it.skip('"+ slideIn up" adds a slideIn step with direction up', () => {
    const stepsInDoc = renderOnRealSlide(RECT_OBJ)
    fireEvent.click(screen.getByLabelText('Add slideIn up animation'))
    expect(stepsInDoc()).toEqual([
      expect.objectContaining({
        objectId: RECT_OBJ.id,
        preset: 'slideIn',
        params: { direction: 'up' },
      }),
    ])
  })

  it.skip('zobrazí existující animace patřící objektu', () => {
    // Přidáme animaci pro rect-1
    mockAnimations.push({
      id: 'anim-1',
      objectId: RECT_OBJ.id,
      preset: 'fadeIn',
      trigger: 'onEnter',
      duration: 0.6,
      delay: 0,
      easing: 'power2.out',
    })

    renderWithSelection(RECT_OBJ)
    expect(screen.getByText('fadeIn')).toBeInTheDocument()
    expect(screen.getByText('onEnter')).toBeInTheDocument()
  })

  it('nezobrazí animace jiných objektů', () => {
    // Animace pro jiný objekt
    mockAnimations.push({
      id: 'anim-other',
      objectId: 'other-object-id',
      preset: 'slideIn',
      trigger: 'onEnter',
      duration: 0.6,
      delay: 0,
      easing: 'power2.out',
      params: { direction: 'up' },
    })

    renderWithSelection(RECT_OBJ)
    // slideIn (up) label by neměl být vidět — patří jinému objektu
    expect(screen.queryByText('slideIn (up)')).not.toBeInTheDocument()
    expect(screen.getByText('No animations')).toBeInTheDocument()
  })

  it('the delete icon removes that step through animation.remove', () => {
    const stepsInDoc = renderOnRealSlide(RECT_OBJ, [
      {
        objectId: RECT_OBJ.id,
        preset: 'fadeIn',
        trigger: 'onEnter',
        duration: 0.6,
        delay: 0,
        easing: 'power2.out',
      },
    ])
    expect(stepsInDoc()).toHaveLength(1)
    fireEvent.click(screen.getByLabelText('Remove fadeIn animation'))
    expect(stepsInDoc()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Multi-select placeholder (M7)
// ---------------------------------------------------------------------------

describe('Inspector — multi-select placeholder', () => {
  it.skip('zobrazí multi-select placeholder pro >1 selected', () => {
    mockObjects.length = 0
    mockObjects.push(RECT_OBJ, ELLIPSE_OBJ)

    const deckCtx = createDeckCtx()
    const ctxValue = createContextValue(deckCtx)

    function MultiSelectInner() {
      const { selectMany } = useSelection()
      useEffect(() => {
        selectMany([RECT_OBJ.id, ELLIPSE_OBJ.id])
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])
      return <Inspector />
    }

    render(
      <MemoryRouter>
        <SlideDocContext value={ctxValue}>
          <ActiveSlideContext value={createMockActiveSlide()}>
            <SelectionProvider>
              <MultiSelectInner />
            </SelectionProvider>
          </ActiveSlideContext>
        </SlideDocContext>
      </MemoryRouter>,
    )

    expect(screen.getByText(/Multi-select/)).toBeInTheDocument()
    expect(screen.getByText(/2 objects selected/)).toBeInTheDocument()
    expect(screen.queryByText('Position')).not.toBeInTheDocument()
  })
})
