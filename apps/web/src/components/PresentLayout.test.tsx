/**
 * PresentLayout.test.tsx
 *
 * M5: present mode layout tests.
 * M9: slide navigation (ArrowRight/Left/Space/PageUp/PageDown), slide counter.
 *
 * Tests:
 * - Layout: fullscreen layout renders correctly (no toolbar/inspector/sidebar)
 * - Keyboard: Escape → navigate, navigation keys advance/retreat active slide
 * - Arrow Left at first slide is no-op
 * - Counter shows correct "X / N"
 * - Fullscreen API integration
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, act } from '@testing-library/react'
import { renderWithProviders as render } from '../test/renderWithProviders'
import { fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import type * as ReactRouterDom from 'react-router-dom'
import { PresentLayout } from './PresentLayout'
import { SlideDocContext, createMockSlideDocValue } from '../state/slideDocContext'
import type { SlideDocContextValue } from '../state/slideDocContext'
import { CanvasInstanceContext } from '../renderer/CanvasInstanceContext'
import type { CanvasInstance } from '../renderer/CanvasInstanceContext'
import { ActiveSlideContext } from '../state/ActiveSlideContext'
import type { ActiveSlideContextValue } from '../state/ActiveSlideContext'
import * as Y from 'yjs'
import type { SlideMutationContext } from '@narrative/slide-model'
import type { Slide } from '@narrative/shared'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// ResizeObserver — polyfill for jsdom
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

// Canvas is a heavy Pixi dependency — mock it
vi.mock('../renderer/Canvas', () => ({
  Canvas: () => <div data-testid="canvas-mock" />,
}))

vi.mock('../state/useSlideObjectChanges', () => ({
  useSlideObjectChanges: () => undefined,
}))

// VideoOverlay also depends on api client; mock out to avoid AuthContext touch.
vi.mock('../ui/VideoOverlay', () => ({
  VideoOverlay: () => null,
}))

// navigate mock
const mockNavigate = vi.fn()
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactRouterDom>()
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  }
})

// useSlides mock — controlled per test
const mockSlidesData: Slide[] = []
vi.mock('../state/useSlides', () => ({
  useSlides: () => mockSlidesData,
}))

// requestFullscreen mock
const mockRequestFullscreen = vi.fn().mockResolvedValue(undefined)
const mockExitFullscreen = vi.fn().mockResolvedValue(undefined)

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

function makeSlide(id: string): Slide {
  return {
    id,
    objects: [],
    animations: [],
    transition: { kind: 'none', durationMs: 0 },
  }
}

/**
 * Renders PresentLayout within MemoryRouter with params and ActiveSlideContext.
 */
function renderPresent(
  options: {
    deckId?: string
    canvasInstance?: CanvasInstance | null
    activeSlide?: ActiveSlideContextValue
  } = {},
) {
  const {
    deckId = 'test-deck',
    canvasInstance = null,
    activeSlide = { activeSlideId: null, setActiveSlideId: vi.fn() },
  } = options

  const ctxValue = createSlideDocValue()

  return render(
    <SlideDocContext value={ctxValue}>
      <ActiveSlideContext value={activeSlide}>
        <CanvasInstanceContext value={canvasInstance}>
          <MemoryRouter initialEntries={[`/deck/${deckId}/present`]}>
            <Routes>
              <Route path="/deck/:id/present" element={<PresentLayout />} />
            </Routes>
          </MemoryRouter>
        </CanvasInstanceContext>
      </ActiveSlideContext>
    </SlideDocContext>,
    { providers: { router: false, slideDoc: false } },
  )
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockNavigate.mockClear()
  mockSlidesData.length = 0

  Object.defineProperty(document, 'fullscreenElement', {
    value: null,
    writable: true,
    configurable: true,
  })
  Object.defineProperty(document.documentElement, 'requestFullscreen', {
    value: mockRequestFullscreen,
    writable: true,
    configurable: true,
  })
  Object.defineProperty(document, 'exitFullscreen', {
    value: mockExitFullscreen,
    writable: true,
    configurable: true,
  })
})

// ---------------------------------------------------------------------------
// Layout tests
// ---------------------------------------------------------------------------

