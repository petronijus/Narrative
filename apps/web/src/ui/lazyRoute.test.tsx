/**
 * ui/lazyRoute.test.tsx — the retry logic of `lazyRoute`: which URL a failed
 * import may be re-fetched from, the one automatic retry of a first load
 * (after the shared network wait, through the route boundary), and that a
 * reset route calls its loader again instead of re-throwing React.lazy's
 * cached rejection. The browser's own module-map caching (why the
 * cache-busting URL exists) is covered end to end in
 * `e2e/route-load-failure.spec.ts`.
 */

import { Component, Suspense, type ReactNode } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkForNewBuild } from '../state/versionGuard.js'
import {
  AUTO_RETRY_DELAY_MS,
  isRouteLoadError,
  lazyRoute,
  moduleUrlFromImportError,
  OFFLINE_WAIT_MS,
  resetFailedRoutes,
  RETRY_PARAM,
  withRetryParam,
} from './lazyRoute.js'
import { RouteErrorBoundary } from './RouteErrorBoundary.js'

vi.mock('../state/versionGuard.js', () => ({ checkForNewBuild: vi.fn() }))

const ORIGIN = 'https://narrative.example'

describe('moduleUrlFromImportError', () => {
  it('reads the module Chrome names', () => {
    const error = new TypeError(
      `Failed to fetch dynamically imported module: ${ORIGIN}/assets/DeckEditor-abc123.js`,
    )
    expect(moduleUrlFromImportError(error, ORIGIN)).toBe(`${ORIGIN}/assets/DeckEditor-abc123.js`)
  })

  it('reads the module Firefox names', () => {
    const error = new TypeError(
      `error loading dynamically imported module: ${ORIGIN}/src/pages/DeckEditor.tsx`,
    )
    expect(moduleUrlFromImportError(error, ORIGIN)).toBe(`${ORIGIN}/src/pages/DeckEditor.tsx`)
  })

  it('has nothing when the browser names no module (Safari) or the error is not an import', () => {
    expect(
      moduleUrlFromImportError(new TypeError('Importing a module script failed.'), ORIGIN),
    ).toBe(null)
    expect(moduleUrlFromImportError(new Error('Unable to preload CSS for /a.css'), ORIGIN)).toBe(
      null,
    )
    expect(moduleUrlFromImportError(undefined, ORIGIN)).toBe(null)
  })

  it('never returns another origin or a non-http URL', () => {
    const foreign = new TypeError(
      'Failed to fetch dynamically imported module: https://evil.example/x.js',
    )
    expect(moduleUrlFromImportError(foreign, ORIGIN)).toBe(null)
    const data = new TypeError(
      'Failed to fetch dynamically imported module: data:text/javascript,alert(1)',
    )
    expect(moduleUrlFromImportError(data, ORIGIN)).toBe(null)
  })
})

describe('withRetryParam', () => {
  it('sets the attempt and keeps the other query parameters', () => {
    expect(withRetryParam(`${ORIGIN}/src/pages/A.tsx?import&t=1`, 2)).toBe(
      `${ORIGIN}/src/pages/A.tsx?import=&t=1&${RETRY_PARAM}=2`,
    )
  })

  it('replaces an earlier attempt instead of appending', () => {
    expect(withRetryParam(`${ORIGIN}/a.js?${RETRY_PARAM}=1`, 2)).toBe(
      `${ORIGIN}/a.js?${RETRY_PARAM}=2`,
    )
  })
})

class CatchAll extends Component<{ children: ReactNode }, { error: unknown }> {
  override state = { error: null as unknown }
  static getDerivedStateFromError(error: unknown) {
    return { error }
  }
  override render() {
    return this.state.error === null ? this.props.children : <p>failed</p>
  }
}

type PageModule = { Page: () => ReactNode }

const importFailure = () => new TypeError('Importing a module script failed.')

/** A loader that rejects `failures` times, then resolves the page. */
function failingLoad(failures: number, text = 'page') {
  const load = vi.fn<() => Promise<PageModule>>()
  for (let i = 0; i < failures; i++) load.mockRejectedValueOnce(importFailure())
  return load.mockResolvedValue({ Page: () => <p>{text}</p> })
}

/** Run the fake clock forward, letting React commit what settled meanwhile. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

/** The app's route boundary around one lazy page. */
function inBoundary(children: ReactNode) {
  return (
    <MemoryRouter>
      <RouteErrorBoundary>
        <Suspense fallback={<p>loading</p>}>{children}</Suspense>
      </RouteErrorBoundary>
    </MemoryRouter>
  )
}

