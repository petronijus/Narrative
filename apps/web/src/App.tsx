/**
 * App.tsx
 *
 * M4: React Router added.
 * M5: Present mode route + shared Y.Doc via DeckShell.
 * M10: Auth layer added.
 *   - AuthProvider wraps the entire tree.
 *   - ProtectedRoute guards landing + deck routes.
 *   - /auth/login + /auth/error are public. /auth/callback is handled
 *     entirely server-side (post-2026-05 OAuth flow).
 *   - share_token query param bypasses auth (anonymous viewer path).
 */

import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom'
import { AuthProvider } from './state/AuthContext.js'
import { ThemeProvider } from './state/ThemeContext.js'
import { PerfHudProvider } from './state/PerfHudContext.js'
import { FoldersHome } from './pages/FoldersHome.js'
import { FolderDecks } from './pages/FolderDecks.js'
import { FolderSettings } from './pages/FolderSettings.js'
import { ComponentMasterEditor } from './pages/ComponentMasterEditor.js'
import { DeckEditor } from './pages/DeckEditor.js'
import { DeckPresent } from './pages/DeckPresent.js'
import { DeckShell } from './components/DeckShell.js'
import { ProtectedRoute } from './components/ProtectedRoute.js'
import { AuthLogin } from './pages/AuthLogin.js'
import { AuthError } from './pages/AuthError.js'
import { VersionChip } from './ui/VersionChip.js'
import { ThemeToggle } from './ui/ThemeToggle.js'
import { PerfHudToggle } from './ui/PerfHudToggle.js'
import { PerfHud } from './ui/PerfHud.js'

export function App() {
  return (
    <BrowserRouter>
      <ThemeProvider>
        <PerfHudProvider>
          <AuthProvider>
            <Routes>
              {/* Public auth routes (callback is handled server-side). */}
              <Route path="/auth/login" element={<AuthLogin />} />
              <Route path="/auth/error" element={<AuthError />} />

              {/* Protected routes — require session or share_token */}
              <Route element={<ProtectedRoute />}>
                <Route path="/" element={<FoldersHome />} />
                <Route path="/folder/:folderId" element={<FolderDecks />} />
                <Route path="/folder/:folderId/settings" element={<FolderSettings />} />
                <Route
                  path="/folder/:folderId/component/:componentId"
                  element={<ComponentMasterEditor />}
                />
                <Route path="/deck/:id" element={<DeckShell />}>
                  <Route index element={<DeckEditor />} />
                  <Route path="present" element={<DeckPresent />} />
                </Route>
              </Route>
            </Routes>
            {/* Global bottom-left chrome: auto-bumping build version, a
                tri-state theme toggle (system / light / dark) and a
                perf-HUD button. Hidden on present route — the presenter
                view must stay clean. */}
            <GlobalChrome />
            <PerfHud />
          </AuthProvider>
        </PerfHudProvider>
      </ThemeProvider>
    </BrowserRouter>
  )
}

function GlobalChrome() {
  const location = useLocation()
  if (location.pathname.endsWith('/present')) return null
  return (
    <div className="pointer-events-auto fixed bottom-2 left-2 z-50 flex items-center gap-1">
      <VersionChip />
      <ThemeToggle />
      <PerfHudToggle />
    </div>
  )
}
