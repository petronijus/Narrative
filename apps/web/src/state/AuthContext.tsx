/**
 * state/AuthContext.tsx
 *
 * Server-driven session authentication (post-2026-05 replacement for the
 * browser-PKCE flow built on `oidc-client-ts`).
 *
 *   - `login()`   → window.location.assign(`${API_URL}/auth/start?returnTo=…`)
 *     The server runs the OAuth dance with Google, mints a session row, and
 *     sets the `narrative_session` HttpOnly cookie, then redirects back to
 *     the SPA. The browser never sees the id_token. Inside the desktop app
 *     Google refuses that dance, so `login()` asks the shell to run it in the
 *     system browser instead (desktop/bridge.ts, ADR 0015); the shell then
 *     loads `returnTo` signed in.
 *   - `logout()`  → POST /auth/logout with credentials:'include' to revoke
 *     and clear the cookie, then redirect to /auth/login.
 *   - On mount   → GET /auth/me to recover the current session (returns
 *     401 → unauthenticated, 200 → { sub, email, name }).
 *
 * Tokens are never held in the SPA. The "token" field is gone from the
 * context — the cookie is sent automatically by the browser on same-origin
 * (prod) or same-site cross-origin fetch with credentials:'include' (dev).
 */

import { desktopBridge } from '../desktop/bridge.js'
import { API_URL } from '../lib/endpoints.js'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuthUser {
  sub: string
  email: string
  name?: string | null
  /** An instance admin (docs/adr/0014); the server decides, the UI only shows the screen. */
  isAdmin?: boolean
}

export type LoginOutcome = 'navigating' | 'opened' | 'refused'

export interface AuthContextValue {
  user: AuthUser | null
  isLoading: boolean
  /**
   * Start signing in. 'navigating': the browser leaves for Google.
   * 'opened': the desktop app opened the sign-in in the system browser.
   * 'refused': the desktop app did not (one was just started).
   */
  login(returnTo?: string): Promise<LoginOutcome>
  logout(): Promise<void>
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export const AuthContext = createContext<AuthContextValue | null>(null)

// ---------------------------------------------------------------------------
// AuthProvider
// ---------------------------------------------------------------------------

// Dev bypass — synthesises a fake user without any network round-trip.
// NEVER ship enabled. Mirrors apps/server BYPASS_AUTH=true.
function isBypassEnabled(): boolean {
  return import.meta.env['VITE_BYPASS_AUTH'] === 'true'
}

const BYPASS_USER: AuthUser = {
  sub: 'dev-user',
  name: 'Dev User',
  email: 'dev-user@dev.narrative.test',
}

/**
 * The synthetic identity a bypass-mode browser is: `dev-user`, or the one the
 * `narrative_dev_as` cookie names — the server reads the same cookie
 * (apps/server/src/auth/devIdentity.ts, same `dev-` pattern), so a test can
 * be a second person. Dev only, like the bypass itself.
 */
function bypassUser(): AuthUser {
  const named = /(?:^|;\s*)narrative_dev_as=([^;]*)/.exec(document.cookie)?.[1]
  const sub = named === undefined ? undefined : decodeURIComponent(named)
  if (sub === undefined || !/^dev-[a-z0-9-]{1,60}$/.test(sub)) return BYPASS_USER
  return { sub, name: sub, email: `${sub}@dev.narrative.test` }
}

export function AuthProvider({ children }: { children: ReactNode }): ReactElement {
  const bypass = isBypassEnabled()
  const [user, setUser] = useState<AuthUser | null>(() => (bypass ? bypassUser() : null))
  const [isLoading, setIsLoading] = useState(!bypass)

  // -------------------------------------------------------------------------
  // On mount: fetch the active session, if any.
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (bypass) {
      console.warn('[auth] VITE_BYPASS_AUTH=true — using synthesised dev-user. DO NOT DEPLOY.')
      return
    }

    let cancelled = false

    fetch(`${API_URL}/auth/me`, { credentials: 'include' })
      .then(async (res) => {
        if (cancelled) return
        if (res.ok) {
          const data = (await res.json()) as AuthUser
          setUser(data)
        } else {
          setUser(null)
        }
      })
      .catch(() => {
        if (!cancelled) setUser(null)
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [bypass])

  // -------------------------------------------------------------------------
  // Auth actions
  // -------------------------------------------------------------------------

  const login = useCallback(async (returnTo?: string): Promise<LoginOutcome> => {
    const target = returnTo ?? window.location.pathname + window.location.search
    const desktop = desktopBridge()
    if (desktop !== undefined) {
      try {
        return await desktop.signIn({ returnTo: target })
      } catch {
        return 'refused'
      }
    }
    const url = new URL(`${API_URL}/auth/start`)
    url.searchParams.set('returnTo', target)
    // Top-level navigation — the server-side OAuth flow can't run inside a
    // fetch because Google's consent screen needs to render in the browser.
    window.location.assign(url.toString())
    return 'navigating'
  }, [])

  const logout = useCallback(async () => {
    try {
      await fetch(`${API_URL}/auth/logout`, {
        method: 'POST',
        credentials: 'include',
      })
    } catch {
      // Even if the request fails (network blip), forget the user locally —
      // we're about to redirect to /auth/login anyway.
    }
    setUser(null)
    window.location.assign('/auth/login')
  }, [])

  // -------------------------------------------------------------------------
  // Context value
  // -------------------------------------------------------------------------

  const value: AuthContextValue = useMemo(
    () => ({ user, isLoading, login, logout }),
    [user, isLoading, login, logout],
  )

  return <AuthContext value={value}>{children}</AuthContext>
}

// ---------------------------------------------------------------------------
// useAuth hook
// ---------------------------------------------------------------------------

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (ctx === null) {
    throw new Error('useAuth must be used inside <AuthProvider>')
  }
  return ctx
}
