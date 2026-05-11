/**
 * pages/AuthCallback.tsx
 *
 * M10: Handles the OIDC redirect from Google after login.
 * Route: /auth/callback
 *
 * Delegates the PKCE code exchange to AuthProvider's `completeSignin()` so
 * the same `UserManager` instance that drives React state finishes the flow.
 * `completeSignin()` uses `flushSync` to commit the user into context before
 * resolving — so the subsequent `navigate(returnTo)` doesn't race the
 * <ProtectedRoute /> render and bounce back to /auth/login.
 */

import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../state/AuthContext.js'

export function AuthCallback() {
  const navigate = useNavigate()
  const { completeSignin } = useAuth()

  useEffect(() => {
    completeSignin()
      .then((state) => {
        navigate(state?.returnTo ?? '/', { replace: true })
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[auth] callback failed', msg, err)
        navigate('/auth/error', { replace: true, state: { error: msg } })
      })
  }, [completeSignin, navigate])

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-950 text-gray-400">
      <p className="text-sm">Finishing sign-in…</p>
    </div>
  )
}
