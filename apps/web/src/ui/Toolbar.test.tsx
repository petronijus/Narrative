/**
 * Toolbar.test.tsx
 *
 * - Klik na tlačítko přepíná tool.
 * - Keyboard shortcut (V/R/O/T) přepíná tool.
 * - M5: Present button naviguje na /deck/:id/present.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
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
}))

// ---------------------------------------------------------------------------
// M10: Mock AuthContext and DeckRoleContext (Toolbar now uses both)
// ---------------------------------------------------------------------------

vi.mock('../state/AuthContext.js', () => ({
  useAuth: () => ({
    user: { sub: 'test-user', name: 'Test User' },
    token: 'test-token',
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn(),
    refreshToken: vi.fn(),
  }),
}))

vi.mock('../state/DeckRoleContext.js', () => ({
  useDeckRole: () => ({ role: 'owner', isLoading: false }),
}))

vi.mock('./ShareDialog.js', () => ({
  ShareDialog: () => <div data-testid="share-dialog">Share Dialog</div>,
}))

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
  it('renders all tool buttons', () => {
    render(<TestApp />)
    expect(screen.getByRole('button', { name: /select/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /rectangle/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /ellipse/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /text/i })).toBeInTheDocument()
  })

  it('renders Present button', () => {
    render(<TestApp />)
    expect(screen.getByRole('button', { name: /present/i })).toBeInTheDocument()
  })

  it('default tool is select', () => {
    render(<TestApp />)
    expect(screen.getByTestId('active-tool').textContent).toBe('select')
    expect(screen.getByRole('button', { name: /select/i })).toHaveAttribute('aria-pressed', 'true')
  })

  it('clicking Rectangle switches to rectangle tool', () => {
    render(<TestApp />)
    act(() => {
      screen.getByRole('button', { name: /rectangle/i }).click()
    })
    expect(screen.getByTestId('active-tool').textContent).toBe('rectangle')
    expect(screen.getByRole('button', { name: /rectangle/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByRole('button', { name: /select/i })).toHaveAttribute('aria-pressed', 'false')
  })

  it('clicking Ellipse switches to ellipse tool', () => {
    render(<TestApp />)
    act(() => {
      screen.getByRole('button', { name: /ellipse/i }).click()
    })
    expect(screen.getByTestId('active-tool').textContent).toBe('ellipse')
  })

  it('clicking Text switches to text tool', () => {
    render(<TestApp />)
    act(() => {
      screen.getByRole('button', { name: /text/i }).click()
    })
    expect(screen.getByTestId('active-tool').textContent).toBe('text')
  })

  it('keyboard shortcut R switches to rectangle', () => {
    render(<TestApp />)
    act(() => {
      fireEvent.keyDown(window, { key: 'r' })
    })
    expect(screen.getByTestId('active-tool').textContent).toBe('rectangle')
  })

  it('keyboard shortcut O switches to ellipse', () => {
    render(<TestApp />)
    act(() => {
      fireEvent.keyDown(window, { key: 'o' })
    })
    expect(screen.getByTestId('active-tool').textContent).toBe('ellipse')
  })

  it('keyboard shortcut T switches to text', () => {
    render(<TestApp />)
    act(() => {
      fireEvent.keyDown(window, { key: 't' })
    })
    expect(screen.getByTestId('active-tool').textContent).toBe('text')
  })

  it('keyboard shortcut V switches back to select', () => {
    render(<TestApp />)
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

  it('uppercase keyboard shortcuts also work', () => {
    render(<TestApp />)
    act(() => {
      fireEvent.keyDown(window, { key: 'R' })
    })
    expect(screen.getByTestId('active-tool').textContent).toBe('rectangle')
  })

  it('Present button click navigates to /deck/:id/present', () => {
    render(<TestApp deckId="my-deck" />)
    act(() => {
      screen.getByRole('button', { name: /present/i }).click()
    })
    expect(mockNavigate).toHaveBeenCalledWith('/deck/my-deck/present')
  })

  it('Ctrl+Enter navigates to present mode', () => {
    render(<TestApp deckId="my-deck" />)
    act(() => {
      fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true })
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
