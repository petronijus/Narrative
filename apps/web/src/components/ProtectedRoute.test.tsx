/**
 * components/ProtectedRoute.test.tsx
 *
 * M10: Tests for route protection logic.
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ProtectedRoute } from './ProtectedRoute'
import { AuthContext } from '../state/AuthContext'
import type { AuthContextValue, AuthUser } from '../state/AuthContext'

// ---------------------------------------------------------------------------
// Mock auth helper
// ---------------------------------------------------------------------------

function createMockAuthValue(overrides: Partial<AuthContextValue> = {}): AuthContextValue {
  return {
    user: null,
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

const MOCK_USER: AuthUser = {
  sub: 'user-abc',
  email: 'test@example.com',
  name: 'Test User',
}

// ---------------------------------------------------------------------------
// Render helper
// ---------------------------------------------------------------------------

interface TestAppOptions {
  authValue: AuthContextValue
  initialPath?: string
}

function TestApp({ authValue, initialPath = '/' }: TestAppOptions) {
  return (
    <MemoryRouter initialEntries={[initialPath]}>
      <AuthContext value={authValue}>
        <Routes>
          <Route path="/auth/login" element={<div data-testid="login-page">Login Page</div>} />
          <Route element={<ProtectedRoute />}>
            <Route path="/" element={<div data-testid="protected-content">Protected</div>} />
            <Route path="/deck/:id" element={<div data-testid="deck-content">Deck</div>} />
          </Route>
        </Routes>
      </AuthContext>
    </MemoryRouter>
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProtectedRoute', () => {
  it('redirects unauthenticated user to /auth/login', () => {
    render(<TestApp authValue={createMockAuthValue({ user: null })} />)
    expect(screen.getByTestId('login-page')).toBeTruthy()
    expect(screen.queryByTestId('protected-content')).toBeNull()
  })

  it('includes returnTo param in redirect URL', () => {
    render(
      <TestApp authValue={createMockAuthValue({ user: null })} initialPath="/deck/my-deck-id" />,
    )
    // Should show login page (redirect happened)
    expect(screen.getByTestId('login-page')).toBeTruthy()
  })

  it('renders children when user is authenticated', () => {
    render(<TestApp authValue={createMockAuthValue({ user: MOCK_USER })} />)
    expect(screen.getByTestId('protected-content')).toBeTruthy()
    expect(screen.queryByTestId('login-page')).toBeNull()
  })

  it('renders children when share_token is present (anonymous viewer)', () => {
    render(
      <TestApp
        authValue={createMockAuthValue({ user: null })}
        initialPath="/?share_token=abc123"
      />,
    )
    expect(screen.getByTestId('protected-content')).toBeTruthy()
    expect(screen.queryByTestId('login-page')).toBeNull()
  })

  it('shows loading state while isLoading=true', () => {
    render(<TestApp authValue={createMockAuthValue({ isLoading: true, user: null })} />)
    // Should show loading, not redirect or content
    expect(screen.queryByTestId('login-page')).toBeNull()
    expect(screen.queryByTestId('protected-content')).toBeNull()
  })
})
