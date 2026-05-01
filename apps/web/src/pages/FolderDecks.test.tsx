/**
 * pages/FolderDecks.test.tsx
 *
 * M16 P1 — RTL tests for the folder-scoped deck grid.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { FolderDecks } from './FolderDecks'
import { AuthContext } from '../state/AuthContext'
import type { AuthContextValue, AuthUser } from '../state/AuthContext'
import type { DeckSummary, FolderSummary } from '../api/client'

// ---------------------------------------------------------------------------
// Mock deckThumbnailCache
// ---------------------------------------------------------------------------

vi.mock('../state/deckThumbnailCache.js', () => ({
  getAllDeckThumbnails: () => ({}),
  deleteDeckThumbnail: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Mock useApi
// ---------------------------------------------------------------------------

const mockListFolders = vi.fn()
const mockListDecks = vi.fn()
const mockCreateDeck = vi.fn()
const mockDeleteDeck = vi.fn()
const mockRenameDeck = vi.fn()
const mockMoveDecks = vi.fn()

const stableApiClient = {
  get listFolders() {
    return mockListFolders
  },
  get listDecks() {
    return mockListDecks
  },
  get createDeck() {
    return mockCreateDeck
  },
  get deleteDeck() {
    return mockDeleteDeck
  },
  get renameDeck() {
    return mockRenameDeck
  },
  get moveDecks() {
    return mockMoveDecks
  },
}

vi.mock('../api/client.js', () => ({
  useApi: () => stableApiClient,
}))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FOLDER_ID = 'folder-work'

const MOCK_FOLDERS: FolderSummary[] = [
  { id: 'folder-drafts', name: 'Drafts', deckCount: 2, createdAt: '2026-01-01T00:00:00Z' },
  { id: FOLDER_ID, name: 'Work', deckCount: 2, createdAt: '2026-01-02T00:00:00Z' },
]

const MOCK_DECKS: DeckSummary[] = [
  {
    id: 'deck-1',
    title: 'Q1 Review',
    ownerUserId: 'user-1',
    folderId: FOLDER_ID,
    createdAt: '2026-01-10T00:00:00Z',
    updatedAt: '2026-01-15T00:00:00Z',
  },
  {
    id: 'deck-2',
    title: 'Roadmap 2026',
    ownerUserId: 'user-1',
    folderId: FOLDER_ID,
    createdAt: '2026-01-11T00:00:00Z',
    updatedAt: '2026-01-16T00:00:00Z',
  },
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

function renderFolderDecks(folderId = FOLDER_ID) {
  return render(
    <MemoryRouter initialEntries={[`/folder/${folderId}`]}>
      <AuthContext.Provider value={createMockAuthValue()}>
        <Routes>
          <Route path="/folder/:folderId" element={<FolderDecks />} />
          <Route path="/" element={<div>Home</div>} />
        </Routes>
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
  mockListDecks.mockResolvedValue(MOCK_DECKS)
  mockCreateDeck.mockResolvedValue({
    id: 'deck-new',
    title: 'Untitled Deck',
    folderId: FOLDER_ID,
    ownerUserId: 'user-1',
    createdAt: '',
    updatedAt: '',
  })
  mockDeleteDeck.mockResolvedValue(undefined)
  mockRenameDeck.mockResolvedValue(MOCK_DECKS[0])
  mockMoveDecks.mockResolvedValue({ movedCount: 1 })
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FolderDecks', () => {
  it('renders the breadcrumb with folder name', async () => {
    renderFolderDecks()
    await waitFor(() => {
      expect(screen.getByText('All folders')).toBeTruthy()
      expect(screen.getByText('Work')).toBeTruthy()
    })
  })

  it('shows loading state', () => {
    mockListFolders.mockReturnValue(new Promise(() => {}))
    mockListDecks.mockReturnValue(new Promise(() => {}))
    renderFolderDecks()
    expect(screen.getByText(/loading decks/i)).toBeTruthy()
  })

  it('renders deck cards after load', async () => {
    renderFolderDecks()
    await waitFor(() => {
      expect(screen.getByText('Q1 Review')).toBeTruthy()
      expect(screen.getByText('Roadmap 2026')).toBeTruthy()
    })
  })

  it('shows empty state when folder has no decks', async () => {
    mockListDecks.mockResolvedValue([])
    renderFolderDecks()
    await waitFor(() => {
      expect(screen.getByText(/no decks in this folder yet/i)).toBeTruthy()
    })
  })

  it('redirects to / for an unknown folderId', async () => {
    mockListFolders.mockResolvedValue(MOCK_FOLDERS) // doesn't contain 'unknown'
    renderFolderDecks('unknown-folder-id')
    await waitFor(() => {
      expect(screen.getByText('Home')).toBeTruthy()
    })
  })

  it('calls deleteDeck on confirm-delete in deck kebab menu', async () => {
    renderFolderDecks()
    await waitFor(() => screen.getByText('Q1 Review'))

    const kebabs = screen.getAllByLabelText('Deck options')
    fireEvent.click(kebabs[0]!)

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
      expect(mockDeleteDeck).toHaveBeenCalledWith('deck-1')
    })
  })

  it('calls moveDecks and removes deck from list on move confirm', async () => {
    renderFolderDecks()
    await waitFor(() => screen.getByText('Q1 Review'))

    // Open kebab → Move to…
    const kebabs = screen.getAllByLabelText('Deck options')
    fireEvent.click(kebabs[0]!)

    await waitFor(() => {
      const items = screen.getAllByRole('menuitem')
      const moveBtn = items.find((el) => el.textContent?.includes('Move to'))
      expect(moveBtn).toBeTruthy()
      fireEvent.click(moveBtn!)
    })

    // Modal should appear with "Drafts" as only option (current folder is Work)
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /move deck to folder/i })).toBeTruthy()
      expect(screen.getByText('Drafts')).toBeTruthy()
    })

    // Confirm
    const moveHereBtn = screen.getByRole('button', { name: 'Move here' })
    fireEvent.click(moveHereBtn)

    await waitFor(() => {
      expect(mockMoveDecks).toHaveBeenCalledWith(FOLDER_ID, ['deck-1'], 'folder-drafts')
    })

    // Deck should be removed from the list optimistically
    await waitFor(() => {
      expect(screen.queryByText('Q1 Review')).toBeNull()
    })
  })

  it('entering rename mode from kebab shows inline input', async () => {
    renderFolderDecks()
    await waitFor(() => screen.getByText('Q1 Review'))

    const kebabs = screen.getAllByLabelText('Deck options')
    fireEvent.click(kebabs[0]!)

    await waitFor(() => {
      const items = screen.getAllByRole('menuitem')
      const renameBtn = items.find((el) => el.textContent?.includes('Rename'))
      expect(renameBtn).toBeTruthy()
      fireEvent.click(renameBtn!)
    })

    await waitFor(() => {
      expect(screen.getByLabelText('Deck title')).toBeTruthy()
    })
  })

  it('calls renameDeck when deck title input is committed', async () => {
    renderFolderDecks()
    await waitFor(() => screen.getByText('Q1 Review'))

    // Double-click the title to enter edit mode
    const title = screen.getByText('Q1 Review')
    fireEvent.dblClick(title)

    const input = screen.getByLabelText('Deck title')
    fireEvent.change(input, { target: { value: 'Q1 Final' } })
    fireEvent.blur(input)

    await waitFor(() => {
      expect(mockRenameDeck).toHaveBeenCalledWith('deck-1', 'Q1 Final')
    })
  })

  it('clicking folder name in breadcrumb enters rename mode', async () => {
    renderFolderDecks()
    await waitFor(() => screen.getByText('Work'))

    const folderNameBtn = screen.getByLabelText('Rename folder (click to edit)')
    fireEvent.click(folderNameBtn)

    await waitFor(() => {
      expect(screen.getByLabelText('Folder name')).toBeTruthy()
    })
  })
})
