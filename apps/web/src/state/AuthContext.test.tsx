/**
 * state/AuthContext.test.tsx
 *
 * Tests for the session-cookie AuthProvider (post-2026-05 cutover from
 * the browser-PKCE flow). Covers:
 *   - On mount: /auth/me OK → user populated, isLoading → false.
 *   - On mount: /auth/me 401 → user=null, isLoading → false.
 *   - On mount: /auth/me network error → user=null, isLoading → false.
 *   - login() triggers a top-level navigation to /auth/start?returnTo=...
 *   - logout() POSTs /auth/logout, then navigates to /auth/login.
 *   - Bypass mode synthesises dev-user without any fetch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { AuthProvider, useAuth } from './AuthContext'

beforeEach(() => {
  vi.unstubAllEnvs()
  vi.stubEnv('VITE_BYPASS_AUTH', 'false')
  vi.stubEnv('VITE_API_URL', 'http://api.test')
})

// ---------------------------------------------------------------------------
// Test components
// ---------------------------------------------------------------------------

function AuthReadout() {
  const { user, isLoading } = useAuth()
  return (
    <div>
      <span data-testid="loading">{String(isLoading)}</span>
      <span data-testid="user-sub">{user?.sub ?? 'null'}</span>
      <span data-testid="user-email">{user?.email ?? 'null'}</span>
    </div>
  )
}

function LoginButton() {
  const { login } = useAuth()
  return <button onClick={() => login('/dest')}>Login</button>
}

function LogoutButton() {
  const { logout } = useAuth()
  return <button onClick={() => void logout()}>Logout</button>
}

// ---------------------------------------------------------------------------
// fetch + window.location stubs
// ---------------------------------------------------------------------------

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(impl as unknown as typeof fetch))
}

function stubLocationAssign(): ReturnType<typeof vi.fn> {
  const assign = vi.fn()
  // jsdom's window.location is mostly read-only; replace it wholesale.
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { assign, pathname: '/', search: '' },
  })
  return assign
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

// ---------------------------------------------------------------------------
// Mount-time /auth/me
// ---------------------------------------------------------------------------

describe('AuthProvider — /auth/me on mount', () => {
  it('populates the user when /auth/me returns 200', async () => {
    stubFetch(async () => jsonResponse(200, { sub: 'user-1', email: 'a@b.c', name: 'Alice' }))

    render(
      <AuthProvider>
        <AuthReadout />
      </AuthProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false')
    })
    expect(screen.getByTestId('user-sub').textContent).toBe('user-1')
    expect(screen.getByTestId('user-email').textContent).toBe('a@b.c')
  })

  it('treats 401 as logged-out', async () => {
    stubFetch(async () => jsonResponse(401, { error: 'unauthenticated' }))

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

  it('treats a network error as logged-out', async () => {
    stubFetch(async () => {
      throw new Error('network')
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
})

// ---------------------------------------------------------------------------
// login()
// ---------------------------------------------------------------------------

describe('AuthProvider — login()', () => {
  it('navigates to /auth/start with the returnTo query param', async () => {
    stubFetch(async () => jsonResponse(401, {}))
    const assign = stubLocationAssign()

    render(
      <AuthProvider>
        <LoginButton />
        <AuthReadout />
      </AuthProvider>,
    )

    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'))

    act(() => {
      screen.getByText('Login').click()
    })

    expect(assign).toHaveBeenCalledTimes(1)
    const url = new URL(assign.mock.calls[0]![0] as string)
    expect(url.pathname).toBe('/auth/start')
    expect(url.searchParams.get('returnTo')).toBe('/dest')
  })

  it('inside the desktop app, asks the shell to sign in through the system browser', async () => {
    stubFetch(async () => jsonResponse(401, {}))
    const assign = stubLocationAssign()
    const signIn = vi.fn(async () => 'opened' as const)
    vi.stubGlobal('narrativeDesktop', { bridgeVersion: 1, role: 'main', signIn })

    render(
      <AuthProvider>
        <LoginButton />
        <AuthReadout />
      </AuthProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'))
    act(() => {
      screen.getByText('Login').click()
    })

    await waitFor(() => expect(signIn).toHaveBeenCalledWith({ returnTo: '/dest' }))
    // Google refuses sign-in inside the app's window: it never navigates there.
    expect(assign).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

// ---------------------------------------------------------------------------
// logout()
// ---------------------------------------------------------------------------

describe('AuthProvider — logout()', () => {
  it('POSTs /auth/logout and navigates to /auth/login', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/auth/me')) return jsonResponse(200, { sub: 'x', email: 'x@y.z' })
      if (url.endsWith('/auth/logout')) return new Response(null, { status: 204 })
      return new Response(null, { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
    const assign = stubLocationAssign()

    render(
      <AuthProvider>
        <LogoutButton />
        <AuthReadout />
      </AuthProvider>,
    )

    await waitFor(() => expect(screen.getByTestId('user-sub').textContent).toBe('x'))

    await act(async () => {
      screen.getByText('Logout').click()
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/auth/logout'),
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    )
    expect(assign).toHaveBeenCalledWith('/auth/login')
  })
})

// ---------------------------------------------------------------------------
// Bypass mode
// ---------------------------------------------------------------------------

describe('AuthProvider — bypass mode', () => {
  it('synthesises dev-user without any fetch', async () => {
    vi.stubEnv('VITE_BYPASS_AUTH', 'true')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    render(
      <AuthProvider>
        <AuthReadout />
      </AuthProvider>,
    )

    expect(screen.getByTestId('user-sub').textContent).toBe('dev-user')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// useAuth outside provider
// ---------------------------------------------------------------------------

describe('useAuth', () => {
  it('throws when called outside <AuthProvider>', () => {
    function Bare() {
      useAuth()
      return null
    }
    // suppress React's console.error noise for the expected throw
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(() => render(<Bare />)).toThrow(/useAuth must be used inside/)
    spy.mockRestore()
  })
})
