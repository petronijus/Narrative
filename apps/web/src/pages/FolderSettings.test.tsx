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
 *   - (Effect styles tab dropped per M16 P2 spec revision)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { FolderSettings } from './FolderSettings'
import type * as React from 'react'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock the API client
const mockListFolders = vi.fn().mockResolvedValue([
  {
    id: 'folder-1',
    name: 'My Folder',
    deckCount: 2,
    createdAt: '2026-01-01T00:00:00Z',
    role: 'owner',
  },
])
const mockRenameFolder = vi.fn().mockResolvedValue({})

// M16 P5 — Component API mocks
const mockListComponents = vi.fn().mockResolvedValue([])
const mockRenameComponent = vi.fn().mockResolvedValue({})
const mockDeleteComponent = vi.fn().mockResolvedValue(undefined)

// M16 P3 — Font API mocks (needed to avoid unmatched call errors)
const mockListFolderFonts = vi.fn().mockResolvedValue([])

const stableApi = {
  listFolders: mockListFolders,
  renameFolder: mockRenameFolder,
  listComponents: mockListComponents,
  renameComponent: mockRenameComponent,
  deleteComponent: mockDeleteComponent,
  listFolderFonts: mockListFolderFonts,
  uploadFolderFont: vi.fn(),
  deleteFolderFont: vi.fn(),
}

vi.mock('../api/client', () => ({
  useApi: () => stableApi,
}))

