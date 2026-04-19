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
import { CanvasInstanceContext } from '../renderer/CanvasInstanceContext'
import type { CanvasInstance } from '../renderer/CanvasInstanceContext'
import * as Y from 'yjs'
import type { SlideMutationContext } from '@narrative/slide-model'
import type { AnimationStep } from '@narrative/shared'

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

// Animation runtime mock — vi.hoisted() zajistí že proměnné jsou k dispozici před vi.mock() hoistingem
const {
  mockPlay,
  mockDestroy,
  mockCreateAnimationRuntime,
  mockCreateClickInputBridge,
  mockAnimationsData,
} = vi.hoisted(() => {
  const mockPlay = vi.fn()
  const mockDestroy = vi.fn()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockCreateAnimationRuntime = vi.fn((_steps: any, _ctx: any) => ({
    play: mockPlay,
    destroy: mockDestroy,
  }))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockCreateClickInputBridge = vi.fn((_el: any) => ({ onAdvance: vi.fn() }))
  const mockAnimationsData: AnimationStep[] = []
  return {
    mockPlay,
    mockDestroy,
    mockCreateAnimationRuntime,
    mockCreateClickInputBridge,
    mockAnimationsData,
  }
})

vi.mock('@narrative/animation', () => ({
  createAnimationRuntime: mockCreateAnimationRuntime,
  createClickInputBridge: mockCreateClickInputBridge,
}))

vi.mock('../animation/targetResolver', () => ({
  createPixiTargetResolver: vi.fn(() => ({ resolve: vi.fn() })),
}))

vi.mock('../state/useAnimations', () => ({
  useAnimations: () => ({
    animations: mockAnimationsData,
    mutationCtx: {
      doc: new Y.Doc(),
      objects: new Y.Doc().getArray('objects'),
      animations: new Y.Doc().getArray('animations'),
    },
  }),
}))

// requestFullscreen mock
const mockRequestFullscreen = vi.fn().mockResolvedValue(undefined)
const mockExitFullscreen = vi.fn().mockResolvedValue(undefined)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMutationCtx(): SlideMutationContext {
  const doc = new Y.Doc()
  const objects = doc.getArray<Y.Map<unknown>>('objects')
  const animations = doc.getArray<Y.Map<unknown>>('animations')
  return { doc, objects, animations }
}

function createSlideDocValue(): SlideDocContextValue {
  const mutationCtx = createMutationCtx()
  return {
    mutationCtx,
    undoManager: null as unknown as SlideDocContextValue['undoManager'],
  }
}

/** Fiktivní CanvasInstance pro testy runtime integrace. */
function createMockCanvasInstance(): CanvasInstance {
  return {
    sceneGraph: { getNode: vi.fn() } as unknown as CanvasInstance['sceneGraph'],
    compositor: {} as unknown as CanvasInstance['compositor'],
  }
}

/**
 * Render PresentLayout uvnitř MemoryRouter s params.
 * Používáme nested route aby useParams vrátilo { id: 'test-deck' }.
 */
function renderPresent(deckId = 'test-deck', canvasInstance: CanvasInstance | null = null) {
  const ctxValue = createSlideDocValue()

  return render(
    <SlideDocContext.Provider value={ctxValue}>
      <CanvasInstanceContext.Provider value={canvasInstance}>
        <MemoryRouter initialEntries={[`/deck/${deckId}/present`]}>
          <Routes>
            <Route path="/deck/:id/present" element={<PresentLayout />} />
          </Routes>
        </MemoryRouter>
      </CanvasInstanceContext.Provider>
    </SlideDocContext.Provider>,
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockNavigate.mockClear()
  mockPlay.mockClear()
  mockDestroy.mockClear()
  mockCreateAnimationRuntime.mockClear()
  mockCreateClickInputBridge.mockClear()
  // Reset animations
  mockAnimationsData.length = 0

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

// ---------------------------------------------------------------------------
// Animation runtime integration tests (M6)
// ---------------------------------------------------------------------------

describe('PresentLayout — animation runtime', () => {
  it('nevytváří runtime pokud canvas není ready (null)', () => {
    mockAnimationsData.push({
      id: 'a1',
      objectId: 'obj-1',
      preset: 'fadeIn',
      trigger: 'onEnter',
      duration: 0.6,
      delay: 0,
      easing: 'power2.out',
    })

    renderPresent('test', null)
    expect(mockCreateAnimationRuntime).not.toHaveBeenCalled()
  })

  it('nevytváří runtime pokud nejsou žádné animace', () => {
    const instance = createMockCanvasInstance()
    // mockAnimationsData je prázdné
    renderPresent('test', instance)
    expect(mockCreateAnimationRuntime).not.toHaveBeenCalled()
  })

  it('vytvoří runtime a zavolá play() pokud canvas ready + animace existují', () => {
    mockAnimationsData.push({
      id: 'a1',
      objectId: 'obj-1',
      preset: 'fadeIn',
      trigger: 'onEnter',
      duration: 0.6,
      delay: 0,
      easing: 'power2.out',
    })

    const instance = createMockCanvasInstance()
    renderPresent('test', instance)

    expect(mockCreateAnimationRuntime).toHaveBeenCalledOnce()
    expect(mockPlay).toHaveBeenCalledOnce()
  })

  it('destroy() je volán při unmount', () => {
    mockAnimationsData.push({
      id: 'a1',
      objectId: 'obj-1',
      preset: 'fadeIn',
      trigger: 'onEnter',
      duration: 0.6,
      delay: 0,
      easing: 'power2.out',
    })

    const instance = createMockCanvasInstance()
    const { unmount } = renderPresent('test', instance)

    expect(mockPlay).toHaveBeenCalledOnce()
    unmount()
    expect(mockDestroy).toHaveBeenCalledOnce()
  })
})
