/**
 * components/ProtectedRoute.tsx
 *
 * M10: Route guard that requires an authenticated session.
 *
 * Exceptions:
 * - share_token in the URL → allow anonymous access (viewer mode)
 *
 * Usage (as layout route):
 *   <Route element={<ProtectedRoute />}>
 *     <Route path="/" element={<Landing />} />
 *     ...
 *   </Route>
 *
 * Or wrapping children directly:
 *   <ProtectedRoute><MyPage /></ProtectedRoute>
 */

import { type ReactNode } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../state/AuthContext.js'

interface ProtectedRouteProps {
  children?: ReactNode
}

export function ProtectedRoute({ children }: ProtectedRouteProps = {}) {
  const { user, isLoading } = useAuth()
  const location = useLocation()
  const searchParams = new URLSearchParams(location.search)
  const hasShareToken = searchParams.has('share_token')

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-950 text-gray-400">
        <p className="text-sm">Loading…</p>
      </div>
    )
  }

  if (user === null && !hasShareToken) {
    const returnTo = location.pathname + location.search
    return <Navigate to={`/auth/login?returnTo=${encodeURIComponent(returnTo)}`} replace />
  }

  // Authenticated, or share_token present → render route content
  return children !== undefined ? <>{children}</> : <Outlet />
}
