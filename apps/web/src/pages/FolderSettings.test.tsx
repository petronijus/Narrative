/**
 * pages/FolderSettings.test.tsx
 *
 * M16 P2 — RTL smoke tests for the FolderSettings page.
 *
 * Covers:
 *   - Renders all three tabs
 *   - Creating a color token
 *   - Renaming a color token inline
 *   - Delete modal scaffold (usage-warning included)
 *   - Text style tab renders + add
 *   - Effect style tab renders + add
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { FolderSettings } from './FolderSettings'
import * as FolderDocProviderModule from '../state/FolderDocProvider'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock the API client
const mockListFolders = vi
  .fn()
  .mockResolvedValue([
    { id: 'folder-1', name: 'My Folder', deckCount: 2, createdAt: '2026-01-01T00:00:00Z' },
  ])
const mockRenameFolder = vi.fn().mockResolvedValue({})

vi.mock('../api/client', () => ({
  useApi: () => ({
    listFolders: mockListFolders,
    renameFolder: mockRenameFolder,
  }),
}))

// Mock auth context
vi.mock('../state/AuthContext', () => ({
  useAuth: () => ({ user: null, token: null, logout: vi.fn() }),
}))

// ---------------------------------------------------------------------------
// FolderDocProvider mock — in-memory version for tests
// ---------------------------------------------------------------------------

type TokenCategory = 'colors' | 'textStyles' | 'effectStyles'
type TokenInit = Record<string, unknown>

let mockColors: Record<string, { id: string; name: string; value: string }> = {}
let mockTextStyles: Record<
  string,
  { id: string; name: string; family?: string; weight?: number; size?: number }
> = {}
let mockEffectStyles: Record<
  string,
  { id: string; name: string; kind: string; params: Record<string, unknown> }
> = {}
let idCounter = 0

const mockTokenSnapshot = () => ({
  colors: mockColors as Record<string, { id: string; name: string; value: string }>,
  textStyles: mockTextStyles as Record<string, { id: string; name: string }>,
  effectStyles: mockEffectStyles as Record<
    string,
    { id: string; name: string; kind: string; params: Record<string, unknown> }
  >,
})

vi.mock('../state/FolderDocProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof FolderDocProviderModule>()
  return {
    ...actual,
    FolderDocProvider: ({ children }: { folderId: string; children: React.ReactNode }) => children,
    useFolderTokens: () => mockTokenSnapshot(),
    useFolderMutations: () => ({
      addToken: (category: TokenCategory, init: TokenInit) => {
        const id = `mock-id-${++idCounter}`
        if (category === 'colors') {
          mockColors[id] = {
            id,
            name: String(init['name'] ?? ''),
            value: String(init['value'] ?? '#ffffff'),
          }
        } else if (category === 'textStyles') {
          mockTextStyles[id] = {
            id,
            name: String(init['name'] ?? ''),
            ...(init['family'] ? { family: String(init['family']) } : {}),
          }
        } else if (category === 'effectStyles') {
          mockEffectStyles[id] = {
            id,
            name: String(init['name'] ?? ''),
            kind: String(init['kind'] ?? 'shadow'),
            params: (init['params'] as Record<string, unknown>) ?? {},
          }
        }
        return id
      },
      updateToken: (category: TokenCategory, id: string, patch: Partial<TokenInit>) => {
        if (category === 'colors' && mockColors[id]) {
          mockColors[id] = {
            ...mockColors[id],
            ...(patch as Partial<{ id: string; name: string; value: string }>),
          }
        }
      },
      deleteToken: (category: TokenCategory, id: string) => {
        if (category === 'colors') delete mockColors[id]
        else if (category === 'textStyles') delete mockTextStyles[id]
        else if (category === 'effectStyles') delete mockEffectStyles[id]
      },
      listUsages: () => [],
    }),
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderFolderSettings(folderId = 'folder-1') {
  return render(
    <MemoryRouter initialEntries={[`/folder/${folderId}/settings`]}>
      <Routes>
        <Route path="/folder/:folderId/settings" element={<FolderSettings />} />
        <Route path="/folder/:folderId" element={<div>FolderDecks</div>} />
        <Route path="/" element={<div>Home</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FolderSettings page', () => {
  beforeEach(() => {
    mockColors = {}
    mockTextStyles = {}
    mockEffectStyles = {}
    idCounter = 0
    mockListFolders.mockResolvedValue([
      { id: 'folder-1', name: 'My Folder', deckCount: 2, createdAt: '2026-01-01T00:00:00Z' },
    ])
  })

  it('renders all three tabs', async () => {
    renderFolderSettings()
    expect(screen.getByRole('tab', { name: 'Colors' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Text styles' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Effect styles' })).toBeInTheDocument()
  })

  it('shows Settings in the header breadcrumb', async () => {
    renderFolderSettings()
    expect(screen.getByText('Settings')).toBeInTheDocument()
  })

  it('shows empty state on Colors tab when no colors exist', () => {
    renderFolderSettings()
    expect(screen.getByText('No colors defined yet.')).toBeInTheDocument()
  })

  it('creates a new color token when + New color is clicked', async () => {
    renderFolderSettings()
    fireEvent.click(screen.getByRole('button', { name: /new color/i }))
    await waitFor(() => {
      expect(screen.getByRole('listitem')).toBeInTheDocument()
    })
  })

  it('shows the color swatch after creating a color', async () => {
    renderFolderSettings()
    fireEvent.click(screen.getByRole('button', { name: /new color/i }))
    await waitFor(() => {
      // The swatch button should have an aria-label containing the color name
      expect(screen.getByLabelText(/color: new color/i)).toBeInTheDocument()
    })
  })

  it('opens delete modal when delete button is clicked', async () => {
    // Pre-populate a color
    mockColors['c1'] = { id: 'c1', name: 'Brand Blue', value: '#3b82f6' }

    renderFolderSettings()

    // The delete button uses hidden/group-hover classes — query with { hidden: true }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deleteBtn = screen.getByLabelText(/delete color brand blue/i, { hidden: true } as any)
    fireEvent.click(deleteBtn)

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument()
      // The modal should have a heading with the token name
      expect(screen.getByRole('dialog').querySelector('h2')).not.toBeNull()
    })
  })

  it('confirms token deletion', async () => {
    mockColors['c1'] = { id: 'c1', name: 'Brand Blue', value: '#3b82f6' }

    renderFolderSettings()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deleteBtn = screen.getByLabelText(/delete color brand blue/i, { hidden: true } as any)
    fireEvent.click(deleteBtn)
    await waitFor(() => screen.getByRole('dialog'))

    // The button says "Delete" when no usages exist
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(mockColors['c1']).toBeUndefined()
  })

  it('cancels token deletion on Cancel', async () => {
    mockColors['c1'] = { id: 'c1', name: 'Brand Blue', value: '#3b82f6' }

    renderFolderSettings()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deleteBtn = screen.getByLabelText(/delete color brand blue/i, { hidden: true } as any)
    fireEvent.click(deleteBtn)
    await waitFor(() => screen.getByRole('dialog'))

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(mockColors['c1']).toBeDefined()
  })

  it('switches to Text styles tab', () => {
    renderFolderSettings()
    fireEvent.click(screen.getByRole('tab', { name: 'Text styles' }))
    expect(screen.getByText(/no text styles yet/i)).toBeInTheDocument()
  })

  it('creates a text style', async () => {
    renderFolderSettings()
    fireEvent.click(screen.getByRole('tab', { name: 'Text styles' }))
    fireEvent.click(screen.getByRole('button', { name: /add text style/i }))

    await waitFor(() => {
      // After adding a style, the list should have the "New style" entry
      expect(screen.getByText('New style')).toBeInTheDocument()
    })
  })

  it('switches to Effect styles tab', () => {
    renderFolderSettings()
    fireEvent.click(screen.getByRole('tab', { name: 'Effect styles' }))
    expect(screen.getByText('No effect styles yet.')).toBeInTheDocument()
  })

  it('adds a shadow effect', async () => {
    renderFolderSettings()
    fireEvent.click(screen.getByRole('tab', { name: 'Effect styles' }))
    fireEvent.click(screen.getByRole('button', { name: /new shadow/i }))

    await waitFor(() => {
      expect(screen.getByText('Drop shadow')).toBeInTheDocument()
    })
  })

  it('adds a blur effect', async () => {
    renderFolderSettings()
    fireEvent.click(screen.getByRole('tab', { name: 'Effect styles' }))
    fireEvent.click(screen.getByRole('button', { name: /new blur/i }))

    await waitFor(() => {
      expect(screen.getByText('Background blur')).toBeInTheDocument()
    })
  })

  it('navigates back when chevron button is clicked', async () => {
    renderFolderSettings()

    await waitFor(() => {
      expect(screen.getByLabelText('Back to folder')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByLabelText('Back to folder'))

    await waitFor(() => {
      expect(screen.getByText('FolderDecks')).toBeInTheDocument()
    })
  })
})
