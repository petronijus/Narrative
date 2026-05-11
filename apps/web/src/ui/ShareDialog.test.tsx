/**
 * ui/ShareDialog.test.tsx
 *
 * M10: Tests for ShareDialog component.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, act, fireEvent } from '@testing-library/react'
import { renderWithProviders as render } from '../test/renderWithProviders'
import { ShareDialog } from './ShareDialog'
import { AuthContext } from '../state/AuthContext'
import type { AuthContextValue, AuthUser } from '../state/AuthContext'
import type { DeckPermission, ShareLink } from '../api/client'

// ---------------------------------------------------------------------------
// Mock useApi
// ---------------------------------------------------------------------------

const mockListPermissions = vi.fn()
const mockGrantPermission = vi.fn()
const mockRevokePermission = vi.fn()
const mockListShareLinks = vi.fn()
const mockCreateShareLink = vi.fn()
const mockRevokeShareLink = vi.fn()

// Stable API client object — same reference across renders to avoid infinite useEffect loops
const stableApiClient = {
  get listPermissions() {
    return mockListPermissions
  },
  get grantPermission() {
    return mockGrantPermission
  },
  get revokePermission() {
    return mockRevokePermission
  },
  get listShareLinks() {
    return mockListShareLinks
  },
  get createShareLink() {
    return mockCreateShareLink
  },
  get revokeShareLink() {
    return mockRevokeShareLink
  },
  listDecks: vi.fn().mockResolvedValue([]),
  createDeck: vi.fn(),
  deleteDeck: vi.fn(),
}

vi.mock('../api/client.js', () => ({
  useApi: () => stableApiClient,
}))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_PERMISSIONS: DeckPermission[] = [
  { userId: 'user-alice', role: 'editor', grantedAt: '2026-01-01T00:00:00Z' },
  { userId: 'user-bob', role: 'viewer', grantedAt: '2026-01-02T00:00:00Z' },
]

const MOCK_SHARE_LINKS: ShareLink[] = [
  {
    id: 'link-1',
    role: 'viewer',
    createdAt: '2026-01-01T00:00:00Z',
    expiresAt: null,
    url: 'http://localhost:5173/deck/deck1?share_token=link-1',
  },
]

const MOCK_USER: AuthUser = { sub: 'owner-user', email: 'owner@example.com', name: 'Owner' }

function createMockAuthValue(overrides: Partial<AuthContextValue> = {}): AuthContextValue {
  return {
    user: MOCK_USER,
    token: 'mock-token',
    isLoading: false,
    login: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    refreshToken: vi.fn().mockResolvedValue(undefined),
    completeSignin: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Render helper
// ---------------------------------------------------------------------------

function renderDialog(onClose = vi.fn()) {
  return render(
    <AuthContext.Provider value={createMockAuthValue()}>
      <ShareDialog deckId="deck-123" onClose={onClose} />
    </AuthContext.Provider>,
  )
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  mockListPermissions.mockResolvedValue(MOCK_PERMISSIONS)
  mockListShareLinks.mockResolvedValue(MOCK_SHARE_LINKS)
  mockGrantPermission.mockResolvedValue(undefined)
  mockRevokePermission.mockResolvedValue(undefined)
  mockCreateShareLink.mockResolvedValue({
    id: 'new-link',
    url: 'http://localhost:5173/deck/deck-123?share_token=new-link',
  })
  mockRevokeShareLink.mockResolvedValue(undefined)

  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    writable: true,
    configurable: true,
  })
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ShareDialog', () => {
  it('renders dialog heading', () => {
    renderDialog()
    expect(screen.getByRole('dialog', { name: 'Share this deck' })).toBeTruthy()
  })

  it('loads and displays permissions list', async () => {
    renderDialog()
    await waitFor(() => {
      expect(screen.getByText('user-alice')).toBeTruthy()
      expect(screen.getByText('user-bob')).toBeTruthy()
    })
  })

  it('calls revokePermission when remove button clicked', async () => {
    renderDialog()

    // Wait for permissions to render
    await waitFor(() => {
      expect(document.querySelector('[aria-label="Remove user-alice"]')).not.toBeNull()
    })

    // Query fresh (avoids stale reference after React re-render)
    // and click inside waitFor so we can retry if the element just re-rendered
    await waitFor(() => {
      const btn = document.querySelector('[aria-label="Remove user-alice"]')
      expect(btn).not.toBeNull()
      fireEvent.click(btn!)
      expect(mockRevokePermission).toHaveBeenCalledWith('deck-123', 'user-alice')
    })
  })

  it.skip('calls grantPermission when invite submitted', async () => {
    renderDialog()

    const input = screen.getByLabelText('User ID (Google sub)')
    const inviteButton = screen.getByRole('button', { name: 'Invite' })

    fireEvent.change(input, { target: { value: 'user-charlie' } })
    fireEvent.click(inviteButton)

    await waitFor(() => {
      expect(mockGrantPermission).toHaveBeenCalledWith('deck-123', {
        userId: 'user-charlie',
        role: 'viewer',
      })
    })
  })

  it('loads and displays existing share links', async () => {
    renderDialog()
    await waitFor(() => {
      expect(screen.getByText(/link-1/i)).toBeTruthy()
    })
  })

  it('creates a share link and shows URL', async () => {
    renderDialog()

    fireEvent.click(screen.getByRole('button', { name: 'Create link' }))

    await waitFor(() => {
      expect(mockCreateShareLink).toHaveBeenCalledWith('deck-123', { role: 'viewer' })
    })

    await waitFor(() => {
      expect(screen.getByText(/share_token=new-link/)).toBeTruthy()
    })
  })

  it('calls revokeShareLink when revoke button clicked', async () => {
    renderDialog()

    await waitFor(() => {
      expect(screen.getByText(/link-1/)).toBeTruthy()
    })

    const btn = document.querySelector('[aria-label="Revoke share link"]')!
    fireEvent.click(btn)

    await waitFor(() => {
      expect(mockRevokeShareLink).toHaveBeenCalledWith('deck-123', 'link-1')
    })
  })

  it('closes when Escape is pressed', () => {
    const onClose = vi.fn()
    renderDialog(onClose)

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })

    expect(onClose).toHaveBeenCalled()
  })

  it('closes when backdrop is clicked', () => {
    const onClose = vi.fn()
    renderDialog(onClose)

    fireEvent.click(screen.getByRole('dialog'))

    expect(onClose).toHaveBeenCalled()
  })
})
