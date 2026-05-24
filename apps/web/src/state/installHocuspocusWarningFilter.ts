/**
 * state/installHocuspocusWarningFilter.ts
 *
 * Suppresses noisy upstream warnings that have no user-visible impact:
 *
 * 1. Hocuspocus "[HocuspocusProvider] An authentication token is required"
 *    — fires transiently on cold-load WS attach ordering; next retry
 *    succeeds. Cosmetic only.
 *
 * 2. Pixi "HTMLTextSystem: Failed to clean texture"
 *    — fires during slide switches and editor↔present navigation when
 *    HTMLText nodes are destroyed while their async SVG→texture
 *    rasterize is in-flight. The texture is freed either way (by the
 *    promise rejection handler or by GC). No visual artifact.
 *
 * 3. Pixi TypeError "_getFinalPadding of null"
 *    — fires in the thumbnail pipeline when the offscreen renderer
 *    tries to measure a text node whose style was already torn down.
 *    Pixi catches this internally; the thumbnail queue skips the
 *    frame and retries on the next tick.
 */

const SUPPRESSED_WARN_PATTERNS = [
  '[HocuspocusProvider] An authentication token is required',
  'HTMLTextSystem: Failed to clean texture',
]

const SUPPRESSED_ERROR_PATTERNS = ['_getFinalPadding']

let installed = false

export function installHocuspocusWarningFilter(): void {
  if (installed) return
  installed = true

  const originalWarn = console.warn.bind(console)
  console.warn = (...args: unknown[]): void => {
    const first = args[0]
    if (typeof first === 'string') {
      for (const p of SUPPRESSED_WARN_PATTERNS) {
        if (first.includes(p)) return
      }
    }
    originalWarn(...args)
  }

  const originalError = console.error.bind(console)
  console.error = (...args: unknown[]): void => {
    const first = args[0]
    if (first instanceof TypeError && typeof first.message === 'string') {
      for (const p of SUPPRESSED_ERROR_PATTERNS) {
        if (first.message.includes(p)) return
      }
    }
    originalError(...args)
  }
}
