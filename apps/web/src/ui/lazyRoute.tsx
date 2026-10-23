/**
 * ui/lazyRoute.tsx
 *
 * `React.lazy` for the route pages, with a way back from a failed chunk load.
 *
 * A lazy page's `import()` can fail: the network changed mid-load
 * (`net::ERR_NETWORK_CHANGED` — Chrome aborts every request in flight when an
 * interface comes or goes: a Wi-Fi switch, a USB network device re-attaching),
 * the connection dropped, or a deploy replaced the hashed chunk the running
 * bundle asks for. `React.lazy` caches the rejection in its lazy object, so
 * rendering it again only re-throws — a retry needs a fresh lazy object, which
 * is what this wrapper keeps.
 *
 * The browser may cache too. Chrome 154 (verified 2026-10-03; 153 again
 * 2026-10-21) remembers a failed module fetch in the document's module map:
 * calling the same `import()` again rejects at once without a request, and a
 * module that imports a failed dependency fails the same way. Chrome 156
 * (verified 2026-10-21) fetches a failed module again on the next import.
 * So a retry:
 *
 *   1. calls the original loader again — enough in a browser that does not
 *      cache failures, and the only path that re-runs Vite's CSS preloads;
 *   2. if that fails and the browser named the module it could not fetch,
 *      imports that URL with a cache-busting query (a new one per retry) —
 *      recovers a failed top-level chunk (its dependencies resolve to their
 *      usual URLs, so no module is instantiated twice);
 *   3. otherwise gives up: in a caching browser a failed *dependency* stays
 *      failed until the page reloads, which is why the error boundary always
 *      offers Reload.
 *
 * The first load of a page retries once by itself, the same way, before it
 * reports the failure (2026-10-23): a network change aborts the load, and the
 * same request a moment later usually goes through, so the user never sees
 * the card. The retry waits `AUTO_RETRY_DELAY_MS` (400 ms) first — retried at
 * once it can land in the same burst of change notifications (macOS posts
 * several over a few hundred milliseconds as an interface comes up) and be
 * aborted again; much longer and the loading spinner starts to feel stuck.
 * An offline browser (`navigator.onLine`) waits for `online` first, for at
 * most `OFFLINE_WAIT_MS`. The wait is shared: every route that fails while it
 * runs (a network change aborts a deck route's DeckShell and DeckEditor
 * together) retries when it ends, once each. A retry that fails throws as
 * before — the boundary's deploy check, then the card with its manual Retry
 * (which gets no automatic retry of its own) and Reload; the automatic retry
 * puts about half a second in front of the deploy reload.
 *
 * Errors thrown by a route load are wrapped in `RouteLoadError`, so the
 * boundary tells "this page's code did not arrive" from a render bug without
 * sniffing browser-specific messages.
 *
 * `preload()` starts the load ahead of the render — the page the document was
 * opened on at boot (`App.tsx` → `preloadRoute`, in parallel with the session
 * check), the likely next page when the browser is idle. A mount that starts
 * after the preload resolved renders the page at once, without suspending: no
 * fallback frame, no extra task (docs/plans/performance.md → L1). A preload
 * includes the automatic retry: a render that mounts while it is in flight
 * shares it, and its failure is that render's card. A preload that failed
 * before any render asked for the page (an idle preload of the likely next
 * page, during the network change) reports nothing; the navigation to the page
 * starts a fresh load, with its own automatic retry, since the network has
 * usually recovered by then. Calling `preload()` again after such a failure
 * does nothing — hovers and idle callbacks do not turn an outage into a stream
 * of requests; only a render loads again.
 */

import { lazy, useState, type ComponentType, type LazyExoticComponent } from 'react'

