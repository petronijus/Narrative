/**
 * main/permissions.ts
 *
 * What a page of the shell may ask for (docs/plans/desktop-d0-spec.md §3.3,
 * revision 3): only the server's own pages, and only what the editor uses —
 * writing to the clipboard (copying a share link or a token), fullscreen
 * (presenting) and window management (choosing the presentation display,
 * ADR 0015 decision 8). Everything else — the camera, the microphone,
 * notifications, location, screen capture, reading the clipboard — is denied.
 */

import type { Session } from 'electron'

export const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set([
  'clipboard-sanitized-write',
  'fullscreen',
  'window-management',
])

function safeOrigin(urlOrOrigin: string): string | null {
  try {
    return new URL(urlOrOrigin).origin
  } catch {
    return null
  }
}

/** Pure: whether `permission`, asked by `urlOrOrigin`, is granted under `serverOrigin`. */
export function isPermissionAllowed(
  permission: string,
  urlOrOrigin: string,
  serverOrigin: string | null,
): boolean {
  if (serverOrigin === null) return false
  return safeOrigin(urlOrOrigin) === serverOrigin && ALLOWED_PERMISSIONS.has(permission)
}

/**
 * Install the handlers on `session`. `serverOrigin` null (the default session,
 * the local dialog's session) denies everything.
 */
export function installPermissionHandlers(session: Session, serverOrigin: string | null): void {
  session.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(isPermissionAllowed(permission, details.requestingUrl, serverOrigin))
  })
  session.setPermissionCheckHandler((_wc, permission, requestingOrigin) =>
    isPermissionAllowed(permission, requestingOrigin, serverOrigin),
  )
  session.setDisplayMediaRequestHandler((_request, callback) => callback({}))
  session.setDevicePermissionHandler(() => false)
}
