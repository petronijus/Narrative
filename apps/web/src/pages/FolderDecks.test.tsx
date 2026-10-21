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
// Mock the sync server connection: the page mounts FolderDocProvider, which
// would otherwise open a real WebSocket in jsdom. That socket's handshake
// finishes after the test file ends and vitest reports it as an unhandled
// rejection (`_cookieJar` of null), failing the whole run intermittently.
// ---------------------------------------------------------------------------

vi.mock('@hocuspocus/provider', () => ({
  HocuspocusProvider: class {
    on() {}
    off() {}
    attach() {}
    destroy() {}
  },
  HocuspocusProviderWebsocket: class {
    destroy() {}
  },
}))

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
const mockListDecksPage = vi.fn()
const mockCreateDeck = vi.fn()
const mockDeleteDeck = vi.fn()
const mockRenameDeck = vi.fn()
const mockMoveDecks = vi.fn()
const mockDuplicateDeck = vi.fn()
const mockListShareLinks = vi.fn().mockResolvedValue([])

const stableApiClient = {
  get listFolders() {
    return mockListFolders
  },
  get listDecksPage() {
    return mockListDecksPage
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
  get duplicateDeck() {
    return mockDuplicateDeck
  },
  get listShareLinks() {
    return mockListShareLinks
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
    id: FOLDER_ID,
    name: 'Work',
    deckCount: 2,
    createdAt: '2026-01-02T00:00:00Z',
    role: 'owner',
    sharedBy: null,
    isDrafts: false,
  },
]

const MOCK_DECKS: DeckSummary[] = [
  {
    id: 'deck-1',
    title: 'Q1 Review',
    ownerUserId: 'user-1',
    folderId: FOLDER_ID,
    createdAt: '2026-01-10T00:00:00Z',
    updatedAt: '2026-01-15T00:00:00Z',
    viewerRole: 'owner',
  },
  {
    id: 'deck-2',
    title: 'Roadmap 2026',
    ownerUserId: 'user-1',
    folderId: FOLDER_ID,
    createdAt: '2026-01-11T00:00:00Z',
    updatedAt: '2026-01-16T00:00:00Z',
    viewerRole: 'owner',
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

function renderFolderDecks(folderId = FOLDER_ID) {
  return render(
    <MemoryRouter initialEntries={[`/folder/${folderId}`]}>
      <AuthContext value={createMockAuthValue()}>
        <Routes>
          <Route path="/folder/:folderId" element={<FolderDecks />} />
          <Route path="/" element={<div>Home</div>} />
        </Routes>
      </AuthContext>
    </MemoryRouter>,
  )
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  mockListFolders.mockResolvedValue(MOCK_FOLDERS)
  mockListDecksPage.mockResolvedValue({ decks: MOCK_DECKS, nextCursor: null })
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
    mockListDecksPage.mockReturnValue(new Promise(() => {}))
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

  it("loads the rest of a folder's decks behind the first page, in order", async () => {
    mockListDecksPage
      .mockResolvedValueOnce({ decks: [MOCK_DECKS[0]], nextCursor: 'after-1' })
      .mockResolvedValueOnce({ decks: [MOCK_DECKS[1]], nextCursor: null })
    renderFolderDecks()
    await waitFor(() => {
      expect(screen.getByText('Q1 Review')).toBeTruthy()
      expect(screen.getByText('Roadmap 2026')).toBeTruthy()
    })
    expect(mockListDecksPage.mock.calls.map((c) => c[0])).toEqual([
      { folderId: FOLDER_ID, limit: 60 },
      { folderId: FOLDER_ID, limit: 60, cursor: 'after-1' },
    ])
  })

  it('shows empty state when folder has no decks', async () => {
    mockListDecksPage.mockResolvedValue({ decks: [], nextCursor: null })
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

  it('duplicates a deck and shows the copy right after its original', async () => {
    mockDuplicateDeck.mockResolvedValue({
      ...MOCK_DECKS[0]!,
      id: 'deck-1-copy',
      title: 'Q1 Review (copy)',
    })
    renderFolderDecks()
    await waitFor(() => screen.getByText('Q1 Review'))

    fireEvent.click(screen.getAllByLabelText('Deck options')[0]!)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }))

    await waitFor(() => screen.getByText('Q1 Review (copy)'))
    expect(mockDuplicateDeck).toHaveBeenCalledWith('deck-1')
    const titles = screen
      .getAllByTitle('Double-click to rename')
      .map((el) => el.textContent?.trim())
    expect(titles).toEqual(['Q1 Review', 'Q1 Review (copy)', 'Roadmap 2026'])
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

    // Confirm, once the share-link check has let the button go.
    const moveHereBtn = screen.getByRole('button', { name: 'Move here' })
    await waitFor(() => expect(moveHereBtn).not.toBeDisabled())
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
