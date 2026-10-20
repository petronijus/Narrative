/**
 * routePages.ts — the app's lazily loaded pages and which of them each route
 * renders, so they can be loaded before React asks for them.
 *
 * PERF-5 split the editor, present and component routes off the dashboard;
 * L1 (docs/plans/performance.md, 2026-10-18) split the folder pages off the
 * entry too — they took the command registry, the Yjs folder document and
 * tus onto the login page. `preloadRoute` starts the opened page's chunks at
 * boot (main.tsx), in parallel with the session check its route guard waits
 * for, every lazy level at once (a deck route's DeckShell and its page used
 * to load one after the other); `nextPagesFor` names what App.tsx loads when
 * the browser is idle.
 */

import { matchPath } from 'react-router-dom'
import { ACCESS_TOKENS_PATH, ADMIN_PATH } from './ui/routePaths.js'
import { lazyRoute } from './ui/lazyRoute.js'

export const FoldersHome = lazyRoute(
  () => import('./pages/FoldersHome.js'),
  (m) => m.FoldersHome,
)
export const FolderDecks = lazyRoute(
  () => import('./pages/FolderDecks.js'),
  (m) => m.FolderDecks,
)
export const FolderSettings = lazyRoute(
  () => import('./pages/FolderSettings.js'),
  (m) => m.FolderSettings,
)

// PERF-5: heavy editor routes, lazily loaded so vendor-pixi / vendor-tiptap
// / vendor-gsap split into their own chunks and stay off the dashboard +
// login critical path. `lazyRoute` is React.lazy that the error boundary can
// re-arm after a failed chunk load (ui/lazyRoute.tsx); each module exports a
// named component, which `pick` selects.
export const DeckShell = lazyRoute(
  () => import('./components/DeckShell.js'),
  (m) => m.DeckShell,
)
export const DeckEditor = lazyRoute(
  () => import('./pages/DeckEditor.js'),
  (m) => m.DeckEditor,
)
export const DeckPresent = lazyRoute(
  () => import('./pages/DeckPresent.js'),
  (m) => m.DeckPresent,
)
// The page the render worker screenshots (agentic A3): one slide, no chrome.
export const DeckRender = lazyRoute(
  () => import('./pages/DeckRender.js'),
  (m) => m.DeckRender,
)
// A component master's render page: DeckRender in the master's providers.
export const ComponentRenderShell = lazyRoute(
  () => import('./pages/ComponentRender.js'),
  (m) => m.ComponentRenderShell,
)
// Account settings: small, rarely visited — kept off the dashboard chunk.
export const Admin = lazyRoute(
  () => import('./pages/Admin.js'),
  (m) => m.Admin,
)
export const AccessTokens = lazyRoute(
  () => import('./pages/AccessTokens.js'),
  (m) => m.AccessTokens,
)
// The agent confirmation page: opened from a link an agent hands the user.
export const ConfirmAgentAction = lazyRoute(
  () => import('./pages/ConfirmAgentAction.js'),
  (m) => m.ConfirmAgentAction,
)
export const ComponentMasterEditor = lazyRoute(
  () => import('./pages/ComponentMasterEditor.js'),
  (m) => m.ComponentMasterEditor,
)

export const FOLDER_PATH = '/folder/:folderId'
export const DECK_PATH = '/deck/:id'
export const COMPONENT_PATH = '/folder/:folderId/component/:componentId'

export interface Preloadable {
  preload(): Promise<void>
}

/** The lazy pages each route renders at once, outermost first. */
const ROUTE_PAGES: readonly (readonly [string, readonly Preloadable[]])[] = [
  ['/', [FoldersHome]],
  [FOLDER_PATH, [FolderDecks]],
  [`${FOLDER_PATH}/settings`, [FolderSettings]],
  [ACCESS_TOKENS_PATH, [AccessTokens]],
  [ADMIN_PATH, [Admin]],
  ['/confirm/:id', [ConfirmAgentAction]],
  [COMPONENT_PATH, [ComponentMasterEditor]],
  [`${COMPONENT_PATH}/render`, [ComponentRenderShell, DeckRender]],
  [DECK_PATH, [DeckShell, DeckEditor]],
  [`${DECK_PATH}/present`, [DeckShell, DeckPresent]],
  [`${DECK_PATH}/render`, [DeckShell, DeckRender]],
]

function pagesFor(pathname: string): readonly Preloadable[] {
  for (const [pattern, pages] of ROUTE_PAGES) {
    if (matchPath(pattern, pathname) !== null) return pages
  }
  return []
}

/**
 * Start loading the code of the page at `pathname` — every lazy level of it at
 * once (a deck route's DeckShell and its page). main.tsx calls it at boot, so
 * the chunks load while the session is checked instead of after.
 */
export function preloadRoute(pathname: string): void {
  for (const page of pagesFor(pathname)) void page.preload()
}

/**
 * The pages a user most likely opens next from `pathname`, and whether they
 * wait for the editor to have drawn its deck (a deck route: the editor's own
 * first paint and thumbnails go first, ui/editorReady.ts).
 */
export function nextPagesFor(pathname: string): {
  pages: readonly Preloadable[]
  afterEditorPaint: boolean
} {
  if (matchPath('/', pathname) !== null) return { pages: [FolderDecks], afterEditorPaint: false }
  if (matchPath(FOLDER_PATH, pathname) !== null)
    return { pages: [DeckShell, DeckEditor, FoldersHome], afterEditorPaint: false }
  // Back to the deck's folder (or the folder list) from the editor.
  if (matchPath(DECK_PATH, pathname) !== null || matchPath(COMPONENT_PATH, pathname) !== null)
    return { pages: [FolderDecks, FoldersHome], afterEditorPaint: true }
  return { pages: [], afterEditorPaint: false }
}
