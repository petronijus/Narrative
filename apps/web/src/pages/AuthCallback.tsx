/**
 * pages/AuthCallback.tsx
 *
 * M10: Handles the OIDC redirect from Authentik after login.
 * Route: /auth/callback
 *
 * Completes the PKCE code exchange, extracts the return path from OIDC
 * state (set during login()), and navigates there.
 */

import { useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { createUserManager } from '../state/AuthContext.js'

export function AuthCallback() {
  const navigate = useNavigate()
  const userManager = useMemo(() => createUserManager(), [])

  useEffect(() => {
    userManager
      .signinRedirectCallback()
      .then((user) => {
        const state = user.state as { returnTo?: string } | undefined
        navigate(state?.returnTo ?? '/', { replace: true })
      })
      .catch((err: unknown) => {
        console.error('[auth] callback failed', err instanceof Error ? err.message : String(err))
        navigate('/auth/error', { replace: true })
      })
  }, [userManager, navigate])

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-950 text-gray-400">
      <p className="text-sm">Finishing sign-in…</p>
    </div>
  )
}