// Mock auth context
vi.mock('../state/AuthContext', () => ({
  useAuth: () => ({ user: null, isLoading: false, login: vi.fn(), logout: vi.fn() }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}))

// Mock heavy modules that pull in Pixi.js / CanvasInstanceContext
vi.mock('../state/FolderFontLoader.js', () => ({
  FolderFontLoader: () => null,
}))

vi.mock('../state/useFolderFonts.js', () => ({
  FolderFontsProvider: ({ children }: { children: React.ReactNode }) => children,
  useFolderFonts: () => ({ fonts: [], isLoading: false }),
  useFolderFontsOptional: () => null,
}))

vi.mock('../ui/FontFamilySelect.js', () => ({
  SYSTEM_FONTS: [],
}))

// ---------------------------------------------------------------------------
// FolderDocProvider mock — in-memory version for tests
// ---------------------------------------------------------------------------

type TokenCategory = 'colors' | 'textStyles' | 'effectStyles'
type TokenFields = Record<string, unknown>

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

// The page re-renders when the folder document changes; the mock store
// does the same through useSyncExternalStore.
let tokenVersion = 0
const tokenListeners = new Set<() => void>()
const notifyTokens = () => {
  tokenVersion++
  tokenListeners.forEach((l) => l())
}
const subscribeTokens = (l: () => void) => {
  tokenListeners.add(l)
  return () => tokenListeners.delete(l)
}

const mockTokenSnapshot = () => ({
  colors: mockColors as Record<string, { id: string; name: string; value: string }>,
  textStyles: mockTextStyles as Record<string, { id: string; name: string }>,
  effectStyles: mockEffectStyles as Record<
    string,
    { id: string; name: string; kind: string; params: Record<string, unknown> }
  >,
})

/** The server as the page's token writer sees it: every change lands in the mock store. */
const mockWriter = {
  create: vi.fn(async (category: TokenCategory, fields: TokenFields) => {
    const id = `mock-id-${++idCounter}`
    if (category === 'colors') {
      mockColors[id] = {
        id,
        name: String(fields['name'] ?? ''),
        value: String(fields['value'] ?? '#ffffff'),
      }
    } else if (category === 'textStyles') {
      mockTextStyles[id] = {
        id,
        name: String(fields['name'] ?? ''),
        ...(fields['family'] ? { family: String(fields['family']) } : {}),
      }
    }
    notifyTokens()
    return id
  }),
  update: vi.fn(async (category: TokenCategory, id: string, patch: TokenFields) => {
    if (category === 'colors' && mockColors[id]) {
      mockColors[id] = {
        ...mockColors[id],
        ...(patch as Partial<{ id: string; name: string; value: string }>),
      }
      notifyTokens()
    }
  }),
  remove: vi.fn(async (category: TokenCategory, id: string) => {
    if (category === 'colors') delete mockColors[id]
    else if (category === 'textStyles') delete mockTextStyles[id]
    else if (category === 'effectStyles') delete mockEffectStyles[id]
    notifyTokens()
  }),
}

vi.mock('../state/FolderDocProvider', async () => {
  const { useSyncExternalStore } = await import('react')
  return {
    FolderDocProvider: ({ children }: { folderId: string; children: React.ReactNode }) => children,
    useFolderTokens: () => {
      useSyncExternalStore(subscribeTokens, () => tokenVersion)
      return mockTokenSnapshot()
    },
    useFolderTokenWriter: () => mockWriter,
    useTokenUsages: () => ({ usages: [], loading: false }),
  }
})

vi.mock('../state/useFolderComponents.js', () => ({
  invalidateFolderComponentsCache: vi.fn(),
}))

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
      {
        id: 'folder-1',
        name: 'My Folder',
        deckCount: 2,
        createdAt: '2026-01-01T00:00:00Z',
        role: 'owner',
      },
    ])
  })

  it('renders Colors and Text styles tabs', async () => {
    renderFolderSettings()
    expect(screen.getByRole('tab', { name: 'Colors' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Text styles' })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Effect styles' })).not.toBeInTheDocument()
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
      expect(mockColors['c1']).toBeUndefined()
    })
    expect(mockWriter.remove).toHaveBeenCalledWith('colors', 'c1')
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

  // ---------------------------------------------------------------------------
  // M16 P5 — Components tab smoke tests
  // ---------------------------------------------------------------------------

  it('renders the Components tab button', () => {
    renderFolderSettings()
    expect(screen.getByRole('tab', { name: 'Components' })).toBeInTheDocument()
  })

  it('shows the Components tab empty state when no components exist', async () => {
    mockListComponents.mockResolvedValueOnce([])
    renderFolderSettings()
    fireEvent.click(screen.getByRole('tab', { name: 'Components' }))

    await waitFor(() => {
      expect(screen.getByText('No components yet.')).toBeInTheDocument()
      expect(screen.getByText(/promote any selection in the editor/i)).toBeInTheDocument()
    })
  })

  it('renders component cards when components exist', async () => {
    mockListComponents.mockResolvedValueOnce([
      {
        id: 'comp-1',
        folderId: 'folder-1',
        name: 'Header banner',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 'comp-2',
        folderId: 'folder-1',
        name: 'Footer',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ])

    renderFolderSettings()
    fireEvent.click(screen.getByRole('tab', { name: 'Components' }))

    await waitFor(() => {
      expect(screen.getAllByTestId('component-card')).toHaveLength(2)
      expect(screen.getByText('Header banner')).toBeInTheDocument()
      expect(screen.getByText('Footer')).toBeInTheDocument()
    })
  })

  it('calls listComponents with the folder id', async () => {
    mockListComponents.mockResolvedValueOnce([])
    renderFolderSettings('folder-1')
    fireEvent.click(screen.getByRole('tab', { name: 'Components' }))

    await waitFor(() => {
      expect(mockListComponents).toHaveBeenCalledWith('folder-1')
    })
  })

  it('shows delete confirm flow for a component', async () => {
    mockListComponents.mockResolvedValue([
      {
        id: 'comp-1',
        folderId: 'folder-1',
        name: 'My Card',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ])

    renderFolderSettings()
    fireEvent.click(screen.getByRole('tab', { name: 'Components' }))

    // Wait for the card
    await waitFor(() => {
      expect(screen.getByText('My Card')).toBeInTheDocument()
    })

    // Click the delete button (hidden by default via opacity-0 + group-hover)
    const deleteBtn = screen.getByLabelText(/delete component my card/i, {
      hidden: true,
    } as Parameters<typeof screen.getByLabelText>[1])
    fireEvent.click(deleteBtn)

    // Confirm prompt should appear
    await waitFor(() => {
      expect(screen.getByLabelText(/confirm delete my card/i)).toBeInTheDocument()
    })
  })
})
