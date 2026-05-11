/**
 * pages/AuthError.tsx
 *
 * M10: Error page for OIDC failures (e.g. callback error, state mismatch).
 * Route: /auth/error
 */

import { Link, useLocation } from 'react-router-dom'

export function AuthError() {
  const location = useLocation()
  const state = location.state as { error?: string } | null
  const detail = state?.error

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gray-950 text-gray-100">
      <div className="w-full max-w-sm rounded-lg border border-gray-800 bg-gray-900 p-8">
        <h1 className="mb-2 text-xl font-semibold text-red-400">Sign-in failed</h1>
        <p className="mb-4 text-sm text-gray-400">
          Something went wrong during sign-in. This can happen if you refreshed mid-flow or the
          session expired.
        </p>
        {detail && (
          <pre className="mb-4 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-gray-800 bg-gray-950 p-2 text-xs text-red-300">
            {detail}
          </pre>
        )}
        <Link
          to="/auth/login"
          className="inline-flex w-full items-center justify-center rounded-md bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
        >
          Try again
        </Link>
      </div>
    </div>
  )
}