/** A route page's code failed to load (fetch, MIME or evaluation error). */
export class RouteLoadError extends Error {
  override readonly name = 'RouteLoadError'
  constructor(override readonly cause: unknown) {
    super(`Route code failed to load: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

export function isRouteLoadError(error: unknown): error is RouteLoadError {
  return error instanceof RouteLoadError
}

/** Query parameter that gives a retried module a URL the module map has not seen. */
export const RETRY_PARAM = 'narrative-retry'

/**
 * The module URL a failed dynamic import names, if any — Chrome ("Failed to
 * fetch dynamically imported module: URL") and Firefox ("error loading
 * dynamically imported module: URL") do, Safari does not. Only a same-origin
 * http(s) URL is returned: it is about to be passed to `import()`.
 */
export function moduleUrlFromImportError(error: unknown, origin: string): string | null {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const match = /dynamically imported module:\s*(\S+)/i.exec(message)
  if (match === null) return null
  let url: URL
  try {
    url = new URL(match[1]!)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.origin !== origin) return null
  return url.href
}

/** `url` with the retry query set to `attempt` (replacing an earlier one). */
export function withRetryParam(url: string, attempt: number): string {
  const parsed = new URL(url)
  parsed.searchParams.set(RETRY_PARAM, String(attempt))
  return parsed.href
}

/** How long a failed first load waits before its automatic retry: a network change settles. */
export const AUTO_RETRY_DELAY_MS = 400

/** How long an offline browser waits for the `online` event before the retry runs anyway. */
export const OFFLINE_WAIT_MS = 3_000

/** The wait in progress, shared by every route whose load fails meanwhile. */
let networkSettling: Promise<void> | null = null

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Resolves on the `online` event, or after `timeoutMs` without one. */
function onlineOrTimeout(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      window.removeEventListener('online', done)
      resolve()
    }
    const timer = setTimeout(done, timeoutMs)
    window.addEventListener('online', done)
  })
}

/**
 * The moment a failed load may retry: back online (or given up waiting), then
 * `AUTO_RETRY_DELAY_MS` for the change to settle. One wait at a time — a load
 * that fails while it runs joins it.
 */
function networkSettled(): Promise<void> {
  networkSettling ??= (async () => {
    if (navigator.onLine === false) await onlineOrTimeout(OFFLINE_WAIT_MS)
    await delay(AUTO_RETRY_DELAY_MS)
  })().finally(() => {
    networkSettling = null
  })
  return networkSettling
}

interface RouteEntry {
  /** Replace the failed lazy object with a fresh one that re-attempts the load. */
  reset(): void
}

/** Routes whose last load rejected; `resetFailedRoutes` re-arms them. */
const failedRoutes = new Set<RouteEntry>()

/**
 * Re-arm every route whose load failed, so the next render re-attempts it.
 * Returns how many were reset. The caller re-renders them (the error
 * boundary clears its error).
 */
export function resetFailedRoutes(): number {
  const entries = [...failedRoutes]
  failedRoutes.clear()
  for (const entry of entries) entry.reset()
  return entries.length
}

/** A `lazyRoute` component: render it, or start loading it ahead of time. */
export type LazyRouteComponent<P extends object> = ComponentType<P> & {
  /** Start loading the page's code (once); resolves when it arrived or failed. */
  preload(): Promise<void>
}

/**
 * A lazily loaded route component that can be re-attempted after a failed
 * load. `load` must be a literal `import('./…')` so Vite still splits the
 * chunk; `pick` takes the named export (the pages export named components).
 */
export function lazyRoute<M, P extends object>(
  load: () => Promise<M>,
  pick: (module: M) => ComponentType<P>,
): LazyRouteComponent<P> {
  /** How many times the boundary re-armed this route (its manual Retry). */
  let attempt = 0
  /** Retries so far, automatic or manual: each cache-busting URL is a new one. */
  let retries = 0
  /** The first load, shared by `preload` and the first render. */
  let firstLoad: Promise<M> | null = null
  /** A render waits on `firstLoad`: its failure is that render's to report. */
  let firstLoadRendered = false
  /** A preload failed before any render asked: further preloads do nothing. */
  let preloadFailed = false
  /** The page, once a load succeeded. */
  let loaded: ComponentType<P> | null = null

  const loadAgain = async (): Promise<M> => {
    retries += 1
    const retry = retries
    try {
      return await load()
    } catch (error) {
      const url = moduleUrlFromImportError(error, window.location.origin)
      if (url === null) throw error
      return (await import(/* @vite-ignore */ withRetryParam(url, retry))) as M
    }
  }

  /** The original load, then — once, after the network settled — a retry. */
  const loadWithAutoRetry = async (): Promise<M> => {
    try {
      return await load()
    } catch {
      await networkSettled()
      return await loadAgain()
    }
  }

  const loadFirst = (): Promise<M> => {
    firstLoad ??= loadWithAutoRetry().then((module) => {
      loaded = pick(module)
      return module
    })
    return firstLoad
  }

  const entry: RouteEntry = {
    reset() {
      attempt += 1
      current = create()
    },
  }

  const create = (): LazyExoticComponent<ComponentType<P>> =>
    lazy(async () => {
      try {
        if (attempt === 0) firstLoadRendered = true
        const module = attempt === 0 ? await loadFirst() : await loadAgain()
        const page = pick(module)
        loaded = page
        return { default: page }
      } catch (error) {
        failedRoutes.add(entry)
        throw new RouteLoadError(error)
      }
    })

  let current = create()

  function LazyRoute(props: P) {
    // Chosen once per mount: a page already loaded renders directly; the
    // lazy wrapper otherwise. Switching between the two inside one mount
    // would remount the page. `current` changes only in `reset`, which the
    // boundary follows with a remount of this subtree.
    const [Direct] = useState<ComponentType<P> | null>(() => loaded)
    if (Direct !== null) return <Direct {...props} />
    const Current = current
    return <Current {...props} />
  }
  LazyRoute.preload = (): Promise<void> => {
    if (loaded !== null || attempt > 0 || preloadFailed) return Promise.resolve()
    return loadFirst().then(
      () => undefined,
      () => {
        // A render already waiting reports the failure (the boundary's card).
        // Otherwise drop it, so the render the user navigates to loads afresh.
        if (firstLoadRendered) return
        preloadFailed = true
        firstLoad = null
      },
    )
  }
  return LazyRoute
}
