/**
 * ui/lazyRoute.test.tsx — the retry logic of `lazyRoute`: which URL a failed
 * import may be re-fetched from, and that a reset route calls its loader
 * again instead of re-throwing React.lazy's cached rejection. The browser's
 * own module-map caching (why the cache-busting URL exists) is covered end to
 * end in `e2e/route-load-failure.spec.ts`.
 */

import { Component, Suspense, type ReactNode } from 'react'
import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  isRouteLoadError,
  lazyRoute,
  moduleUrlFromImportError,
  resetFailedRoutes,
  RETRY_PARAM,
  withRetryParam,
} from './lazyRoute.js'

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

describe('lazyRoute', () => {
  it('wraps a failed load in RouteLoadError and loads again after a reset', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const load = vi
      .fn<() => Promise<{ Page: () => ReactNode }>>()
      .mockRejectedValueOnce(new TypeError('Importing a module script failed.'))
      .mockResolvedValue({ Page: () => <p>page</p> })
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
    await screen.findByText('failed')
    expect(isRouteLoadError(caught)).toBe(true)
    expect(load).toHaveBeenCalledTimes(1)

    expect(resetFailedRoutes()).toBe(1)
    await act(async () => {
      view.rerender(
        <Probe key="second">
          <Suspense fallback={null}>
            <Page />
          </Suspense>
        </Probe>,
      )
    })
    await screen.findByText('page')
    expect(load).toHaveBeenCalledTimes(2)
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

  it('leaves a failed preload to the render, which reports it and can be retried', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const load = vi
      .fn<() => Promise<{ Page: () => ReactNode }>>()
      .mockRejectedValueOnce(new TypeError('Importing a module script failed.'))
      .mockResolvedValue({ Page: () => <p>page</p> })
    const Page = lazyRoute(load, (m) => m.Page)
    await expect(Page.preload()).resolves.toBeUndefined()

    const view = render(
      <CatchAll key="first">
        <Suspense fallback={null}>
          <Page />
        </Suspense>
      </CatchAll>,
    )
    await screen.findByText('failed')
    expect(load).toHaveBeenCalledTimes(1)
    expect(resetFailedRoutes()).toBe(1)
    await act(async () => {
      view.rerender(
        <CatchAll key="second">
          <Suspense fallback={null}>
            <Page />
          </Suspense>
        </CatchAll>,
      )
    })
    await screen.findByText('page')
    expect(load).toHaveBeenCalledTimes(2)
  })
})