const card = () => screen.queryByRole('alert')

describe('lazyRoute', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(checkForNewBuild).mockReset().mockResolvedValue(null)
    // Routes an earlier test left failed would count in `resetFailedRoutes`.
    resetFailedRoutes()
  })

  afterEach(async () => {
    // Let a shared network wait a test left running end under fake time.
    await vi.runOnlyPendingTimersAsync()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('retries a failed first load once by itself, after the wait: the page, never the card', async () => {
    const load = failingLoad(1)
    const Page = lazyRoute(load, (m) => m.Page)
    render(inBoundary(<Page />))

    await advance(AUTO_RETRY_DELAY_MS - 1)
    expect(load).toHaveBeenCalledTimes(1)
    expect(screen.getByText('loading')).toBeTruthy()

    await advance(1)
    expect(load).toHaveBeenCalledTimes(2)
    expect(screen.getByText('page')).toBeTruthy()
    expect(card()).toBe(null)
    expect(checkForNewBuild).not.toHaveBeenCalled()
    expect(resetFailedRoutes()).toBe(0)
  })

  it('shows the card when the automatic retry fails too; the manual Retry gets no second one', async () => {
    const load = failingLoad(3)
    const Page = lazyRoute(load, (m) => m.Page)
    render(inBoundary(<Page />))

    await advance(AUTO_RETRY_DELAY_MS)
    expect(load).toHaveBeenCalledTimes(2)
    // Not a deploy: the boundary asked, then shows the card as before.
    expect(checkForNewBuild).toHaveBeenCalledTimes(1)
    expect(card()?.textContent).toContain('This page couldn’t load')
    expect(card()?.textContent).toContain('the connection may have dropped')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Retry' }))

    // The user's Retry loads once, at once — and says so when it fails.
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await advance(0)
    expect(load).toHaveBeenCalledTimes(3)
    expect(card()?.textContent).toContain('Retrying didn’t help')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Reload' }))

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await advance(0)
    expect(load).toHaveBeenCalledTimes(4)
    expect(screen.getByText('page')).toBeTruthy()
    expect(card()).toBe(null)
  })

  it('after a deploy the boundary still reloads: one deploy check once the retry failed, no card', async () => {
    vi.mocked(checkForNewBuild).mockResolvedValue('newer-build')
    // The chunk is gone for good.
    const load = vi.fn<() => Promise<PageModule>>().mockRejectedValue(importFailure())
    const Page = lazyRoute(load, (m) => m.Page)
    render(inBoundary(<Page />))

    await advance(AUTO_RETRY_DELAY_MS - 1)
    expect(checkForNewBuild).not.toHaveBeenCalled()
    await advance(1)
    expect(load).toHaveBeenCalledTimes(2)
    expect(checkForNewBuild).toHaveBeenCalledTimes(1)
    // `checkForNewBuild` is reloading the page: the spinner stays, no card.
    expect(screen.getByRole('status', { name: 'Loading' })).toBeTruthy()
    expect(card()).toBe(null)
    await advance(10_000)
    expect(load).toHaveBeenCalledTimes(2)
    expect(card()).toBe(null)
  })

  it('offline, waits for the online event before the retry', async () => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const load = failingLoad(1)
    const Page = lazyRoute(load, (m) => m.Page)
    render(inBoundary(<Page />))

    await advance(AUTO_RETRY_DELAY_MS * 3)
    expect(load).toHaveBeenCalledTimes(1)

    onLine.mockReturnValue(true)
    window.dispatchEvent(new Event('online'))
    await advance(AUTO_RETRY_DELAY_MS - 1)
    expect(load).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(load).toHaveBeenCalledTimes(2)
    expect(screen.getByText('page')).toBeTruthy()
  })

  it('offline for good, retries anyway after OFFLINE_WAIT_MS and shows the card', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const load = failingLoad(2)
    const Page = lazyRoute(load, (m) => m.Page)
    render(inBoundary(<Page />))

    await advance(OFFLINE_WAIT_MS + AUTO_RETRY_DELAY_MS - 1)
    expect(load).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(load).toHaveBeenCalledTimes(2)
    expect(card()?.textContent).toContain('This page couldn’t load')
  })

  it('routes that fail together share one wait and retry once each', async () => {
    const shellLoad = failingLoad(1, 'shell')
    const pageLoad = failingLoad(1, 'page')
    const Shell = lazyRoute(shellLoad, (m) => m.Page)
    const Page = lazyRoute(pageLoad, (m) => m.Page)
    void Shell.preload()
    await advance(AUTO_RETRY_DELAY_MS / 2)
    // The second failure joins the wait the first one started.
    void Page.preload()
    await advance(AUTO_RETRY_DELAY_MS / 2)
    expect(shellLoad).toHaveBeenCalledTimes(2)
    expect(pageLoad).toHaveBeenCalledTimes(2)

    await advance(AUTO_RETRY_DELAY_MS * 10)
    expect(shellLoad).toHaveBeenCalledTimes(2)
    expect(pageLoad).toHaveBeenCalledTimes(2)
  })

  it('wraps a failed load in RouteLoadError and loads again after a reset', async () => {
    const load = failingLoad(2)
    const Page = lazyRoute(load, (m) => m.Page)
    let caught: unknown = null
    class Probe extends CatchAll {
      override componentDidCatch(error: unknown) {
        caught = error
      }
    }

    const view = render(
      <Probe key="first">
        <Suspense fallback={null}>
          <Page />
        </Suspense>
      </Probe>,
    )
    await advance(AUTO_RETRY_DELAY_MS)
    expect(screen.getByText('failed')).toBeTruthy()
    expect(isRouteLoadError(caught)).toBe(true)
    expect(load).toHaveBeenCalledTimes(2)

    expect(resetFailedRoutes()).toBe(1)
    view.rerender(
      <Probe key="second">
        <Suspense fallback={null}>
          <Page />
        </Suspense>
      </Probe>,
    )
    await advance(0)
    expect(screen.getByText('page')).toBeTruthy()
    expect(load).toHaveBeenCalledTimes(3)
    // Nothing failed this time: nothing left to reset.
    expect(resetFailedRoutes()).toBe(0)
  })

  it('renders a preloaded page without suspending, and loads it once', async () => {
    const load = vi.fn(() => Promise.resolve({ Page: () => <p>page</p> }))
    const Page = lazyRoute(load, (m) => m.Page)
    await Page.preload()
    await Page.preload()
    expect(load).toHaveBeenCalledTimes(1)

    // No act/await: the page is in the first commit, the fallback never is.
    render(
      <Suspense fallback={<p>fallback</p>}>
        <Page />
      </Suspense>,
    )
    expect(screen.getByText('page')).toBeTruthy()
    expect(screen.queryByText('fallback')).toBe(null)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('a render that mounts during a preload shares its load, and its failure is the card', async () => {
    const load = failingLoad(2)
    const Page = lazyRoute(load, (m) => m.Page)
    // Boot: the opened page is preloaded while the session check runs.
    void Page.preload()
    render(inBoundary(<Page />))

    await advance(AUTO_RETRY_DELAY_MS)
    expect(load).toHaveBeenCalledTimes(2)
    expect(card()?.textContent).toContain('This page couldn’t load')
  })

  it('a navigation after a failed idle preload loads afresh: the page, no card', async () => {
    const load = failingLoad(2)
    const Page = lazyRoute(load, (m) => m.Page)
    const preload = Page.preload()
    await advance(AUTO_RETRY_DELAY_MS)
    // The preload retried once too, then reported nothing.
    await expect(preload).resolves.toBeUndefined()
    expect(load).toHaveBeenCalledTimes(2)
    // More preloads (idle callbacks, hovers) do not hammer a network that is down.
    await Page.preload()
    await advance(AUTO_RETRY_DELAY_MS * 10)
    expect(load).toHaveBeenCalledTimes(2)

    render(inBoundary(<Page />))
    await advance(0)
    expect(load).toHaveBeenCalledTimes(3)
    expect(screen.getByText('page')).toBeTruthy()
    expect(card()).toBe(null)
    expect(checkForNewBuild).not.toHaveBeenCalled()
  })

  it('the fresh load after a failed preload retries once by itself, then shows the card', async () => {
    const load = failingLoad(5)
    const Page = lazyRoute(load, (m) => m.Page)
    void Page.preload()
    await advance(AUTO_RETRY_DELAY_MS)
    expect(load).toHaveBeenCalledTimes(2)

    render(inBoundary(<Page />))
    await advance(0)
    expect(load).toHaveBeenCalledTimes(3)
    expect(card()).toBe(null)
    await advance(AUTO_RETRY_DELAY_MS)
    expect(load).toHaveBeenCalledTimes(4)
    expect(checkForNewBuild).toHaveBeenCalledTimes(1)
    expect(card()?.textContent).toContain('This page couldn’t load')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Retry' }))

    // The manual Retry: one load, at once.
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await advance(0)
    expect(load).toHaveBeenCalledTimes(5)
    expect(card()?.textContent).toContain('Retrying didn’t help')
  })
})