describe('PresentLayout — layout', () => {
  it('renders slide container', () => {
    renderPresent()
    expect(screen.getByTestId('slide-container')).toBeInTheDocument()
  })

  it('renders canvas', () => {
    renderPresent()
    expect(screen.getByTestId('canvas-mock')).toBeInTheDocument()
  })

  it('does not render toolbar', () => {
    renderPresent()
    expect(screen.queryByRole('toolbar')).toBeNull()
  })

  it('does not render inspector', () => {
    renderPresent()
    expect(screen.queryByText(/inspector/i)).toBeNull()
  })

  it('does not render sidebar "Slides"', () => {
    renderPresent()
    expect(screen.queryByText(/^slides$/i)).toBeNull()
  })

  it('slide container is position:relative for overlay compositor anchoring', () => {
    // M12: VideoOverlay sits over the Pixi canvas and needs pointer-events for play.
    // The slide wrapper was pointer-events-none in M5; relaxed in M12 so DOM overlays
    // can be interactive. The wrapper is still position:relative so OverlayCompositor
    // can anchor absolutely-positioned DOM children.
    renderPresent()
    const container = screen.getByTestId('slide-container')
    expect(container.className).toContain('relative')
  })

  it('role="application" with aria-label', () => {
    renderPresent()
    expect(screen.getByRole('application')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Keyboard navigation tests
// ---------------------------------------------------------------------------

describe('PresentLayout — keyboard navigation', () => {
  it('ArrowLeft at first slide is no-op', () => {
    const slide1 = makeSlide('s1')
    const slide2 = makeSlide('s2')
    mockSlidesData.push(slide1, slide2)

    const mockSetActiveSlideId = vi.fn()
    const activeSlide: ActiveSlideContextValue = {
      activeSlideId: 's1', // already at first
      setActiveSlideId: mockSetActiveSlideId,
    }

    renderPresent({ activeSlide })

    act(() => {
      fireEvent.keyDown(window, { key: 'ArrowLeft' })
    })

    expect(mockSetActiveSlideId).not.toHaveBeenCalled()
  })

  it('ArrowRight at last slide is no-op', () => {
    const slide1 = makeSlide('s1')
    const slide2 = makeSlide('s2')
    mockSlidesData.push(slide1, slide2)

    const mockSetActiveSlideId = vi.fn()
    const activeSlide: ActiveSlideContextValue = {
      activeSlideId: 's2', // already at last
      setActiveSlideId: mockSetActiveSlideId,
    }

    renderPresent({ activeSlide })

    act(() => {
      fireEvent.keyDown(window, { key: 'ArrowRight' })
    })

    expect(mockSetActiveSlideId).not.toHaveBeenCalled()
  })

  it('does not navigate on other keys', () => {
    renderPresent()
    act(() => {
      fireEvent.keyDown(window, { key: 'a' })
    })
    expect(mockNavigate).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Slide counter tests
// ---------------------------------------------------------------------------

describe('PresentLayout — slide counter', () => {
  it('shows correct counter when on first of two slides', () => {
    mockSlidesData.push(makeSlide('s1'), makeSlide('s2'))

    const activeSlide: ActiveSlideContextValue = {
      activeSlideId: 's1',
      setActiveSlideId: vi.fn(),
    }

    renderPresent({ activeSlide })
    // aria-hidden counter
    expect(screen.getByText('1 / 2')).toBeInTheDocument()
  })

  it('shows correct counter when on second of two slides', () => {
    mockSlidesData.push(makeSlide('s1'), makeSlide('s2'))

    const activeSlide: ActiveSlideContextValue = {
      activeSlideId: 's2',
      setActiveSlideId: vi.fn(),
    }

    renderPresent({ activeSlide })
    expect(screen.getByText('2 / 2')).toBeInTheDocument()
  })

  it('shows 1/1 fallback when slides list is empty', () => {
    // mockSlidesData is empty
    renderPresent()
    expect(screen.getByText('1 / 1')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Scale test
// ---------------------------------------------------------------------------

describe('PresentLayout — scale', () => {
  it('slide container has CSS transform scale', () => {
    renderPresent()
    const container = screen.getByTestId('slide-container')
    const style = container.getAttribute('style') ?? ''
    expect(style).toContain('scale(')
  })
})

// ---------------------------------------------------------------------------
// Animation runtime integration tests (M6)
// ---------------------------------------------------------------------------

// The animation runtime (builds compiled on the prepared slide, played on
// arrival) is the presentation controller's: present/presentation.test.ts.
