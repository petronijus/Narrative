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
 *   only download when the user actually opens an editor. The auth routes
 *   stay eager.
 *
 * L1 (docs/plans/performance.md, 2026-10-18): the folder pages are lazy too,
 *   and every lazy page loads before React asks for it — the opened one at
 *   boot, the likely next one when idle (routePages.ts, `IdleRoutePreload`).
 */

import { Suspense, useEffect } from 'react'
import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom'
import { AuthProvider } from './state/AuthContext.js'
import { DesktopBridge } from './desktop/DesktopBridge.js'
import { ThemeProvider } from './state/ThemeContext.js'
import { PerfHudProvider } from './state/PerfHudContext.js'
import { ProtectedRoute } from './components/ProtectedRoute.js'
import { AuthLogin } from './pages/AuthLogin.js'
import { AuthError } from './pages/AuthError.js'
import { VersionChip } from './ui/VersionChip.js'
import { ThemeToggle } from './ui/ThemeToggle.js'
import { PerfHudToggle } from './ui/PerfHudToggle.js'
import { PerfHud } from './ui/PerfHud.js'
import { ACCESS_TOKENS_PATH, ADMIN_PATH } from './ui/routePaths.js'
import { preloadWhenIdle } from './ui/lazyPart.js'
import { whenEditorSettled } from './ui/editorReady.js'
import {
  COMPONENT_PATH,
  DECK_PATH,
  FOLDER_PATH,
  nextPagesFor,
  FoldersHome,
  FolderDecks,
  FolderSettings,
  DeckShell,
  DeckEditor,
  DeckPresent,
  DeckRender,
  ComponentRenderShell,
  Admin,
  AccessTokens,
  ConfirmAgentAction,
  ComponentMasterEditor,
} from './routePages.js'
import { RouteErrorBoundary, RouteSpinner } from './ui/RouteErrorBoundary.js'

/**
 * Once the page is up and the browser idle, load what the user most likely
 * opens next (a folder from the folder list, a deck from a folder), so that
 * click does not wait for the network. Idle time only: never in a first
 * paint's way.
 */
function IdleRoutePreload() {
  const { pathname } = useLocation()
  useEffect(() => {
    const { pages, afterEditorPaint } = nextPagesFor(pathname)
    if (pages.length === 0) return
    return afterEditorPaint ? whenEditorSettled(pages) : preloadWhenIdle(pages)
  }, [pathname])
  return null
}

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
                    <Route path={FOLDER_PATH} element={<FolderDecks />} />
                    <Route path={`${FOLDER_PATH}/settings`} element={<FolderSettings />} />
                    <Route path={ACCESS_TOKENS_PATH} element={<AccessTokens />} />
                    <Route path={ADMIN_PATH} element={<Admin />} />
                    <Route path="/confirm/:id" element={<ConfirmAgentAction />} />
                    <Route path={COMPONENT_PATH} element={<ComponentMasterEditor />} />
                    <Route path={`${COMPONENT_PATH}/render`} element={<ComponentRenderShell />}>
                      <Route index element={<DeckRender />} />
                    </Route>
                    <Route path={DECK_PATH} element={<DeckShell />}>
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
            <IdleRoutePreload />
            <PerfHud />
            {/* Inside the desktop app: its menu and menu clicks (ADR 0015). */}
            <DesktopBridge />
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
