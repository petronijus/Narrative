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

import { Suspense } from 'react'
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
import { ACCESS_TOKENS_PATH } from './ui/UserMenu.js'
import { lazyRoute } from './ui/lazyRoute.js'
import { RouteErrorBoundary, RouteSpinner } from './ui/RouteErrorBoundary.js'

// PERF-5: heavy editor routes, lazily loaded so vendor-pixi / vendor-tiptap
// / vendor-gsap split into their own chunks and stay off the dashboard +
// login critical path. `lazyRoute` is React.lazy that the error boundary can
// re-arm after a failed chunk load (ui/lazyRoute.tsx); each module exports a
// named component, which `pick` selects.
const DeckShell = lazyRoute(
  () => import('./components/DeckShell.js'),
  (m) => m.DeckShell,
)
const DeckEditor = lazyRoute(
  () => import('./pages/DeckEditor.js'),
  (m) => m.DeckEditor,
)
const DeckPresent = lazyRoute(
  () => import('./pages/DeckPresent.js'),
  (m) => m.DeckPresent,
)
// The page the render worker screenshots (agentic A3): one slide, no chrome.
const DeckRender = lazyRoute(
  () => import('./pages/DeckRender.js'),
  (m) => m.DeckRender,
)
// A component master's render page: DeckRender in the master's providers.
const ComponentRenderShell = lazyRoute(
  () => import('./pages/ComponentRender.js'),
  (m) => m.ComponentRenderShell,
)
// Account settings: small, rarely visited — kept off the dashboard chunk.
const AccessTokens = lazyRoute(
  () => import('./pages/AccessTokens.js'),
  (m) => m.AccessTokens,
)
// The agent confirmation page: opened from a link an agent hands the user.
const ConfirmAgentAction = lazyRoute(
  () => import('./pages/ConfirmAgentAction.js'),
  (m) => m.ConfirmAgentAction,
)
const ComponentMasterEditor = lazyRoute(
  () => import('./pages/ComponentMasterEditor.js'),
  (m) => m.ComponentMasterEditor,
)

export function App() {
  return (
    <BrowserRouter>
      <ThemeProvider>
        <PerfHudProvider>
          <AuthProvider>
            {/* Single Suspense boundary: eager routes resolve synchronously
                so the fallback only ever shows while a lazy editor chunk is
                in flight. The error boundary around it turns a failed chunk
                load (or any route error) into a Retry / Reload card instead
                of a blank page. */}
            <RouteErrorBoundary>
              <Suspense fallback={<RouteSpinner label="Loading editor" />}>
                <Routes>
                  {/* Public auth routes (callback is handled server-side). */}
                  <Route path="/auth/login" element={<AuthLogin />} />
                  <Route path="/auth/error" element={<AuthError />} />

                  {/* Protected routes — require session or share_token */}
                  <Route element={<ProtectedRoute />}>
                    <Route path="/" element={<FoldersHome />} />
                    <Route path="/folder/:folderId" element={<FolderDecks />} />
                    <Route path="/folder/:folderId/settings" element={<FolderSettings />} />
                    <Route path={ACCESS_TOKENS_PATH} element={<AccessTokens />} />
                    <Route path="/confirm/:id" element={<ConfirmAgentAction />} />
                    <Route
                      path="/folder/:folderId/component/:componentId"
                      element={<ComponentMasterEditor />}
                    />
                    <Route
                      path="/folder/:folderId/component/:componentId/render"
                      element={<ComponentRenderShell />}
                    >
                      <Route index element={<DeckRender />} />
                    </Route>
                    <Route path="/deck/:id" element={<DeckShell />}>
                      <Route index element={<DeckEditor />} />
                      <Route path="present" element={<DeckPresent />} />
                      <Route path="render" element={<DeckRender />} />
                    </Route>
                  </Route>
                </Routes>
              </Suspense>
            </RouteErrorBoundary>
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
  // Present shows the slides alone; the render page is screenshotted.
  if (location.pathname.endsWith('/present') || location.pathname.endsWith('/render')) return null
  return (
    <div className="pointer-events-auto fixed bottom-2 left-2 z-50 flex items-center gap-1">
      <VersionChip />
      <ThemeToggle />
      <PerfHudToggle />
    </div>
  )
}
