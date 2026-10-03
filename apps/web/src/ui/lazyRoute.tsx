/**
 * ui/lazyRoute.tsx
 *
 * `React.lazy` for the route pages, with a way back from a failed chunk load.
 *
 * A lazy page's `import()` can fail: the network changed mid-load
 * (`net::ERR_NETWORK_CHANGED`), the connection dropped, or a deploy replaced
 * the hashed chunk the running bundle asks for. `React.lazy` caches the
 * rejection in its lazy object, so rendering it again only re-throws — a
 * retry needs a fresh lazy object, which is what this wrapper keeps.
 *
 * The browser caches too. Chrome (verified on 154, 2026-10-03) remembers a
 * failed module fetch in the document's module map: calling the same
 * `import()` again rejects at once without a request, and a module that
 * imports a failed dependency fails the same way. So a retry:
 *
 *   1. calls the original loader again — enough in a browser that does not
 *      cache failures, and the only path that re-runs Vite's CSS preloads;
 *   2. if that fails and the browser named the module it could not fetch,
 *      imports that URL with a cache-busting query — recovers a failed
 *      top-level chunk (its dependencies resolve to their usual URLs, so no
 *      module is instantiated twice);
 *   3. otherwise gives up: a failed *dependency* stays failed until the page
 *      reloads, which is why the error boundary always offers Reload.
 *
 * Errors thrown by a route load are wrapped in `RouteLoadError`, so the
 * boundary tells "this page's code did not arrive" from a render bug without
 * sniffing browser-specific messages.
 */

import { lazy, type ComponentType, type LazyExoticComponent } from 'react'

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

/**
 * A lazily loaded route component that can be re-attempted after a failed
 * load. `load` must be a literal `import('./…')` so Vite still splits the
 * chunk; `pick` takes the named export (the pages export named components).
 */
export function lazyRoute<M, P extends object>(
  load: () => Promise<M>,
  pick: (module: M) => ComponentType<P>,
): ComponentType<P> {
  let attempt = 0

  const loadAgain = async (): Promise<M> => {
    try {
      return await load()
    } catch (error) {
      const url = moduleUrlFromImportError(error, window.location.origin)
      if (url === null) throw error
      return (await import(/* @vite-ignore */ withRetryParam(url, attempt))) as M
    }
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
        const module = attempt === 0 ? await load() : await loadAgain()
        return { default: pick(module) }
      } catch (error) {
        failedRoutes.add(entry)
        throw new RouteLoadError(error)
      }
    })

  let current = create()

  function LazyRoute(props: P) {
    // `current` changes only in `reset`, which the boundary follows with a
    // remount of this subtree — never between two renders of one mount.
    const Current = current
    return <Current {...props} />
  }
  return LazyRoute
}
