/**
 * state/AuthContext.test.tsx
 *
 * M10: Tests for AuthContext / AuthProvider / useAuth.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AuthProvider, useAuth } from './AuthContext'

// ---------------------------------------------------------------------------
// Mock oidc-client-ts UserManager
// ---------------------------------------------------------------------------

const mockGetUser = vi.fn()
const mockSigninRedirect = vi.fn()
const mockSignoutRedirect = vi.fn()
const mockSigninSilent = vi.fn()
const mockEventsAddUserLoaded = vi.fn()
const mockEventsAddUserUnloaded = vi.fn()
const mockEventsAddSilentRenewError = vi.fn()
const mockEventsRemoveUserLoaded = vi.fn()
const mockEventsRemoveUserUnloaded = vi.fn()
const mockEventsRemoveSilentRenewError = vi.fn()

const mockUserManager = {
  getUser: mockGetUser,
  signinRedirect: mockSigninRedirect,
  signoutRedirect: mockSignoutRedirect,
  signinSilent: mockSigninSilent,
  events: {
    addUserLoaded: mockEventsAddUserLoaded,
    addUserUnloaded: mockEventsAddUserUnloaded,
    addSilentRenewError: mockEventsAddSilentRenewError,
    removeUserLoaded: mockEventsRemoveUserLoaded,
    removeUserUnloaded: mockEventsRemoveUserUnloaded,
    removeSilentRenewError: mockEventsRemoveSilentRenewError,
  },
}

vi.mock('oidc-client-ts', () => ({
  UserManager: vi.fn(() => mockUserManager),
}))

// ---------------------------------------------------------------------------
// Test component
// ---------------------------------------------------------------------------

function AuthReadout() {
  const { user, token, isLoading } = useAuth()
  return (
    <div>
      <span data-testid="loading">{String(isLoading)}</span>
      <span data-testid="user-sub">{user?.sub ?? 'null'}</span>
      <span data-testid="token">{token !== null ? 'has-token' : 'no-token'}</span>
    </div>
  )
}

function LoginButton() {
  const { login } = useAuth()
  return <button onClick={() => void login()}>Login</button>
}

function LogoutButton() {
  const { logout } = useAuth()
  return <button onClick={() => void logout()}>Logout</button>
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  // Default: no user in storage
  mockGetUser.mockResolvedValue(null)
  mockSigninRedirect.mockResolvedValue(undefined)
  mockSignoutRedirect.mockResolvedValue(undefined)
  mockSigninSilent.mockResolvedValue(null)
  // Events are fire-and-forget in tests
  mockEventsAddUserLoaded.mockImplementation(() => {})
  mockEventsAddUserUnloaded.mockImplementation(() => {})
  mockEventsAddSilentRenewError.mockImplementation(() => {})
  mockEventsRemoveUserLoaded.mockImplementation(() => {})
  mockEventsRemoveUserUnloaded.mockImplementation(() => {})
  mockEventsRemoveSilentRenewError.mockImplementation(() => {})
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AuthProvider', () => {
  it('resolves to user=null, isLoading=false when no session exists', async () => {
    render(
      <AuthProvider>
        <AuthReadout />
      </AuthProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false')
    })
    expect(screen.getByTestId('user-sub').textContent).toBe('null')
    expect(screen.getByTestId('token').textContent).toBe('no-token')
  })

  it('restores user from existing session on mount', async () => {
    mockGetUser.mockResolvedValue({
      profile: { sub: 'user-123', email: 'test@example.com', name: 'Test User' },
      access_token: 'access-token-abc',
      expired: false,
    })

    render(
      <AuthProvider>
        <AuthReadout />
      </AuthProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('user-sub').textContent).toBe('user-123')
    })
    expect(screen.getByTestId('token').textContent).toBe('has-token')
    expect(screen.getByTestId('loading').textContent).toBe('false')
  })

  it('treats expired session as no user', async () => {
    mockGetUser.mockResolvedValue({
      profile: { sub: 'user-123' },
      access_token: 'old-token',
      expired: true,
    })

    render(
      <AuthProvider>
        <AuthReadout />
      </AuthProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false')
    })
    expect(screen.getByTestId('user-sub').textContent).toBe('null')
  })

  it('handles getUser error gracefully — user=null, isLoading=false', async () => {
    mockGetUser.mockRejectedValue(new Error('storage error'))

    render(
      <AuthProvider>
        <AuthReadout />
      </AuthProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false')
    })
    expect(screen.getByTestId('user-sub').textContent).toBe('null')
  })
})

describe('useAuth actions', () => {
  it('login() calls signinRedirect', async () => {
    const user = userEvent.setup()
    mockGetUser.mockResolvedValue(null)

    render(
      <AuthProvider>
        <LoginButton />
      </AuthProvider>,
    )

    await act(async () => {
      await user.click(screen.getByRole('button', { name: 'Login' }))
    })

    expect(mockSigninRedirect).toHaveBeenCalledOnce()
  })

  it('logout() calls signoutRedirect', async () => {
    const user = userEvent.setup()
    mockGetUser.mockResolvedValue(null)

    render(
      <AuthProvider>
        <LogoutButton />
      </AuthProvider>,
    )

    await act(async () => {
      await user.click(screen.getByRole('button', { name: 'Logout' }))
    })

    expect(mockSignoutRedirect).toHaveBeenCalledOnce()
  })
})

describe('useAuth outside provider', () => {
  it('throws when called outside AuthProvider', () => {
    // Suppress console.error for this expected throw
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => {
      render(<AuthReadout />)
    }).toThrow('useAuth must be used inside <AuthProvider>')
    consoleSpy.mockRestore()
  })
})
