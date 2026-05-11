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
import { flushSync } from 'react-dom'
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
  /**
   * Completes the OIDC PKCE callback after Google redirects back to
   * `/auth/callback`. Drives the SAME `UserManager` that AuthProvider
   * owns, so React state is updated by the time the promise resolves
   * (synchronous flush). Returns the OIDC `state` payload set during
   * `signinRedirect`, which carries `returnTo`.
   */
  completeSignin(): Promise<{ returnTo?: string } | undefined>
}

// ---------------------------------------------------------------------------
// UserManager factory — exported so AuthCallback can reuse the same config
// ---------------------------------------------------------------------------

export function createUserManager(): UserManager {
  // metadataSeed: replaces specific endpoints in the discovered OIDC metadata.
  // We re-point token_endpoint at our own server route, which holds the Google
  // `client_secret` and forwards the exchange. That keeps the secret out of
  // the SPA bundle (Google's "Web application" client type requires the secret
  // on every code → token exchange even when PKCE is used).
  // token_endpoint_auth_methods_supported: ['none'] tells oidc-client-ts the
  // client is public, so it skips its "client_secret is missing" guard.
  const tokenEndpoint = `${window.location.origin}/api/auth/google/exchange`

  return new UserManager({
    authority: import.meta.env['VITE_OIDC_ISSUER'] ?? '',
    client_id: import.meta.env['VITE_OIDC_CLIENT_ID'] ?? '',
    redirect_uri:
      import.meta.env['VITE_OIDC_REDIRECT_URI'] ?? `${window.location.origin}/auth/callback`,
    response_type: 'code',
    scope: 'openid profile email',
    post_logout_redirect_uri: window.location.origin,
    metadataSeed: {
      token_endpoint: tokenEndpoint,
      token_endpoint_auth_methods_supported: ['none'],
    },
    // The id_token JWT already carries `sub` / `email` / `name`, so the
    // separate userinfo round-trip is redundant. Disabling it also avoids
    // a failure mode where Google's userinfo endpoint rejects the request
    // and the whole sign-in flow fails (oidc-client-ts treats userinfo
    // errors as fatal).
    loadUserInfo: false,
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

  const completeSignin = useCallback(async (): Promise<{ returnTo?: string } | undefined> => {
    const oidcUser = await userManager.signinRedirectCallback()
    // flushSync forces React to commit the user state synchronously so the
    // navigate() that follows in AuthCallback doesn't see a stale `user=null`
    // in <ProtectedRoute />. Without this the post-callback redirect to "/"
    // races the React state update and bounces back to /auth/login.
    flushSync(() => {
      applyUser(oidcUser)
    })
    return oidcUser.state as { returnTo?: string } | undefined
  }, [userManager, applyUser])

  // ---------------------------------------------------------------------------
  // Context value
  // ---------------------------------------------------------------------------

  const value: AuthContextValue = useMemo(
    () => ({ user, token, isLoading, login, logout, refreshToken, completeSignin }),
    [user, token, isLoading, login, logout, refreshToken, completeSignin],
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
