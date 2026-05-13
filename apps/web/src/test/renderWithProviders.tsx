/**
 * test/renderWithProviders.tsx
 *
 * Drop-in replacement for `@testing-library/react`'s `render` that wraps
 * the UI under test in the same context tree the real app provides:
 *
 *   - MemoryRouter — react-router-dom hooks (`useLocation`, `useNavigate`, …)
 *   - AuthContext — `useAuth()` returns a synthesized dev user by default
 *   - TooltipProvider — Radix tooltip primitives are used across the
 *     toolbar, peer chips, etc., and throw if not mounted in a provider
 *   - SlideDocContext — `useSlideDoc()` returns a mock deck + awareness
 *   - SelectionProvider — `useSelection()` reads from the real context
 *     impl since SelectionContext has no value-overriding entry point
 *
 * Each provider is opt-out via the `providers` option so tests that need
 * to feed in their own ctx (e.g. wrapping a component twice with two
 * different selections) can. Callers that only need a subset of the
 * default wiring can pass `providers: { selection: false }` etc. and
 * bring their own.
 *
 * Usage:
 *
 *   import { renderWithProviders } from '../test/renderWithProviders'
 *   renderWithProviders(<MyComponent />)
 *
 *   // override auth user
 *   renderWithProviders(<MyComponent />, { authUser: { sub: 'u2', … } })
 *
 *   // pass a pre-built SlideDocContextValue (e.g. test-specific deckCtx)
 *   renderWithProviders(<MyComponent />, { slideDocValue: myCtx })
 */

import type { ReactElement, ReactNode } from 'react'
import { render, type RenderOptions, type RenderResult } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@radix-ui/react-tooltip'
import { vi } from 'vitest'

import { AuthContext, type AuthContextValue, type AuthUser } from '../state/AuthContext'
import {
  SlideDocContext,
  createMockSlideDocValue,
  type SlideDocContextValue,
} from '../state/slideDocContext'
import { SelectionProvider } from '../state/SelectionContext'

// ---------------------------------------------------------------------------
// Default mock values
// ---------------------------------------------------------------------------

/** Synthesised dev-user mirroring the BYPASS_AUTH path. */
export const DEFAULT_AUTH_USER: AuthUser = {
  sub: 'test-user',
  email: 'test@example.com',
  name: 'Test User',
}

function buildAuthValue(user: AuthUser | null = DEFAULT_AUTH_USER): AuthContextValue {
  return {
    user,
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn().mockResolvedValue(undefined),
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RenderWithProvidersOptions extends Omit<RenderOptions, 'wrapper'> {
  /** Override the user attached to AuthContext. `null` simulates a logged-out client. */
  authUser?: AuthUser | null
  /** Pre-built SlideDocContextValue — overrides the default mock. */
  slideDocValue?: SlideDocContextValue
  /** Initial entries for the test MemoryRouter. */
  routerEntries?: string[]
  /**
   * Selectively disable individual providers. Useful when the test wants
   * to mount its own custom Provider (e.g. to drive a Y.Doc through a
   * real SlideDocProvider during integration-style tests).
   */
  providers?: {
    auth?: boolean
    tooltip?: boolean
    slideDoc?: boolean
    selection?: boolean
    router?: boolean
  }
}

export function renderWithProviders(
  ui: ReactElement,
  options: RenderWithProvidersOptions = {},
): RenderResult {
  const {
    authUser = DEFAULT_AUTH_USER,
    slideDocValue,
    routerEntries = ['/'],
    providers = {},
    ...rtlOptions
  } = options

  const enabled = {
    router: providers.router ?? true,
    auth: providers.auth ?? true,
    tooltip: providers.tooltip ?? true,
    slideDoc: providers.slideDoc ?? true,
    selection: providers.selection ?? true,
  }

  const authValue = buildAuthValue(authUser)
  const slideDocResolved = slideDocValue ?? createMockSlideDocValue()

  function Wrapper({ children }: { children: ReactNode }): ReactElement {
    let tree: ReactNode = children
    if (enabled.selection) {
      tree = <SelectionProvider>{tree}</SelectionProvider>
    }
    if (enabled.slideDoc && SlideDocContext !== undefined) {
      tree = <SlideDocContext.Provider value={slideDocResolved}>{tree}</SlideDocContext.Provider>
    }
    if (enabled.tooltip) {
      tree = <TooltipProvider>{tree}</TooltipProvider>
    }
    // Tests sometimes vi.mock the AuthContext module to control useAuth's
    // return value directly. Such mocks usually omit AuthContext from
    // their export factory, leaving the named import undefined here.
    // Guard against it — the test's mocked useAuth() takes precedence over
    // any context value we'd provide anyway, so skipping the provider is
    // safe.
    if (enabled.auth && AuthContext !== undefined) {
      tree = <AuthContext.Provider value={authValue}>{tree}</AuthContext.Provider>
    }
    if (enabled.router) {
      tree = <MemoryRouter initialEntries={routerEntries}>{tree}</MemoryRouter>
    }
    return <>{tree}</>
  }

  return render(ui, { wrapper: Wrapper, ...rtlOptions })
}
