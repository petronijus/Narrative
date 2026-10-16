/**
 * pages/AuthLogin.tsx
 *
 * Login page shown when a protected route is accessed without a session.
 * Route: /auth/login
 *
 * The button triggers a top-level navigation to the server's /auth/start
 * endpoint, which runs the Google OAuth dance and sets the session cookie
 * before redirecting back to `returnTo`.
 */

import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../state/AuthContext.js'

export function AuthLogin() {
  const { isLoading, login } = useAuth()
  const [searchParams] = useSearchParams()
  const returnTo = searchParams.get('returnTo') ?? '/'

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gray-950 text-gray-100">
      <div className="w-full max-w-sm rounded-lg border border-gray-800 bg-gray-900 p-8">
        <h1 className="text-xl font-semibold tracking-tight">Narrative</h1>
        <p className="mb-6 text-sm text-gray-400">Pro tool for keynote masters</p>

        <button
          onClick={() => login(returnTo)}
          disabled={isLoading}
          className="w-full rounded-md bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
        >
          Sign in with Google
        </button>
      </div>
    </div>
  )
}
