/**
 * pages/FoldersHome.test.tsx
 *
 * M16 P1 — RTL tests for the folders-grid landing page.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { FoldersHome } from './FoldersHome'
import { AuthContext } from '../state/AuthContext'
import type { AuthContextValue, AuthUser } from '../state/AuthContext'
import type { FolderSummary } from '../api/client'

// ---------------------------------------------------------------------------
// Mock useApi
// ---------------------------------------------------------------------------

const mockListFolders = vi.fn()
const mockCreateFolder = vi.fn()
const mockRenameFolder = vi.fn()
const mockDeleteFolder = vi.fn()

const stableApiClient = {
  get listFolders() {
    return mockListFolders
  },
  get createFolder() {
    return mockCreateFolder
  },
  get renameFolder() {
    return mockRenameFolder
  },
  get deleteFolder() {
    return mockDeleteFolder
  },
  listDecks: vi.fn().mockResolvedValue([]),
  createDeck: vi.fn(),
  deleteDeck: vi.fn(),
  moveDecks: vi.fn(),
}

vi.mock('../api/client.js', () => ({
  useApi: () => stableApiClient,
}))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_FOLDERS: FolderSummary[] = [
  { id: 'folder-drafts', name: 'Drafts', deckCount: 2, createdAt: '2026-01-01T00:00:00Z' },
  { id: 'folder-work', name: 'Work', deckCount: 5, createdAt: '2026-01-02T00:00:00Z' },
]

const MOCK_USER: AuthUser = { sub: 'user-1', email: 'test@example.com', name: 'Test User' }

function createMockAuthValue(overrides: Partial<AuthContextValue> = {}): AuthContextValue {
  return {
    user: MOCK_USER,
    token: 'mock-token',
    isLoading: false,
    login: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    refreshToken: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function renderFoldersHome() {
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={createMockAuthValue()}>
        <FoldersHome />
      </AuthContext.Provider>
    </MemoryRouter>,
  )
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  mockListFolders.mockResolvedValue(MOCK_FOLDERS)
  mockCreateFolder.mockResolvedValue({
    id: 'folder-new',
    name: 'New folder',
    deckCount: 0,
    createdAt: '2026-01-03T00:00:00Z',
  } satisfies FolderSummary)
  mockRenameFolder.mockResolvedValue(MOCK_FOLDERS[0])
  mockDeleteFolder.mockResolvedValue(undefined)
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FoldersHome', () => {
  it('renders the Narrative header', () => {
    renderFoldersHome()
    expect(screen.getByText('Narrative')).toBeTruthy()
  })

  it('shows loading state initially', () => {
    // Never-resolving promise to hold in loading state
    mockListFolders.mockReturnValue(new Promise(() => {}))
    renderFoldersHome()
    expect(screen.getByText(/loading folders/i)).toBeTruthy()
  })

  it('renders folder cards after load', async () => {
    renderFoldersHome()
    await waitFor(() => {
      expect(screen.getByText('Drafts')).toBeTruthy()
      expect(screen.getByText('Work')).toBeTruthy()
    })
  })

  it('shows deck count per folder', async () => {
    renderFoldersHome()
    await waitFor(() => {
      expect(screen.getByText('2 decks')).toBeTruthy()
      expect(screen.getByText('5 decks')).toBeTruthy()
    })
  })

  it('shows empty state when no folders', async () => {
    mockListFolders.mockResolvedValue([])
    renderFoldersHome()
    await waitFor(() => {
      expect(screen.getByText(/no folders yet/i)).toBeTruthy()
    })
  })

  it('calls createFolder when "+ New folder" is clicked', async () => {
    renderFoldersHome()
    await waitFor(() => screen.getByText('Drafts'))

    const btn = screen.getByRole('button', { name: /new folder/i })
    fireEvent.click(btn)

    await waitFor(() => {
      expect(mockCreateFolder).toHaveBeenCalledWith('New folder')
    })
  })

  it('shows the new folder inline in edit mode after creation', async () => {
    renderFoldersHome()
    await waitFor(() => screen.getByText('Drafts'))

    fireEvent.click(screen.getByRole('button', { name: /new folder/i }))

    await waitFor(() => {
      // The new folder card should render an editable input
      const inputs = screen.getAllByLabelText('Folder name')
      expect(inputs.length).toBeGreaterThan(0)
    })
  })

  it('shows error message when listFolders fails', async () => {
    mockListFolders.mockRejectedValue(new Error('Network error'))
    renderFoldersHome()
    await waitFor(() => {
      expect(screen.getByText(/network error/i)).toBeTruthy()
    })
  })

  it('calls renameFolder via kebab menu → Rename', async () => {
    renderFoldersHome()
    await waitFor(() => screen.getByText('Work'))

    // Open the kebab for "Work" folder
    const kebabs = screen.getAllByLabelText('Folder options')
    // Second folder card = "Work"
    fireEvent.click(kebabs[1]!)

    await waitFor(() => {
      const renameBtn = screen
        .getAllByRole('menuitem')
        .find((el) => el.textContent?.includes('Rename'))
      expect(renameBtn).toBeTruthy()
      fireEvent.click(renameBtn!)
    })

    // Should enter inline edit mode
    await waitFor(() => {
      const inputs = screen.getAllByLabelText('Folder name')
      expect(inputs.length).toBeGreaterThan(0)
    })
  })

  it('calls deleteFolder after confirming delete via kebab menu', async () => {
    renderFoldersHome()
    await waitFor(() => screen.getByText('Work'))

    const kebabs = screen.getAllByLabelText('Folder options')
    fireEvent.click(kebabs[1]!)

    // First click shows "Delete", second confirms
    await waitFor(() => {
      const items = screen.getAllByRole('menuitem')
      const deleteBtn = items.find((el) => el.textContent?.trim() === 'Delete')
      expect(deleteBtn).toBeTruthy()
      fireEvent.click(deleteBtn!)
    })

    await waitFor(() => {
      const items = screen.getAllByRole('menuitem')
      const confirmBtn = items.find((el) => el.textContent?.includes('Confirm delete'))
      expect(confirmBtn).toBeTruthy()
      fireEvent.click(confirmBtn!)
    })

    await waitFor(() => {
      expect(mockDeleteFolder).toHaveBeenCalledWith('folder-work')
    })
  })

  it('shows non-empty folder modal when deleteFolder returns 409', async () => {
    mockDeleteFolder.mockRejectedValue(Object.assign(new Error('HTTP 409'), { status: 409 }))
    renderFoldersHome()
    await waitFor(() => screen.getByText('Work'))

    const kebabs = screen.getAllByLabelText('Folder options')
    fireEvent.click(kebabs[1]!)

    await waitFor(() => {
      const items = screen.getAllByRole('menuitem')
      const deleteBtn = items.find((el) => el.textContent?.trim() === 'Delete')
      fireEvent.click(deleteBtn!)
    })

    await waitFor(() => {
      const items = screen.getAllByRole('menuitem')
      const confirmBtn = items.find((el) => el.textContent?.includes('Confirm delete'))
      fireEvent.click(confirmBtn!)
    })

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /cannot delete folder/i })).toBeTruthy()
    })
  })

  it('renders user name in header', async () => {
    renderFoldersHome()
    await waitFor(() => {
      expect(screen.getByText('Test User')).toBeTruthy()
    })
  })
})
