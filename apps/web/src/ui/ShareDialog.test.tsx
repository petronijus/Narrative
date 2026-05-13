/**
 * ui/ShareDialog.test.tsx
 *
 * Tests for ShareDialog component. Updated for 0.7.0 sharing rework:
 * invite-by-email, enriched permissions (email + name), pending invites.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, act, fireEvent } from '@testing-library/react'
import { renderWithProviders as render } from '../test/renderWithProviders'
import { ShareDialog } from './ShareDialog'
import { AuthContext } from '../state/AuthContext'
import type { AuthContextValue, AuthUser } from '../state/AuthContext'
import type { DeckInvite, DeckPermission, ShareLink } from '../api/client'

// ---------------------------------------------------------------------------
// Mock useApi
// ---------------------------------------------------------------------------

const mockListPermissions = vi.fn()
const mockInviteByEmail = vi.fn()
const mockRevokePermission = vi.fn()
const mockListInvites = vi.fn()
const mockRevokeInvite = vi.fn()
const mockListShareLinks = vi.fn()
const mockCreateShareLink = vi.fn()
const mockRevokeShareLink = vi.fn()

// Stable API client object — same reference across renders to avoid infinite useEffect loops
const stableApiClient = {
  get listPermissions() {
    return mockListPermissions
  },
  get inviteByEmail() {
    return mockInviteByEmail
  },
  get revokePermission() {
    return mockRevokePermission
  },
  get listInvites() {
    return mockListInvites
  },
  get revokeInvite() {
    return mockRevokeInvite
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
  {
    userId: 'user-alice',
    role: 'editor',
    grantedAt: '2026-01-01T00:00:00Z',
    email: 'alice@example.com',
    name: 'Alice Adams',
  },
  {
    userId: 'user-bob',
    role: 'viewer',
    grantedAt: '2026-01-02T00:00:00Z',
    email: 'bob@example.com',
    name: 'Bob Brown',
  },
]

const MOCK_INVITES: DeckInvite[] = []

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
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn().mockResolvedValue(undefined),
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
  mockListInvites.mockResolvedValue(MOCK_INVITES)
  mockListShareLinks.mockResolvedValue(MOCK_SHARE_LINKS)
  mockInviteByEmail.mockResolvedValue({
    kind: 'granted',
    user: {
      userId: 'user-charlie',
      email: 'charlie@example.com',
      name: 'Charlie',
      role: 'editor',
    },
  })
  mockRevokePermission.mockResolvedValue(undefined)
  mockRevokeInvite.mockResolvedValue(undefined)
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

  it('loads and displays permissions list — by name, not sub', async () => {
    renderDialog()
    await waitFor(() => {
      expect(screen.getByText('Alice Adams')).toBeTruthy()
      expect(screen.getByText('Bob Brown')).toBeTruthy()
    })
    // The opaque Google sub should NOT appear anywhere visible.
    expect(screen.queryByText('user-alice')).toBeNull()
    expect(screen.queryByText('user-bob')).toBeNull()
  })

  it('calls revokePermission when remove button clicked', async () => {
    renderDialog()

    await waitFor(() => {
      expect(document.querySelector('[aria-label="Remove Alice Adams"]')).not.toBeNull()
    })

    await waitFor(() => {
      const btn = document.querySelector('[aria-label="Remove Alice Adams"]')
      expect(btn).not.toBeNull()
      fireEvent.click(btn!)
      expect(mockRevokePermission).toHaveBeenCalledWith('deck-123', 'user-alice')
    })
  })

  it('calls inviteByEmail when invite submitted with a valid email', async () => {
    renderDialog()

    const input = await screen.findByLabelText('Invite by email')
    const inviteButton = screen.getByRole('button', { name: 'Invite' })

    fireEvent.change(input, { target: { value: 'charlie@example.com' } })
    fireEvent.click(inviteButton)

    await waitFor(() => {
      expect(mockInviteByEmail).toHaveBeenCalledWith('deck-123', {
        email: 'charlie@example.com',
        role: 'viewer',
      })
    })
  })

  it('rejects invalid email addresses client-side', async () => {
    renderDialog()

    const input = await screen.findByLabelText('Invite by email')
    const inviteButton = screen.getByRole('button', { name: 'Invite' })

    fireEvent.change(input, { target: { value: 'not-an-email' } })
    fireEvent.click(inviteButton)

    await waitFor(() => {
      expect(screen.getByText('Please enter a valid email address.')).toBeTruthy()
    })
    expect(mockInviteByEmail).not.toHaveBeenCalled()
  })

  it('renders pending invites section and revokes them', async () => {
    mockListInvites.mockResolvedValue([
      {
        id: 'inv-1',
        email: 'pending@example.com',
        role: 'editor',
        invitedAt: '2026-05-13T00:00:00Z',
        expiresAt: '2026-06-12T00:00:00Z',
      },
    ] satisfies DeckInvite[])

    renderDialog()

    await waitFor(() => {
      expect(screen.getByText('pending@example.com')).toBeTruthy()
    })

    const cancelBtn = document.querySelector('[aria-label="Cancel invite for pending@example.com"]')
    expect(cancelBtn).not.toBeNull()
    fireEvent.click(cancelBtn!)

    await waitFor(() => {
      expect(mockRevokeInvite).toHaveBeenCalledWith('deck-123', 'inv-1')
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
