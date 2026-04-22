/**
 * App.tsx
 *
 * M4: React Router added.
 * M5: Present mode route + shared Y.Doc via DeckShell.
 * M10: Auth layer added.
 *   - AuthProvider wraps the entire tree.
 *   - ProtectedRoute guards landing + deck routes.
 *   - /auth/login, /auth/callback, /auth/error are public.
 *   - share_token query param bypasses auth (anonymous viewer path).
 */

import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { AuthProvider } from './state/AuthContext.js'
import { Landing } from './pages/Landing.js'
import { DeckEditor } from './pages/DeckEditor.js'
import { DeckPresent } from './pages/DeckPresent.js'
import { DeckShell } from './components/DeckShell.js'
import { ProtectedRoute } from './components/ProtectedRoute.js'
import { AuthCallback } from './pages/AuthCallback.js'
import { AuthLogin } from './pages/AuthLogin.js'
import { AuthError } from './pages/AuthError.js'
import { VersionChip } from './ui/VersionChip.js'

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          {/* Public auth routes */}
          <Route path="/auth/login" element={<AuthLogin />} />
          <Route path="/auth/callback" element={<AuthCallback />} />
          <Route path="/auth/error" element={<AuthError />} />

          {/* Protected routes — require session or share_token */}
          <Route element={<ProtectedRoute />}>
            <Route path="/" element={<Landing />} />
            <Route path="/deck/:id" element={<DeckShell />}>
              <Route index element={<DeckEditor />} />
              <Route path="present" element={<DeckPresent />} />
            </Route>
          </Route>
        </Routes>
        {/* Global build-version chip — bottom-left fixed. Auto-bumps via
            the commit-count scheme in apps/web/vite.config.ts so every
            push shows a new number in the UI. */}
        <VersionChip />
      </AuthProvider>
    </BrowserRouter>
  )
}
