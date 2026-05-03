/**
 * state/AuthContext.tsx
 *
 * M10: OIDC PKCE authentication context via oidc-client-ts.
 *
 * Provides:
 *   - useAuth() hook: { user, token, isLoading, login, logout, refreshToken }
 *   - AuthProvider: wraps app, restores session on mount, configures silent renewal
 *
 * UserManager config reads from Vite env (Google OIDC since 2026-05):
 *   VITE_OIDC_ISSUER         e.g. https://accounts.google.com
 *   VITE_OIDC_CLIENT_ID      Google OAuth client_id ending in .apps.googleusercontent.com
 *   VITE_OIDC_REDIRECT_URI   e.g. https://narrative.example.com/auth/callback
 *
 * Bearer token to the API: we send `id_token` (a JWT) rather than `access_token`
 * because Google access_tokens are opaque strings, not JWTs, and the server
 * verifier expects a JWT. ID tokens for the configured client_id are signed
 * by Google with RS256 and validated against Google's JWKS.
 *
 * Token storage: oidc-client-ts default (sessionStorage) — do not roll your own.
 * NEVER log tokens to console or error tracking.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { UserManager, type User } from 'oidc-client-ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuthUser {
  sub: string
  email?: string
  name?: string
  groups?: string[]
}

export interface AuthContextValue {
  user: AuthUser | null
  token: string | null
  isLoading: boolean
  login(): Promise<void>
  logout(): Promise<void>
  refreshToken(): Promise<void>
}

// ---------------------------------------------------------------------------
// UserManager factory — exported so AuthCallback can reuse the same config
// ---------------------------------------------------------------------------

export function createUserManager(): UserManager {
  return new UserManager({
    authority: import.meta.env['VITE_OIDC_ISSUER'] ?? '',
    client_id: import.meta.env['VITE_OIDC_CLIENT_ID'] ?? '',
    redirect_uri:
      import.meta.env['VITE_OIDC_REDIRECT_URI'] ?? `${window.location.origin}/auth/callback`,
    response_type: 'code',
    scope: 'openid profile email',
    post_logout_redirect_uri: window.location.origin,
    loadUserInfo: true,
    // Google's OIDC discovery doc does not advertise refresh tokens for the
    // browser PKCE flow; silent renew uses the iframe-based prompt=none path.
    automaticSilentRenew: true,
  })
}

function oidcUserToAuthUser(u: User): AuthUser {
  const profile = u.profile
  const result: AuthUser = { sub: profile.sub }
  if (typeof profile['email'] === 'string') result.email = profile['email']
  if (typeof profile['name'] === 'string') result.name = profile['name']
  if (Array.isArray(profile['groups'])) result.groups = profile['groups'] as string[]
  return result
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export const AuthContext = createContext<AuthContextValue | null>(null)

// ---------------------------------------------------------------------------
// AuthProvider
// ---------------------------------------------------------------------------

// Dev bypass — synthesizes a fake user without real OIDC. NEVER use in prod.
// Enabled via VITE_BYPASS_AUTH=true in .env for local dev against a server
// also running with BYPASS_AUTH=true.
// Evaluated at hook invocation (not module load) so tests can control the
// flag by stubbing import.meta.env before rendering.
function isBypassEnabled(): boolean {
  return import.meta.env['VITE_BYPASS_AUTH'] === 'true'
}

const BYPASS_USER: AuthUser = {
  sub: 'dev-user',
  name: 'Dev User',
  email: 'dev@local',
}

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const bypass = isBypassEnabled()
  const [user, setUser] = useState<AuthUser | null>(bypass ? BYPASS_USER : null)
  const [token, setToken] = useState<string | null>(bypass ? 'dev-bypass-token' : null)
  const [isLoading, setIsLoading] = useState(!bypass)

  // Stable UserManager instance for the lifetime of the app
  const userManager = useMemo(() => createUserManager(), [])

  // Timeout ref — handle network failures during session restore
  const loadingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ---------------------------------------------------------------------------
  // Helpers — apply/clear resolved user
  // ---------------------------------------------------------------------------

  const applyUser = useCallback((oidcUser: User | null) => {
    if (oidcUser === null || oidcUser.expired) {
      setUser(null)
      setToken(null)
    } else {
      setUser(oidcUserToAuthUser(oidcUser))
      // We send the ID token (a JWT) as Bearer; Google access_tokens are opaque.
      // Token intentionally stored in state; never logged.
      setToken(oidcUser.id_token ?? null)
    }
  }, [])

  // ---------------------------------------------------------------------------
  // On mount: restore existing session
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (bypass) {
      console.warn('[auth] VITE_BYPASS_AUTH=true — using synthesized dev-user. DO NOT DEPLOY.')
      return
    }

    let cancelled = false

    // Safety timeout — if OIDC discovery or storage read hangs, unblock UI
    loadingTimeoutRef.current = setTimeout(() => {
      if (!cancelled) {
        setIsLoading(false)
      }
    }, 5000)

    userManager
      .getUser()
      .then((oidcUser) => {
        if (cancelled) return
        applyUser(oidcUser)
      })
      .catch(() => {
        if (cancelled) return
        setUser(null)
        setToken(null)
      })
      .finally(() => {
        if (cancelled) return
        clearTimeout(loadingTimeoutRef.current ?? undefined)
        setIsLoading(false)
      })

    // Subscribe to token renewal events
    const handleUserLoaded = (oidcUser: User) => {
      applyUser(oidcUser)
    }
    const handleUserUnloaded = () => {
      setUser(null)
      setToken(null)
    }
    const handleSilentRenewError = () => {
      // Silent renew failed — user stays logged in with current token until expiry.
      // On next 401 the app will trigger login().
    }

    userManager.events.addUserLoaded(handleUserLoaded)
    userManager.events.addUserUnloaded(handleUserUnloaded)
    userManager.events.addSilentRenewError(handleSilentRenewError)

    return () => {
      cancelled = true
      clearTimeout(loadingTimeoutRef.current ?? undefined)
      userManager.events.removeUserLoaded(handleUserLoaded)
      userManager.events.removeUserUnloaded(handleUserUnloaded)
      userManager.events.removeSilentRenewError(handleSilentRenewError)
    }
  }, [userManager, applyUser])

  // ---------------------------------------------------------------------------
  // Auth actions
  // ---------------------------------------------------------------------------

  const login = useCallback(async () => {
    // Store current path so callback can redirect back
    const returnTo = window.location.pathname + window.location.search
    await userManager.signinRedirect({ state: { returnTo } })
  }, [userManager])

  const logout = useCallback(async () => {
    await userManager.signoutRedirect()
  }, [userManager])

  const refreshToken = useCallback(async () => {
    const refreshed = await userManager.signinSilent()
    applyUser(refreshed)
  }, [userManager, applyUser])

  // ---------------------------------------------------------------------------
  // Context value
  // ---------------------------------------------------------------------------

  const value: AuthContextValue = useMemo(
    () => ({ user, token, isLoading, login, logout, refreshToken }),
    [user, token, isLoading, login, logout, refreshToken],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
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
