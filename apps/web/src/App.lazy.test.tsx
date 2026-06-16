/**
 * App.lazy.test.tsx
 *
 * PERF-5 coverage: the editor routes are React.lazy() behind a single
 * <Suspense> boundary. We can't cheaply mount the real <App> (it boots
 * Pixi + Hocuspocus), so we assert the two load-bearing properties the
 * change relies on:
 *
 *   1. The heavy route modules are NOT statically imported by App — they
 *      live behind dynamic import() (verified by a source-level check that
 *      App declares them via `lazy(() => import(...))`).
 *   2. A lazy route element renders its Suspense fallback first, then the
 *      resolved component — i.e. the boundary actually catches the pending
 *      chunk and swaps in the real UI (the mechanism App uses).
 */

import { describe, it, expect } from 'vitest'
import { Suspense, lazy } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// vitest runs with cwd = the web package root (apps/web).
const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8')

describe('PERF-5 — App lazy-loads the heavy editor routes', () => {
  it('declares the editor routes via lazy(() => import(...))', () => {
    // Each heavy route must be code-split, not a static top-level import.
    for (const mod of [
      './components/DeckShell.js',
      './pages/DeckEditor.js',
      './pages/DeckPresent.js',
      './pages/ComponentMasterEditor.js',
    ]) {
      expect(appSource).toContain(`import('${mod}')`)
      // And must NOT be statically imported.
      expect(appSource).not.toMatch(
        new RegExp(`^import\\s.*from\\s+'${mod.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`, 'm'),
      )
    }
    expect(appSource).toContain('lazy(')
    expect(appSource).toContain('<Suspense')
  })

  it('keeps the dashboard/folder pages eager (static imports)', () => {
    for (const eager of ['./pages/FoldersHome.js', './pages/FolderDecks.js']) {
      expect(appSource).toMatch(
        new RegExp(`from '${eager.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`),
      )
    }
  })

  it('renders the Suspense fallback then the resolved lazy route', async () => {
    const Lazy = lazy(() =>
      Promise.resolve({
        default: () => <div data-testid="resolved">Editor</div>,
      }),
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
