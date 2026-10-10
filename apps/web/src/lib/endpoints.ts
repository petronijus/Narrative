/**
 * lib/endpoints.ts
 *
 * Where the app reaches the API and the sync server. The build sets both
 * (`VITE_API_URL`, `VITE_HOCUSPOCUS_URL`), either absolute — development:
 * `http://localhost:3001`, `ws://localhost:3002` — or relative to the page —
 * production: `/api`, `/ws`. Relative values keep the bundle (and the web
 * image) independent of the domain it is served from — nothing in it names
 * one. They resolve against the page's location here, once, so consumers
 * always get an absolute URL
 * (`new URL(\`${API_URL}/auth/start\`)` needs one; a WebSocket needs `ws:` /
 * `wss:`).
 */

/** `value` against the page; '' stays '' (a same-origin path prefix). No trailing slash. */
export function resolveHttpUrl(value: string, pageHref: string): string {
  if (value === '') return ''
  return new URL(value, pageHref).toString().replace(/\/+$/, '')
}

/** `value` against the page, as `ws:` on an `http:` page and `wss:` on an `https:` one. */
export function resolveWsUrl(value: string, pageHref: string): string {
  const url = new URL(value, pageHref)
  if (url.protocol === 'http:') url.protocol = 'ws:'
  else if (url.protocol === 'https:') url.protocol = 'wss:'
  return url.toString().replace(/\/+$/, '')
}

// Unit tests and tooling run without a page; nothing relative is configured there.
const pageHref = (): string => globalThis.location?.href ?? 'http://localhost/'

const envApiUrl = import.meta.env['VITE_API_URL'] as string | undefined

/** The API base, absolute (`http://localhost:3001` when the build sets none). */
export const API_URL = resolveHttpUrl(envApiUrl ?? 'http://localhost:3001', pageHref())

/**
 * The API base for callers that fall back to same-origin paths ('' when the
 * build sets none, which the Vite dev proxy serves).
 */
export const API_BASE = resolveHttpUrl(envApiUrl ?? '', pageHref())

/** The sync server's WebSocket URL, absolute. */
export const HOCUSPOCUS_URL = resolveWsUrl(
  (import.meta.env['VITE_HOCUSPOCUS_URL'] as string | undefined) ?? 'ws://localhost:3002',
  pageHref(),
)
