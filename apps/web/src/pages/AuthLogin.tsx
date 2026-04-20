/**
 * pages/AuthLogin.tsx
 *
 * M10: Login page shown when a protected route is accessed without a session.
 * Route: /auth/login
 *
 * Reads returnTo from query params (set by ProtectedRoute) and passes it
 * through the OIDC redirect cycle via UserManager state so the callback
 * can navigate back to the original destination.
 */

import { useAuth } from '../state/AuthContext.js'
import { useSearchParams } from 'react-router-dom'

export function AuthLogin() {
  const { isLoading } = useAuth()
  const [searchParams] = useSearchParams()
  const returnTo = searchParams.get('returnTo') ?? '/'

  const handleLogin = () => {
    void (async () => {
      // Store returnTo in OIDC state so AuthCallback can redirect there
      const { createUserManager } = await import('../state/AuthContext.js')
      const um = createUserManager()
      await um.signinRedirect({ state: { returnTo } })
    })()
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gray-950 text-gray-100">
      <div className="w-full max-w-sm rounded-lg border border-gray-800 bg-gray-900 p-8">
        <h1 className="mb-2 text-xl font-semibold tracking-tight">Narrative</h1>
        <p className="mb-6 text-sm text-gray-400">Sign in to continue.</p>

        <button
          onClick={handleLogin}
          disabled={isLoading}
          className="w-full rounded-md bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
        >
          Sign in with Authentik
        </button>
      </div>
    </div>
  )
}
