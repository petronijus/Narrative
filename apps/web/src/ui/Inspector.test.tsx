/**
 * Inspector.test.tsx
 *
 * - Renders "No selection" placeholder pokud nic není vybráno.
 * - Renders správné sekce pro rect, ellipse, text objekty.
 * - Editace pole volá updateObject.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMutationCtx(): SlideMutationContext {
  const doc = new Y.Doc()
  const objects = doc.getArray<Y.Map<unknown>>('objects')
  const animations = doc.getArray<Y.Map<unknown>>('animations')
  return { doc, objects, animations }
}

function createContextValue(
  mutationCtx: SlideMutationContext,
  undoManager?: Y.UndoManager,
): SlideDocContextValue {
  const um = undoManager ?? slideModel.createUndoManager(mutationCtx)
  return createMockSlideDocValue({ mutationCtx, undoManager: um })
}

// ---------------------------------------------------------------------------
// Mock useSlideObjects
// ---------------------------------------------------------------------------

// Vitest module mock musí být statický — proto použijeme přímý approach:
// místo mockování hooku předáme objekty přes context a testujeme přímo komponentu

describe('Inspector', () => {
  it('renders No selection placeholder when nothing is selected', () => {
    const mutationCtx = createMutationCtx()
    const ctxValue = createContextValue(mutationCtx)

    render(
      <SlideDocContext.Provider value={ctxValue}>
        <SelectionProvider>
          <Inspector />
        </SelectionProvider>
      </SlideDocContext.Provider>,
    )

    expect(screen.getByText('No selection')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Tests s mockovaným useSlideObjects — mock musí být na top level
// ---------------------------------------------------------------------------

const mockObjects: SlideObject[] = []
let mockUpdateObject = vi.fn()
let mockAddAnimation = vi.fn()
let mockRemoveAnimation = vi.fn()

// Mock animations state — sdílený přes useAnimations mock
const mockAnimations: AnimationStep[] = []

vi.mock('../state/useSlideObjects', () => ({
  useSlideObjects: () => ({
    objects: mockObjects,
    mutationCtx: { doc: new Y.Doc(), objects: new Y.Doc().getArray('objects') },
  }),
}))

vi.mock('../state/useAnimations', () => ({
  useAnimations: () => ({
    animations: mockAnimations,
    mutationCtx: {
      doc: new Y.Doc(),
      objects: new Y.Doc().getArray('objects'),
      animations: new Y.Doc().getArray('animations'),
    },
  }),
}))

vi.mock('@narrative/slide-model', async (importOriginal) => {
  const actual = await importOriginal<typeof slideModel>()
  return {
    ...actual,
    updateObject: (...args: Parameters<typeof actual.updateObject>) => {
      mockUpdateObject(...args)
    },
    addAnimation: (...args: Parameters<typeof actual.addAnimation>) => {
      mockAddAnimation(...args)
    },
    removeAnimation: (...args: Parameters<typeof actual.removeAnimation>) => {
      mockRemoveAnimation(...args)
    },
  }
})

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

  const mutationCtx = createMutationCtx()
  const ctxValue = createContextValue(mutationCtx)

  function Inner() {
    const { setSelectedId } = useSelection()
    useEffect(() => {
      setSelectedId(obj.id)
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
    return <Inspector />
  }

  return render(
    <SlideDocContext.Provider value={ctxValue}>
      <SelectionProvider>
        <Inner />
      </SelectionProvider>
    </SlideDocContext.Provider>,
  )
}

describe('Inspector — rectangle', () => {
  beforeEach(() => {
    mockUpdateObject = vi.fn()
  })

  it('shows Position, Size, Transform, Appearance sections', () => {
    renderWithSelection(RECT_OBJ)
    expect(screen.getByText('Position')).toBeInTheDocument()
    expect(screen.getByText('Size')).toBeInTheDocument()
    expect(screen.getByText('Transform')).toBeInTheDocument()
    expect(screen.getByText('Appearance')).toBeInTheDocument()
  })

  it('does not show Text section for rectangle', () => {
    renderWithSelection(RECT_OBJ)
    expect(screen.queryByText('Text')).not.toBeInTheDocument()
    expect(screen.queryByText('Typography')).not.toBeInTheDocument()
  })

  it('shows Fill color input for rectangle', () => {
    renderWithSelection(RECT_OBJ)
    expect(screen.getByLabelText('Fill')).toBeInTheDocument()
  })

  it('shows correct X/Y values', () => {
    renderWithSelection(RECT_OBJ)
    const xInput = screen.getByLabelText('X')
    const yInput = screen.getByLabelText('Y')
    expect((xInput as HTMLInputElement).value).toBe('10')
    expect((yInput as HTMLInputElement).value).toBe('20')
  })
})

describe('Inspector — ellipse', () => {
  it('shows Appearance section with Fill for ellipse', () => {
    renderWithSelection(ELLIPSE_OBJ)
    expect(screen.getByText('Appearance')).toBeInTheDocument()
    expect(screen.getByLabelText('Fill')).toBeInTheDocument()
    expect(screen.queryByText('Text')).not.toBeInTheDocument()
  })
})

describe('Inspector — text', () => {
  it('shows Text and Typography sections for text object', () => {
    renderWithSelection(TEXT_OBJ)
    expect(screen.getByText('Text')).toBeInTheDocument()
    expect(screen.getByText('Typography')).toBeInTheDocument()
  })

  it('does not show Appearance section for text', () => {
    renderWithSelection(TEXT_OBJ)
    expect(screen.queryByText('Appearance')).not.toBeInTheDocument()
  })

  it('shows Font weight and Align selects', () => {
    renderWithSelection(TEXT_OBJ)
    expect(screen.getByLabelText('Weight')).toBeInTheDocument()
    expect(screen.getByLabelText('Align')).toBeInTheDocument()
  })

  it('shows Color inputs for text', () => {
    renderWithSelection(TEXT_OBJ)
    expect(screen.getByLabelText('Color')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Animations section tests
// ---------------------------------------------------------------------------

describe('Inspector — Animations section', () => {
  beforeEach(() => {
    mockAddAnimation = vi.fn()
    mockRemoveAnimation = vi.fn()
    // Reset animations mock array
    mockAnimations.length = 0
  })

  it('zobrazí Animations sekci pro vybraný objekt', () => {
    renderWithSelection(RECT_OBJ)
    expect(screen.getByText('Animations')).toBeInTheDocument()
  })

  it('zobrazí "No animations" pokud objekt nemá žádné animace', () => {
    renderWithSelection(RECT_OBJ)
    expect(screen.getByText('No animations')).toBeInTheDocument()
  })

  it('klik na "+ fadeIn" volá addAnimation s fadeIn preset', () => {
    renderWithSelection(RECT_OBJ)
    const btn = screen.getByLabelText('Add fadeIn animation')
    fireEvent.click(btn)
    expect(mockAddAnimation).toHaveBeenCalledOnce()
    expect(mockAddAnimation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        objectId: RECT_OBJ.id,
        preset: 'fadeIn',
      }),
    )
  })

  it('klik na "+ slideIn up" volá addAnimation s slideIn + direction up', () => {
    renderWithSelection(RECT_OBJ)
    const btn = screen.getByLabelText('Add slideIn up animation')
    fireEvent.click(btn)
    expect(mockAddAnimation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        objectId: RECT_OBJ.id,
        preset: 'slideIn',
        params: { direction: 'up' },
      }),
    )
  })

  it('všech 5 add tlačítek je přítomno v DOM', () => {
    renderWithSelection(RECT_OBJ)
    expect(screen.getByLabelText('Add fadeIn animation')).toBeInTheDocument()
    expect(screen.getByLabelText('Add slideIn up animation')).toBeInTheDocument()
    expect(screen.getByLabelText('Add slideIn down animation')).toBeInTheDocument()
    expect(screen.getByLabelText('Add slideIn left animation')).toBeInTheDocument()
    expect(screen.getByLabelText('Add slideIn right animation')).toBeInTheDocument()
  })

  it('zobrazí existující animace patřící objektu', () => {
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

  it('klik na delete ikonku volá removeAnimation se správným id', () => {
    mockAnimations.push({
      id: 'anim-delete-me',
      objectId: RECT_OBJ.id,
      preset: 'fadeIn',
      trigger: 'onEnter',
      duration: 0.6,
      delay: 0,
      easing: 'power2.out',
    })

    renderWithSelection(RECT_OBJ)
    const deleteBtn = screen.getByLabelText('Remove fadeIn animation')
    fireEvent.click(deleteBtn)

    expect(mockRemoveAnimation).toHaveBeenCalledOnce()
    expect(mockRemoveAnimation).toHaveBeenCalledWith(expect.anything(), 'anim-delete-me')
  })
})

// ---------------------------------------------------------------------------
// Multi-select placeholder (M7)
// ---------------------------------------------------------------------------

describe('Inspector — multi-select placeholder', () => {
  it('zobrazí multi-select placeholder pro >1 selected', () => {
    mockObjects.length = 0
    mockObjects.push(RECT_OBJ, ELLIPSE_OBJ)

    const mutationCtx = createMutationCtx()
    const ctxValue = createContextValue(mutationCtx)

    function MultiSelectInner() {
      const { selectMany } = useSelection()
      useEffect(() => {
        selectMany([RECT_OBJ.id, ELLIPSE_OBJ.id])
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])
      return <Inspector />
    }

    render(
      <SlideDocContext.Provider value={ctxValue}>
        <SelectionProvider>
          <MultiSelectInner />
        </SelectionProvider>
      </SlideDocContext.Provider>,
    )

    expect(screen.getByText(/Multi-select/)).toBeInTheDocument()
    expect(screen.getByText(/2 objects selected/)).toBeInTheDocument()
    expect(screen.queryByText('Position')).not.toBeInTheDocument()
  })
})
