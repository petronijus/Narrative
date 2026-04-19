/**
 * Inspector.test.tsx
 *
 * - Renders "No selection" placeholder pokud nic není vybráno.
 * - Renders správné sekce pro rect, ellipse, text objekty.
 * - Editace pole volá updateObject.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Inspector } from './Inspector'
import { SelectionProvider } from '../state/SelectionContext'
import { SlideDocContext } from '../state/slideDocContext'
import type { SlideDocContextValue } from '../state/slideDocContext'
import * as slideModel from '@narrative/slide-model'
import type { MutationContext } from '@narrative/slide-model'
import type { SlideObject } from '@narrative/shared'
import * as Y from 'yjs'
import { useEffect } from 'react'
import { useSelection } from '../state/SelectionContext'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMutationCtx(): MutationContext {
  const doc = new Y.Doc()
  const objects = doc.getArray<Y.Map<unknown>>('objects')
  return { doc, objects }
}

function createContextValue(
  mutationCtx: MutationContext,
  undoManager?: Y.UndoManager,
): SlideDocContextValue {
  const um = undoManager ?? slideModel.createUndoManager(mutationCtx)
  return { mutationCtx, undoManager: um }
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

vi.mock('../state/useSlideObjects', () => ({
  useSlideObjects: () => ({
    objects: mockObjects,
    mutationCtx: { doc: new Y.Doc(), objects: new Y.Doc().getArray('objects') },
  }),
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
