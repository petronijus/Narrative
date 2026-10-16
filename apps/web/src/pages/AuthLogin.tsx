/**
 * pages/AuthLogin.tsx
 *
 * Login page shown when a protected route is accessed without a session.
 * Route: /auth/login
 *
 * The button triggers a top-level navigation to the server's /auth/start
 * endpoint, which runs the Google OAuth dance and sets the session cookie
 * before redirecting back to `returnTo`. In the desktop app it opens the
 * sign-in in the system browser and says so (state/AuthContext.tsx).
 */

import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth, type LoginOutcome } from '../state/AuthContext.js'

export function AuthLogin() {
  const { isLoading, login } = useAuth()
  const [searchParams] = useSearchParams()
  const returnTo = searchParams.get('returnTo') ?? '/'
  // Inside the desktop app the sign-in continues in the system browser.
  const [outcome, setOutcome] = useState<LoginOutcome | null>(null)

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gray-950 text-gray-100">
      <div className="w-full max-w-sm rounded-lg border border-gray-800 bg-gray-900 p-8">
        <h1 className="text-xl font-semibold tracking-tight">Narrative</h1>
        <p className="mb-6 text-sm text-gray-400">Pro tool for keynote masters</p>

        {outcome === 'opened' && (
          <p className="mb-4 text-sm text-gray-300" role="status">
            Continue in your browser. Narrative opens again once you have signed in.
          </p>
        )}
        {outcome === 'refused' && (
          <p className="mb-4 text-sm text-amber-300" role="status">
            Narrative could not start the sign-in just now. Try again in a moment.
          </p>
        )}
        <button
          onClick={() => void login(returnTo).then(setOutcome)}
          disabled={isLoading}
          className="w-full rounded-md bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
        >
          {outcome === 'opened' ? 'Open the browser again' : 'Sign in with Google'}
        </button>
      </div>
    </div>
  )
}
