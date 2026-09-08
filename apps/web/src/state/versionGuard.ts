/**
 * state/versionGuard.ts
 *
 * Self-healing guard against a browser running a stale bundle.
 *
 * `index.html` is served `no-cache`, so a browser normally revalidates it on
 * every visit and picks up a deploy by itself. A browser that cached the
 * document *before* that header existed does not: it applies heuristic
 * freshness from `Last-Modified` (roughly 10 % of the document's age), so a
 * months-old copy can be served from disk for weeks — hashed asset URLs from
 * the old build and all. The page then boots the previous release with no
 * outward sign beyond things mysteriously not working, and only a hard reload
 * (Ctrl+Shift+R) escapes it. This happened in production on 2026-09-09.
 *
 * The guard closes that loop from the client side: the build stamps its
 * version into both the bundle (`__BUILD_VERSION__`) and `/version.json`, and
 * a mismatch between the two means the document we are running came from
 * cache while the server has moved on.
 *
 * Recovery is `fetch(document URL, { cache: 'reload' })` — which forces a
 * revalidated copy *into* the HTTP cache — followed by `location.reload()`,
 * which then picks that copy up. `location.reload()` on its own would just
 * re-serve the stale entry.
 */

declare const __BUILD_VERSION__: string

/** Marker so one stale document can't reload us more than once per tab. */
const STORAGE_KEY = 'narrative:version-guard:reloaded-for'

export interface VersionCheckInput {
  /** Version compiled into the running bundle. */
  running: string
  /** Version the server currently advertises, or null when unreadable. */
  served: string | null
  /** Version this tab has already reloaded for, if any. */
  alreadyReloadedFor: string | null
}

/**
 * Pure decision: should this tab reload to pick up a newer build?
 *
 * Deliberately conservative — an unreadable or empty `served` value means the
 * check failed (offline, proxy error, deploy mid-flight) and is never a reason
 * to reload. Reloading once per served version keeps a persistent mismatch
 * (say a proxy pinning an old document) from turning into a reload loop.
 */
export function shouldReloadForNewBuild(input: VersionCheckInput): boolean {
  const { running, served, alreadyReloadedFor } = input
  if (served === null || served.length === 0) return false
  if (running.length === 0) return false
  if (served === running) return false
  return alreadyReloadedFor !== served
}

async function readServedVersion(signal?: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch('/version.json', {
      cache: 'no-store',
      credentials: 'omit',
      ...(signal !== undefined ? { signal } : {}),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { version?: unknown }
    return typeof body.version === 'string' && body.version.length > 0 ? body.version : null
  } catch {
    // Offline, blocked, or mid-deploy — never a reason to act.
    return null
  }
}

function readMarker(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY)
  } catch {
    // Private mode / storage disabled — the check still works, it just can't
    // remember, so the "once per version" guarantee degrades to "once per
    // page load", which the reload itself already provides.
    return null
  }
}

function writeMarker(version: string): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, version)
  } catch {
    /* see readMarker */
  }
}

/**
 * Run one check. Returns the served version when a reload was triggered,
 * `null` otherwise — the return value exists for tests and diagnostics; the
 * caller normally ignores it.
 */
export async function checkForNewBuild(signal?: AbortSignal): Promise<string | null> {
  const served = await readServedVersion(signal)
  const decision = shouldReloadForNewBuild({
    running: __BUILD_VERSION__,
    served,
    alreadyReloadedFor: readMarker(),
  })
  if (!decision || served === null) return null

  writeMarker(served)
  console.warn(
    `[version-guard] running ${__BUILD_VERSION__}, server serves ${served} — reloading to catch up`,
  )
  try {
    // Refresh the cached document itself; a plain reload would re-serve the
    // stale entry that got us here.
    await fetch(window.location.href, { cache: 'reload', credentials: 'include' })
  } catch {
    /* best effort — reload anyway */
  }
  window.location.reload()
  return served
}

/**
 * Install the guard: one check at startup, and one whenever the tab comes
 * back to the foreground (a long-lived tab is exactly where a deploy is
 * missed). Throttled so tab-switching can't hammer the endpoint.
 *
 * Returns a teardown function.
 */
export function installVersionGuard(minIntervalMs = 60_000): () => void {
  let last = 0
  const controller = new AbortController()

  const run = (): void => {
    const now = Date.now()
    if (now - last < minIntervalMs) return
    last = now
    void checkForNewBuild(controller.signal)
  }

  const onVisible = (): void => {
    if (document.hidden) return
    run()
  }

  run()
  document.addEventListener('visibilitychange', onVisible)
  return () => {
    controller.abort()
    document.removeEventListener('visibilitychange', onVisible)
  }
}
