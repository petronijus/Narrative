/**
 * shared/src/sanitize.ts
 *
 * Security sanitisers shared between apps/web and apps/server.
 * Pure TypeScript — no runtime dependencies.
 */

/** URL schemes an object hyperlink is allowed to navigate to. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/** RFC 3986 scheme prefix — `https:`, `mailto:`, but also `javascript:`. */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i

/**
 * Sanitise a user-authored hyperlink target.
 *
 * - `http:` / `https:` / `mailto:` URLs pass through (normalised by the
 *   URL parser, so embedded tabs/newlines and casing tricks are erased).
 * - Bare hosts/paths (`google.com/x`) get `https://` prepended — without
 *   a scheme the browser would resolve them relative to the current
 *   location.
 * - Everything else returns null: `javascript:`, `data:`, `vbscript:`,
 *   protocol-relative `//evil`, unparseable garbage. Callers must treat
 *   null as "do not navigate / do not store".
 *
 * Parsing is delegated to the URL constructor rather than a regex so the
 * scheme check runs on the browser's own interpretation of the string.
 */
export function sanitizeHref(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  // Protocol-relative URLs inherit the page scheme and dodge naive
  // scheme checks — reject outright.
  if (trimmed.startsWith('//')) return null
  const candidate = SCHEME_RE.test(trimmed) ? trimmed : `https://${trimmed}`
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return null
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) return null
  // Return the parser-normalised form — what we validated is exactly
  // what the sink will open.
  return url.href
}
