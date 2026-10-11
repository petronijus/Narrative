/**
 * main/navigationPolicy.ts
 *
 * Where a page of the shell may go (docs/plans/desktop-d0-spec.md §3.3).
 * The server's own origin loads in the app; ordinary web and mail links go
 * to the system browser; everything else (`file:`, `javascript:`, `data:`,
 * custom schemes) is blocked. Pure: no Electron here.
 */

export type NavigationVerdict = 'allow' | 'external' | 'block'

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])
const PRESENTER_PATH = /^\/deck\/[A-Za-z0-9_-]{1,64}\/present$/

function parse(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

/** `url` against the loaded server's origin (null: no server loaded, nothing is allowed in). */
export function classifyNavigation(url: string, serverOrigin: string | null): NavigationVerdict {
  const parsed = parse(url)
  if (parsed === null) return 'block'
  if (serverOrigin !== null && parsed.origin === serverOrigin) return 'allow'
  return EXTERNAL_PROTOCOLS.has(parsed.protocol) ? 'external' : 'block'
}

/**
 * The editor's presenter view, which the present page opens as a popup
 * (`/deck/<id>/present?presenter=1`, apps/web/src/components/PresentLayout.tsx).
 * The shell opens it as its own window in the same partition.
 */
export function isPresenterPopup(url: string, serverOrigin: string | null): boolean {
  const parsed = parse(url)
  return (
    parsed !== null &&
    serverOrigin !== null &&
    parsed.origin === serverOrigin &&
    PRESENTER_PATH.test(parsed.pathname) &&
    parsed.searchParams.get('presenter') === '1'
  )
}

/** Whether `url` may be handed to the system (`shell.openExternal`). */
export function isExternalUrl(url: string): boolean {
  const parsed = parse(url)
  return parsed !== null && EXTERNAL_PROTOCOLS.has(parsed.protocol)
}
