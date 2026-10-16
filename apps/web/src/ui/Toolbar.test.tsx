/**
 * Toolbar.test.tsx
 *
 * - Klik na tlačítko přepíná tool.
 * - Keyboard shortcut (V/R/O/T) přepíná tool.
 * - M5: Present button naviguje na /deck/:id/present.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, act, fireEvent } from '@testing-library/react'
import { renderWithProviders as render } from '../test/renderWithProviders'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import type * as ReactRouterDom from 'react-router-dom'
import { Toolbar } from './Toolbar'
import { ToolProvider, useTool } from '../state/ToolContext'
import type { ActiveTool } from '../state/ToolContext'

// ---------------------------------------------------------------------------
// Mock useAwareness — Toolbar renderuje AvatarChips, který potřebuje awareness.
// Toolbar.test testuje tool switching, ne awareness — mockneme celý hook.
// ---------------------------------------------------------------------------

vi.mock('../state/useAwareness.js', () => ({
  useAwareness: () => ({ peers: [], remotePeers: [], localClientId: 1 }),
  useRemotePeers: () => [],
}))

// ---------------------------------------------------------------------------
// M10: Mock AuthContext and DeckRoleContext (Toolbar now uses both)
// ---------------------------------------------------------------------------

vi.mock('../state/AuthContext.js', async (importOriginal) => ({
  // Preserve AuthContext + AuthUser/AuthContextValue types so other code
  // (including renderWithProviders) can still read the named export.
  ...(await importOriginal<typeof import('../state/AuthContext')>()),
  useAuth: () => ({
    user: { sub: 'test-user', name: 'Test User' },
    token: 'test-token',
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn(),
    refreshToken: vi.fn(),
    completeSignin: vi.fn(),
  }),
}))

vi.mock('../state/DeckRoleContext.js', () => ({
  useDeckRole: () => ({ role: 'owner', isLoading: false }),
}))

vi.mock('./ShareDialog.js', () => ({
  ShareDialog: () => <div data-testid="share-dialog">Share Dialog</div>,
}))

// ---------------------------------------------------------------------------
// M11: Mock useMediaUpload + useSlideObjects + slide-model (Toolbar now imports these)
// ---------------------------------------------------------------------------

vi.mock('../state/useMediaUpload.js', () => ({
  useMediaUpload: () => ({
    startUpload: vi.fn(),
    uploads: [],
    cancelUpload: vi.fn(),
    retryUpload: vi.fn(),
    dismissUpload: vi.fn(),
  }),
}))

// The component reads the active slide itself (to address commands); the
// tests mock the slide's objects, so they supply the slide id too.
vi.mock('../state/ActiveSlideContext.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../state/ActiveSlideContext.js')>()),
  useActiveSlide: () => ({ activeSlideId: 'slide-1', setActiveSlideId: vi.fn() }),
}))

vi.mock('../state/useSlideObjects.js', () => ({
  useSlideObjects: () => ({ objectsCtx: null, objects: [] }),
}))

vi.mock('@narrative/slide-model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@narrative/slide-model')>()
  return { ...actual, createObjectOfType: vi.fn() }
})

// ---------------------------------------------------------------------------
// navigate mock
// ---------------------------------------------------------------------------

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

function ToolReadout() {
  const { activeTool } = useTool()
  return <div data-testid="active-tool">{activeTool}</div>
}

/**
 * Render Toolbar uvnitř MemoryRouter s deck id param.
 * Route pattern /deck/:id zajistí správné useParams.
 */
function TestApp({ deckId = 'test-deck' }: { deckId?: string } = {}) {
  return (
    <MemoryRouter initialEntries={[`/deck/${deckId}`]}>
      <Routes>
        <Route
          path="/deck/:id"
          element={
            <ToolProvider>
              <Toolbar />
              <ToolReadout />
            </ToolProvider>
          }
        />
      </Routes>
    </MemoryRouter>
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockNavigate.mockClear()
})

describe('Toolbar', () => {
  it('renders Present button', () => {
    render(<TestApp />, { providers: { router: false } })
    expect(screen.getByRole('button', { name: /present/i })).toBeInTheDocument()
  })

  it('default tool is select', () => {
    render(<TestApp />, { providers: { router: false } })
    expect(screen.getByTestId('active-tool').textContent).toBe('select')
    expect(screen.getByRole('button', { name: /select/i })).toHaveAttribute('aria-pressed', 'true')
  })

  it('clicking Text switches to text tool', () => {
    render(<TestApp />, { providers: { router: false } })
    act(() => {
      screen.getByRole('button', { name: /text/i }).click()
    })
    expect(screen.getByTestId('active-tool').textContent).toBe('text')
  })

  it('keyboard shortcut V switches back to select', () => {
    render(<TestApp />, { providers: { router: false } })
    // Nejdříve přepneme na rectangle
    act(() => {
      fireEvent.keyDown(window, { key: 'r' })
    })
    // Pak zpět na select
    act(() => {
      fireEvent.keyDown(window, { key: 'v' })
    })
    expect(screen.getByTestId('active-tool').textContent).toBe('select')
  })

  it('keyboard shortcuts are ignored when input is focused', () => {
    render(
      <MemoryRouter initialEntries={['/deck/test']}>
        <Routes>
          <Route
            path="/deck/:id"
            element={
              <ToolProvider>
                <Toolbar />
                <ToolReadout />
                <input data-testid="text-input" />
              </ToolProvider>
            }
          />
        </Routes>
      </MemoryRouter>,
      { providers: { router: false } },
    )

    // Focus input
    const input = screen.getByTestId('text-input')
    act(() => {
      input.focus()
    })

    // Stiskneme 'r' ale fokus je na inputu — tool se nemění
    act(() => {
      fireEvent.keyDown(input, { key: 'r' })
    })
    expect(screen.getByTestId('active-tool').textContent).toBe('select')
  })

  it('Present button click navigates to /deck/:id/present', () => {
    render(<TestApp deckId="my-deck" />, { providers: { router: false } })
    act(() => {
      screen.getByRole('button', { name: /present/i }).click()
    })
    expect(mockNavigate).toHaveBeenCalledWith('/deck/my-deck/present')
  })
})

describe('ToolContext', () => {
  it('throws outside provider', () => {
    const originalError = console.error
    console.error = () => {}
    expect(() => render(<ToolReadout />)).toThrow('useTool must be used within ToolProvider')
    console.error = originalError
  })

  it('setActiveTool changes the active tool', () => {
    function Setter({ tool }: { tool: ActiveTool }) {
      const { setActiveTool } = useTool()
      return <button onClick={() => setActiveTool(tool)}>set {tool}</button>
    }

    render(
      <ToolProvider>
        <Setter tool="ellipse" />
        <ToolReadout />
      </ToolProvider>,
    )

    act(() => {
      screen.getByText('set ellipse').click()
    })
    expect(screen.getByTestId('active-tool').textContent).toBe('ellipse')
  })
})
