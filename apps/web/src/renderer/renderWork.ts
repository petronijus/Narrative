/**
 * renderer/renderWork.ts
 *
 * The asynchronous work a painted slide waits for — media URL lookups,
 * texture loads, folder and bundled font loads — counted in one place, so the
 * render page (agentic A3, docs/plans/a3-render-worker.md) can tell when the
 * canvas shows the slide completely rather than its grey placeholders, and
 * which of those loads failed: a missing picture paints its error mark
 * (counted, per slide on the render page), a font that never came paints a
 * fallback face (named by family — fonts load once for the whole page, so a
 * font failure belongs to no one slide).
 *
 * Every load the main scene depends on funnels through a few functions:
 * `ResourceManager.acquireTexture` (images, video posters, image fills, image
 * backgrounds), the image URL and video-info resolvers, the folder font
 * loader and the bundled-font registration. Each wraps its promise in
 * `trackRenderWork`. A chain that awaits one tracked step and then starts the
 * next (resolve a URL, then load its texture) starts the next within the same
 * microtask run, so the count never reads zero between them.
 */

const pending = new Set<Promise<unknown>>()
const idleWaiters = new Set<() => void>()
let failures = 0
/** Font faces whose latest load failed: face key → family. */
const failedFaces = new Map<string, string>()

function notifyIfIdle(): void {
  if (pending.size > 0) return
  for (const resolve of [...idleWaiters]) resolve()
  idleWaiters.clear()
}

/**
 * Count `promise` as render work until it settles; returns it unchanged.
 * `font`: the face it loads (`key` identifies the face, `family` names it) —
 * a failure is then a failed font, not a failed load, and a later successful
 * load of the same face (a retry with a fresh URL) clears it.
 */
export function trackRenderWork<T>(
  promise: Promise<T>,
  opts?: { font?: { key: string; family: string } },
): Promise<T> {
  pending.add(promise)
  const font = opts?.font
  const done = (): void => {
    pending.delete(promise)
    // Let the settled promise's own continuations (the next step of a load
    // chain) run first; they may start more tracked work.
    queueMicrotask(notifyIfIdle)
  }
  promise.then(
    () => {
      if (font !== undefined) failedFaces.delete(font.key)
      done()
    },
    () => {
      if (font !== undefined) failedFaces.set(font.key, font.family)
      else failures += 1
      done()
    },
  )
  return promise
}

/** How much tracked work is in flight right now. */
export function pendingRenderWork(): number {
  return pending.size
}

/** How many tracked loads (not fonts) have failed since the page loaded. */
export function failedRenderWork(): number {
  return failures
}

/** The font families with a face that failed to load since the page loaded, sorted. */
export function failedRenderFonts(): string[] {
  return [...new Set(failedFaces.values())].sort()
}

/**
 * Resolves once no tracked work is in flight (immediately if none is). An
 * aborted wait resolves too and leaves nothing behind.
 */
export function whenRenderWorkIdle(signal?: AbortSignal): Promise<void> {
  if (pending.size === 0 || signal?.aborted === true) return Promise.resolve()
  return new Promise((resolve) => {
    const waiter = (): void => {
      signal?.removeEventListener('abort', waiter)
      idleWaiters.delete(waiter)
      resolve()
    }
    idleWaiters.add(waiter)
    signal?.addEventListener('abort', waiter, { once: true })
  })
}

/** Test helper. */
export function _resetRenderWorkForTests(): void {
  pending.clear()
  idleWaiters.clear()
  failures = 0
  failedFaces.clear()
}
