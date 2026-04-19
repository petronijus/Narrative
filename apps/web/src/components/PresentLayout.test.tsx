/**
 * PresentLayout.test.tsx
 *
 * M5 testy pro present mode layout:
 * - Fullscreen layout nerenderuje toolbar/inspector/sidebar
 * - Escape key → navigate voláno s /deck/:id
 * - Arrow keys + Space → console.debug placeholder
 * - Slide container existuje v DOM
 * - F key → toggleFullscreen (requestFullscreen mock)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import type * as ReactRouterDom from 'react-router-dom'
import { PresentLayout } from './PresentLayout'
import { SlideDocContext } from '../state/slideDocContext'
import type { SlideDocContextValue } from '../state/slideDocContext'
import * as Y from 'yjs'
import type { MutationContext } from '@narrative/slide-model'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// ResizeObserver není v jsdom — polyfill pro testy
class ResizeObserverMock {
  private callback: ResizeObserverCallback

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
  }

  observe(target: Element) {
    // Zavolej callback synchronně s fiktivní entry (simuluje initial measurement)
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

// Canvas je heavy Pixi závislost — mockujeme ji
vi.mock('../renderer/Canvas', () => ({
  Canvas: () => <div data-testid="canvas-mock" />,
}))

// useSlideObjectChanges je voláno z Canvas — mock pokud Canvas není mockovaný hlouběji
vi.mock('../state/useSlideObjectChanges', () => ({
  useSlideObjectChanges: () => undefined,
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

// requestFullscreen mock
const mockRequestFullscreen = vi.fn().mockResolvedValue(undefined)
const mockExitFullscreen = vi.fn().mockResolvedValue(undefined)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMutationCtx(): MutationContext {
  const doc = new Y.Doc()
  const objects = doc.getArray<Y.Map<unknown>>('objects')
  return { doc, objects }
}

function createSlideDocValue(): SlideDocContextValue {
  const mutationCtx = createMutationCtx()
  return {
    mutationCtx,
    undoManager: null as unknown as SlideDocContextValue['undoManager'],
  }
}

/**
 * Render PresentLayout uvnitř MemoryRouter s params.
 * Používáme nested route aby useParams vrátilo { id: 'test-deck' }.
 */
function renderPresent(deckId = 'test-deck') {
  const ctxValue = createSlideDocValue()

  return render(
    <SlideDocContext.Provider value={ctxValue}>
      <MemoryRouter initialEntries={[`/deck/${deckId}/present`]}>
        <Routes>
          <Route path="/deck/:id/present" element={<PresentLayout />} />
        </Routes>
      </MemoryRouter>
    </SlideDocContext.Provider>,
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockNavigate.mockClear()

  // Fullscreen API není v jsdom — mockujeme
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

describe('PresentLayout — layout', () => {
  it('renderuje slide container', () => {
    renderPresent()
    expect(screen.getByTestId('slide-container')).toBeInTheDocument()
  })

  it('renderuje canvas', () => {
    renderPresent()
    expect(screen.getByTestId('canvas-mock')).toBeInTheDocument()
  })

  it('nerenderuje toolbar', () => {
    renderPresent()
    expect(screen.queryByRole('toolbar')).toBeNull()
  })

  it('nerenderuje inspector', () => {
    renderPresent()
    // Inspector má heading "Inspector"
    expect(screen.queryByText(/inspector/i)).toBeNull()
  })

  it('nerenderuje sidebar "Slides"', () => {
    renderPresent()
    expect(screen.queryByText(/^slides$/i)).toBeNull()
  })

  it('slide container má pointer-events:none', () => {
    renderPresent()
    const container = screen.getByTestId('slide-container')
    // Tailwind class pointer-events-none aplikuje inline style nebo class
    expect(container.className).toContain('pointer-events-none')
  })

  it('role="application" s aria-label', () => {
    renderPresent()
    expect(screen.getByRole('application')).toBeInTheDocument()
  })
})

describe('PresentLayout — keyboard', () => {
  it('Escape naviguje zpět do editoru', () => {
    renderPresent('abc')
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    expect(mockNavigate).toHaveBeenCalledOnce()
    expect(mockNavigate).toHaveBeenCalledWith('/deck/abc')
  })

  it('ArrowLeft loguje placeholder', () => {
    const consoleSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    renderPresent()
    act(() => {
      fireEvent.keyDown(window, { key: 'ArrowLeft' })
    })
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[present] navigation key pressed'),
    )
    consoleSpy.mockRestore()
  })

  it('ArrowRight loguje placeholder', () => {
    const consoleSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    renderPresent()
    act(() => {
      fireEvent.keyDown(window, { key: 'ArrowRight' })
    })
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[present] navigation key pressed'),
    )
    consoleSpy.mockRestore()
  })

  it('Space loguje placeholder', () => {
    const consoleSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    renderPresent()
    act(() => {
      fireEvent.keyDown(window, { key: ' ' })
    })
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[present] navigation key pressed'),
    )
    consoleSpy.mockRestore()
  })

  it('PageUp loguje placeholder', () => {
    const consoleSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    renderPresent()
    act(() => {
      fireEvent.keyDown(window, { key: 'PageUp' })
    })
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[present] navigation key pressed'),
    )
    consoleSpy.mockRestore()
  })

  it('PageDown loguje placeholder', () => {
    const consoleSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    renderPresent()
    act(() => {
      fireEvent.keyDown(window, { key: 'PageDown' })
    })
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[present] navigation key pressed'),
    )
    consoleSpy.mockRestore()
  })

  it('F key volá requestFullscreen', async () => {
    renderPresent()
    await act(async () => {
      fireEvent.keyDown(window, { key: 'f' })
    })
    expect(mockRequestFullscreen).toHaveBeenCalled()
  })

  it('nenaviguje na jiných klávesách', () => {
    renderPresent()
    act(() => {
      fireEvent.keyDown(window, { key: 'a' })
    })
    expect(mockNavigate).not.toHaveBeenCalled()
  })
})

describe('PresentLayout — scale', () => {
  it('slide container má CSS transform scale', () => {
    renderPresent()
    const container = screen.getByTestId('slide-container')
    const style = container.getAttribute('style') ?? ''
    expect(style).toContain('scale(')
  })
})
