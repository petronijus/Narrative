/**
 * App.lazy.test.tsx
 *
 * PERF-5 coverage: the editor routes are lazy (`lazyRoute`, a re-armable
 * React.lazy) behind a single <Suspense> boundary; since L1
 * (docs/plans/performance.md, 2026-10-18) every page but the auth pages is,
 * declared in `routePages.ts` (the budgets per route in `just size` are the
 * guard of what each route downloads). We can't cheaply mount the real <App> (it boots
 * Pixi + Hocuspocus), so we assert the two load-bearing properties the
 * change relies on:
 *
 *   1. The route modules are NOT statically imported by App — they live
 *      behind dynamic import() (verified by a source-level check that
 *      routePages.ts declares them via `lazyRoute(() => import(...), pick)`).
 *   2. A lazy route element renders its Suspense fallback first, then the
 *      resolved component — i.e. the boundary actually catches the pending
 *      chunk and swaps in the real UI (the mechanism App uses).
 */

import { describe, it, expect } from 'vitest'
import { Suspense } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { lazyRoute } from './ui/lazyRoute.js'
import { resolve } from 'node:path'

// vitest runs with cwd = the web package root (apps/web).
const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8')
const routesSource = readFileSync(resolve(process.cwd(), 'src/routePages.ts'), 'utf8')
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

describe('PERF-5 — App lazy-loads the heavy editor routes', () => {
  it('declares the pages via lazyRoute(() => import(...))', () => {
    // Each page must be code-split, not a static top-level import.
    for (const mod of [
      './components/DeckShell.js',
      './pages/DeckEditor.js',
      './pages/DeckPresent.js',
      './pages/ComponentMasterEditor.js',
      './pages/FoldersHome.js',
      './pages/FolderDecks.js',
      './pages/FolderSettings.js',
    ]) {
      expect(routesSource).toContain(`import('${mod}')`)
      for (const source of [appSource, routesSource]) {
        expect(source).not.toMatch(new RegExp(`^import\\s.*from\\s+'${escape(mod)}'`, 'm'))
      }
    }
    expect(routesSource).toContain('lazyRoute(')
    expect(appSource).toContain('<Suspense')
  })

  it('keeps only the auth pages eager (static imports)', () => {
    const eagerPages = [...appSource.matchAll(/^import\s.*from\s+'(\.\/pages\/[^']+)'/gm)].map(
      (m) => m[1],
    )
    expect(eagerPages.sort()).toEqual(['./pages/AuthError.js', './pages/AuthLogin.js'])
  })

  it('renders the Suspense fallback then the resolved lazy route', async () => {
    const Lazy = lazyRoute(
      () => Promise.resolve({ Editor: () => <div data-testid="resolved">Editor</div> }),
      (m) => m.Editor,
    )

    render(
      <MemoryRouter initialEntries={['/deck/1']}>
        <Suspense fallback={<div role="status">loading</div>}>
          <Routes>
            <Route path="/deck/:id" element={<Lazy />} />
          </Routes>
        </Suspense>
      </MemoryRouter>,
    )

    // Fallback is what mounts synchronously while the chunk resolves.
    expect(screen.getByRole('status')).toHaveTextContent('loading')
    // After the dynamic import resolves, the real component swaps in.
    await waitFor(() => expect(screen.getByTestId('resolved')).toBeInTheDocument())
  })
})
