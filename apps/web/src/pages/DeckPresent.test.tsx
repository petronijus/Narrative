/**
 * DeckPresent.test.tsx
 *
 * M5: Smoke testy pro DeckPresent page component.
 * - Renderuje PresentLayout
 * - Předpokládá SlideDocContext výše ve stromu (jako DeckShell poskytuje)
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import type * as ReactRouterDom from 'react-router-dom'
import { DeckPresent } from './DeckPresent'
import { SlideDocContext, createMockSlideDocValue } from '../state/slideDocContext'
import type { SlideDocContextValue } from '../state/slideDocContext'
import { ActiveSlideContext } from '../state/ActiveSlideContext'
import * as Y from 'yjs'
import type { SlideMutationContext } from '@narrative/slide-model'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// ResizeObserver není v jsdom
class ResizeObserverMock {
  private callback: ResizeObserverCallback

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
  }

  observe(target: Element) {
    const entry = {
      contentRect: { width: 1280, height: 720 } as DOMRectReadOnly,
      target,
      borderBoxSize: [],
      contentBoxSize: [],
      devicePixelContentBoxSize: [],
    } as ResizeObserverEntry
    this.callback([entry], this as unknown as ResizeObserver)
  }

  unobserve() {}
  disconnect() {}
}

vi.stubGlobal('ResizeObserver', ResizeObserverMock)

vi.mock('../renderer/Canvas', () => ({
  Canvas: () => <div data-testid="canvas-mock" />,
}))

vi.mock('../state/useSlideObjectChanges', () => ({
  useSlideObjectChanges: () => undefined,
}))

vi.mock('../state/useAnimations', () => ({
  useAnimations: () => ({
    animations: [],
    animationsCtx: {
      doc: new Y.Doc(),
      animations: new Y.Doc().getArray('animations'),
    },
    mutationCtx: {
      doc: new Y.Doc(),
      animations: new Y.Doc().getArray('animations'),
    },
  }),
}))

// M9: useSlides mock — PresentLayout now reads slides for counter + navigation
vi.mock('../state/useSlides', () => ({
  useSlides: () => [],
}))

vi.mock('@narrative/animation', () => ({
  createAnimationRuntime: vi.fn(() => ({ play: vi.fn(), destroy: vi.fn() })),
  createClickInputBridge: vi.fn(() => ({ onAdvance: vi.fn() })),
}))

vi.mock('../animation/targetResolver', () => ({
  createPixiTargetResolver: vi.fn(() => ({ resolve: vi.fn() })),
}))

const mockNavigate = vi.fn()
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactRouterDom>()
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDeckCtx(): SlideMutationContext {
  const doc = new Y.Doc()
  const slides = doc.getArray<Y.Map<unknown>>('slides')
  return { doc, slides }
}

function createSlideDocValue(): SlideDocContextValue {
  const deckCtx = createDeckCtx()
  return createMockSlideDocValue({ deckCtx })
}

function renderDeckPresent(deckId = 'deck-123') {
  const ctxValue = createSlideDocValue()
  const mockActiveSlide = { activeSlideId: null, setActiveSlideId: vi.fn() }

  return render(
    <SlideDocContext.Provider value={ctxValue}>
      <ActiveSlideContext.Provider value={mockActiveSlide}>
        <MemoryRouter initialEntries={[`/deck/${deckId}/present`]}>
          <Routes>
            <Route path="/deck/:id/present" element={<DeckPresent />} />
          </Routes>
        </MemoryRouter>
      </ActiveSlideContext.Provider>
    </SlideDocContext.Provider>,
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DeckPresent', () => {
  it('renderuje PresentLayout (slide-container existuje)', () => {
    renderDeckPresent()
    expect(screen.getByTestId('slide-container')).toBeInTheDocument()
  })

  it('renderuje canvas', () => {
    renderDeckPresent()
    expect(screen.getByTestId('canvas-mock')).toBeInTheDocument()
  })

  it('má role="application"', () => {
    renderDeckPresent()
    expect(screen.getByRole('application')).toBeInTheDocument()
  })

  it('nerenderuje toolbar', () => {
    renderDeckPresent()
    expect(screen.queryByRole('toolbar')).toBeNull()
  })
})
