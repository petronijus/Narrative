/**
 * state/installHocuspocusWarningFilter.ts
 *
 * Suppresses a single noisy upstream warning from `@hocuspocus/provider`:
 *
 *   [HocuspocusProvider] An authentication token is required, but you
 *   didn't send one. Try adding a `token` to your HocuspocusProvider
 *   configuration. Won't try again.
 *
 * The library prints this whenever the server closes a WS with close code
 * 4401 + reason "Unauthorized". Two cases trigger 4401 server-side
 * (@hocuspocus/server@2.x):
 *
 *   1. The client never sent an auth-frame and `requiresAuthentication`
 *      is true. (We always send a sentinel `token: 'cookie'` so this
 *      doesn't apply to us.)
 *   2. The websocket's idle-connect timeout fires before the first auth
 *      frame is processed (e.g. transient shared-WS attach ordering on
 *      cold load). This is harmless — the next attach succeeds — but the
 *      library prints the warning anyway because it can't tell the two
 *      cases apart.
 *
 * Suppressing the message is purely cosmetic. The real auth path is
 * verified end-to-end by server-side `[hocuspocus] authenticate → …`
 * log lines and by the editor actually persisting deck state.
 */

const SUPPRESSED_PATTERN = '[HocuspocusProvider] An authentication token is required'

let installed = false

export function installHocuspocusWarningFilter(): void {
  if (installed) return
  installed = true

  const originalWarn = console.warn.bind(console)
  console.warn = (...args: unknown[]): void => {
    if (typeof args[0] === 'string' && args[0].includes(SUPPRESSED_PATTERN)) {
      return
    }
    originalWarn(...args)
  }
}
