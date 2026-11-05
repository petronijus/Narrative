/**
 * renderer/devicePixelRatioWatch.ts — be told when the window's
 * devicePixelRatio changes (it moved to a screen of another density, or the
 * display's scaling or the page zoom changed).
 *
 * `matchMedia('(resolution: Xdppx)')` matches the density of the moment
 * only, so its `change` fires once, when the density leaves X: the watch
 * then reads the new ratio, reports it and arms a query for it. Works in
 * Chromium, Safari and WKWebView (the Tauri shell).
 */

export interface DensityEnv {
  readonly devicePixelRatio: number
  matchMedia(query: string): Pick<MediaQueryList, 'addEventListener' | 'removeEventListener'>
  addEventListener?(type: 'resize', listener: () => void): void
  removeEventListener?(type: 'resize', listener: () => void): void
}

/**
 * Call `onChange(ratio)` on every change of the ratio; returns the unwatch.
 * The window's `resize` is watched too: a page zoom changes the ratio with a
 * resize, and an engine that re-evaluates the media query lazily (Chromium
 * with an emulated density: only at the next viewport change) is caught
 * there as well. Either way a change is reported once.
 */
export function watchDevicePixelRatio(
  onChange: (ratio: number) => void,
  env: DensityEnv | undefined = typeof window === 'undefined' ? undefined : window,
): () => void {
  if (env === undefined || typeof env.matchMedia !== 'function') return () => undefined
  const e = env
  let query: Pick<MediaQueryList, 'addEventListener' | 'removeEventListener'> | null = null
  let stopped = false
  let ratio = e.devicePixelRatio || 1
  const arm = (): void => {
    query?.removeEventListener('change', fire)
    query = e.matchMedia(`(resolution: ${ratio}dppx)`)
    query.addEventListener('change', fire)
  }
  function fire(): void {
    if (stopped) return
    const now = e.devicePixelRatio || 1
    if (now === ratio) return
    ratio = now
    arm()
    onChange(now)
  }
  arm()
  e.addEventListener?.('resize', fire)
  return () => {
    stopped = true
    query?.removeEventListener('change', fire)
    e.removeEventListener?.('resize', fire)
    query = null
  }
}
