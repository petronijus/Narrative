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
 *
 * PERF-5: route-level code splitting. The deck/component editors pull
 *   in the full heavy graph — Pixi (vendor-pixi), Tiptap (vendor-tiptap)
 *   and GSAP (vendor-gsap). Those parsed on the login + folder-dashboard
 *   routes even though neither needs them. We now React.lazy() the
 *   editor/present/component routes (and the DeckShell that mounts the
 *   renderer + Hocuspocus tree) behind a <Suspense> fallback, so the
 *   heavy vendor chunks defer off the dashboard/login critical path and
 *   only download when the user actually opens an editor. The dashboard,
 *   folder, landing and auth routes stay eager.
 */

import { Suspense, lazy } from 'react'
import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom'
import { AuthProvider } from './state/AuthContext.js'
import { ThemeProvider } from './state/ThemeContext.js'
import { PerfHudProvider } from './state/PerfHudContext.js'
import { FoldersHome } from './pages/FoldersHome.js'
import { FolderDecks } from './pages/FolderDecks.js'
import { FolderSettings } from './pages/FolderSettings.js'
import { ProtectedRoute } from './components/ProtectedRoute.js'
import { AuthLogin } from './pages/AuthLogin.js'
import { AuthError } from './pages/AuthError.js'
import { VersionChip } from './ui/VersionChip.js'
import { ThemeToggle } from './ui/ThemeToggle.js'
import { PerfHudToggle } from './ui/PerfHudToggle.js'
import { PerfHud } from './ui/PerfHud.js'

// PERF-5: heavy editor routes, lazily loaded so vendor-pixi / vendor-tiptap
// / vendor-gsap split into their own chunks and stay off the dashboard +
// login critical path. Each module exports a named component, so we adapt
// it to the { default } shape React.lazy expects.
const DeckShell = lazy(() =>
  import('./components/DeckShell.js').then((m) => ({ default: m.DeckShell })),
)
const DeckEditor = lazy(() =>
  import('./pages/DeckEditor.js').then((m) => ({ default: m.DeckEditor })),
)
const DeckPresent = lazy(() =>
  import('./pages/DeckPresent.js').then((m) => ({ default: m.DeckPresent })),
)
const ComponentMasterEditor = lazy(() =>
  import('./pages/ComponentMasterEditor.js').then((m) => ({
    default: m.ComponentMasterEditor,
  })),
)

/**
 * Suspense fallback while a lazy editor chunk downloads. Centred spinner —
 * same visual idiom (`animate-spin`) the upload/toolbar chrome already uses.
 */
function RouteFallback() {
  return (
    <div
      className="flex h-screen w-screen items-center justify-center"
      role="status"
      aria-label="Loading editor"
    >
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-600 border-t-blue-400" />
    </div>
  )
}

export function App() {
  return (
    <BrowserRouter>
      <ThemeProvider>
        <PerfHudProvider>
          <AuthProvider>
            {/* Single Suspense boundary: eager routes resolve synchronously
                so the fallback only ever shows while a lazy editor chunk is
                in flight. */}
            <Suspense fallback={<RouteFallback />}>
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
            </Suspense>
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
