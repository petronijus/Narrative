/**
 * pages/FoldersHome.test.tsx
 *
 * M16 P1 — RTL tests for the folders-grid landing page.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, fireEvent, within } from '@testing-library/react'
import { renderWithProviders as render } from '../test/renderWithProviders'
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
  {
    id: 'folder-drafts',
    name: 'Drafts',
    deckCount: 2,
    createdAt: '2026-01-01T00:00:00Z',
    role: 'owner',
    sharedBy: null,
    isDrafts: true,
  },
  {
    id: 'folder-work',
    name: 'Work',
    deckCount: 5,
    createdAt: '2026-01-02T00:00:00Z',
    role: 'owner',
    sharedBy: null,
    isDrafts: false,
  },
]

const MOCK_USER: AuthUser = { sub: 'user-1', email: 'test@example.com', name: 'Test User' }

function createMockAuthValue(overrides: Partial<AuthContextValue> = {}): AuthContextValue {
  return {
    user: MOCK_USER,
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function renderFoldersHome() {
  return render(
    <MemoryRouter>
      <AuthContext value={createMockAuthValue()}>
        <FoldersHome />
      </AuthContext>
    </MemoryRouter>,
    { providers: { router: false, auth: false } },
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
    role: 'owner',
    sharedBy: null,
    isDrafts: false,
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

  /** Open a folder's menu, choose Delete, and return the confirming item. */
  async function startDelete(folderName: string): Promise<HTMLElement> {
    let card: HTMLElement | null = await screen.findByText(folderName)
    while (card !== null && card.querySelector('button[aria-label="Folder options"]') === null) {
      card = card.parentElement
    }
    fireEvent.click(within(card!).getByRole('button', { name: 'Folder options' }))
    fireEvent.click(within(card!).getByRole('menuitem', { name: 'Delete' }))
    return within(card!).getByRole('menuitem', { name: /Delete folder \+ 5 decks/ })
  }

  it('deletes a folder after a confirm step that says how many decks go with it', async () => {
    mockDeleteFolder.mockResolvedValue(undefined)
    renderFoldersHome()

    const confirm = await startDelete('Work')
    expect(mockDeleteFolder).not.toHaveBeenCalled()
    fireEvent.click(confirm)

    await waitFor(() => {
      expect(mockDeleteFolder).toHaveBeenCalledWith('folder-work')
    })
  })

  it('explains a refused delete (409, the server keeps Drafts) in a dialog', async () => {
    mockDeleteFolder.mockRejectedValue(Object.assign(new Error('HTTP 409'), { status: 409 }))
    renderFoldersHome()

    fireEvent.click(await startDelete('Work'))

    expect(await screen.findByRole('dialog', { name: /cannot delete folder/i })).toBeTruthy()
  })

  it('renders user name in header', async () => {
    renderFoldersHome()
    await waitFor(() => {
      expect(screen.getByText('Test User')).toBeTruthy()
    })
  })
})
