/**
 * pages/AuthError.tsx
 *
 * Error page for OIDC failures (e.g. callback error, state mismatch).
 * Route: /auth/error
 *
 * The server redirects here with a `?reason=<code>` query param when the
 * OAuth callback fails (state mismatch, allowlist denial, network blip…).
 */

import { Link, useSearchParams } from 'react-router-dom'

function humaniseReason(code: string): string {
  switch (code) {
    case 'not_allowed':
      return 'Your Google account is not on the allowlist for this Narrative deployment.'
    case 'state_mismatch':
    case 'missing_state_cookie':
    case 'bad_state_signature':
    case 'bad_state_json':
      return 'The sign-in request was tampered with or expired. Please try again.'
    case 'token_exchange_failed':
    case 'token_endpoint_unreachable':
    case 'no_id_token':
      return 'Google rejected the sign-in. Please try again — if it keeps failing, contact the deployer.'
    case 'invalid_callback':
      return 'The Google callback was malformed. Please start sign-in again.'
    case 'auth_not_configured':
      return 'The server is missing OAuth configuration.'
    default:
      if (code.startsWith('google_')) {
        return `Google returned an error: ${code.slice('google_'.length)}.`
      }
      return code
  }
}

export function AuthError() {
  const [searchParams] = useSearchParams()
  const reason = searchParams.get('reason')
  const detail = reason ? humaniseReason(reason) : null

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
