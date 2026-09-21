/**
 * state/sidebarScrollProbe.ts
 *
 * Opt-in field diagnostic for "the slide panel throws me back up".
 *
 * The symptom is reported consistently on production and has not reproduced
 * in any local or throttled run: scroll the previews to the end on a cold
 * cache and, as they load, the list clamps back up — repeatedly. Every
 * mechanism reachable from here has been ruled out on a local deck: browser
 * scroll anchoring (off, verified), `scrollIntoView`, `focus()`,
 * `scrollTo`/`scrollBy`, direct `scrollTop` writes, the panel node being
 * replaced, and any change of the panel's own size. So this records what
 * actually happens on the machine where it happens.
 *
 * Off unless the URL carries `?debugSidebar=1`, so it costs nothing normally.
 *
 * What it captures, per event: the scroll position, the scroll height, the
 * client height, the resulting maximum scroll, how many rows exist, how many
 * have a thumbnail yet, and — the part that matters — whether the movement
 * followed a real user gesture. A backwards jump with no gesture in the
 * preceding moment is the bug, and it prints one line naming it.
 *
 * `window.__sidebarProbe()` dumps everything as JSON for pasting back.
 */

const QUERY_FLAG = 'debugSidebar'
/** A scroll within this long of a wheel/key/pointer counts as the user's. */
const GESTURE_WINDOW_MS = 400
/** Ignore sub-pixel noise and momentum settling. */
const JUMP_THRESHOLD_PX = 24
const MAX_EVENTS = 800

interface ProbeEvent {
  t: number
  kind: string
  st: number
  sh: number
  ch: number
  max: number
  rows: number
  imgs: number
  /** ms since the last real user gesture, or -1 if there has not been one. */
  sinceGesture: number
  delta?: number
}

export function isSidebarProbeEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return new URLSearchParams(window.location.search).get(QUERY_FLAG) === '1'
  } catch {
    return false
  }
}

/**
 * Attach the probe to a slide-panel list element. Returns a teardown.
 * Safe to call when disabled — it does nothing and returns a no-op.
 */
export function attachSidebarScrollProbe(list: HTMLElement): () => void {
  if (!isSidebarProbeEnabled()) return () => undefined

  const t0 = performance.now()
  const events: ProbeEvent[] = []
  let lastGesture = -1
  let lastTop = list.scrollTop
  let jumps = 0

  const now = (): number => Math.round(performance.now() - t0)

  const snapshot = (kind: string, delta?: number): ProbeEvent => {
    const e: ProbeEvent = {
      t: now(),
      kind,
      st: Math.round(list.scrollTop),
      sh: list.scrollHeight,
      ch: list.clientHeight,
      max: list.scrollHeight - list.clientHeight,
      rows: list.querySelectorAll('[data-slide-id]').length,
      imgs: list.querySelectorAll('img').length,
      sinceGesture: lastGesture < 0 ? -1 : now() - lastGesture,
    }
    if (delta !== undefined) e.delta = delta
    events.push(e)
    if (events.length > MAX_EVENTS) events.shift()
    return e
  }

  const markGesture = (): void => {
    lastGesture = now()
  }

  const onScroll = (): void => {
    const top = list.scrollTop
    const delta = top - lastTop
    lastTop = top
    const e = snapshot('scroll', Math.round(delta))
    const unprompted = e.sinceGesture < 0 || e.sinceGesture > GESTURE_WINDOW_MS
    if (delta < -JUMP_THRESHOLD_PX && unprompted) {
      jumps++

      console.warn(
        `[sidebar-probe] jumped up ${Math.abs(Math.round(delta))}px with no user gesture ` +
          `(${e.sinceGesture < 0 ? 'none ever' : `${e.sinceGesture}ms ago`}) — ` +
          `scrollTop ${Math.round(top - delta)}→${e.st}, scrollHeight ${e.sh}, ` +
          `clientHeight ${e.ch}, maxScroll ${e.max}, rows ${e.rows}, thumbnails ${e.imgs}`,
      )
    }
  }

  const gestureEvents = ['wheel', 'keydown', 'pointerdown', 'touchstart'] as const
  for (const type of gestureEvents) {
    list.addEventListener(type, markGesture, { passive: true, capture: true })
  }
  list.addEventListener('scroll', onScroll, { passive: true })

  const ro = new ResizeObserver(() => snapshot('resize'))
  ro.observe(list)
  const mo = new MutationObserver(() => snapshot('dom'))
  mo.observe(list, { childList: true, subtree: true })

  snapshot('attached')

  console.info(
    '[sidebar-probe] watching the slide panel. Reproduce the jump, then run ' +
      'copy(window.__sidebarProbe()) and send the result.',
  )

  const dump = (): string =>
    JSON.stringify(
      {
        userAgent: navigator.userAgent,
        devicePixelRatio: window.devicePixelRatio,
        jumps,
        events,
      },
      null,
      2,
    )
  ;(window as unknown as { __sidebarProbe?: () => string }).__sidebarProbe = dump

  return () => {
    for (const type of gestureEvents) {
      list.removeEventListener(type, markGesture, { capture: true })
    }
    list.removeEventListener('scroll', onScroll)
    ro.disconnect()
    mo.disconnect()
    delete (window as unknown as { __sidebarProbe?: () => string }).__sidebarProbe
  }
}
