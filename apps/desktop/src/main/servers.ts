/**
 * main/servers.ts
 *
 * Which Narrative server the shell loads (docs/plans/desktop-d0-spec.md §3.2,
 * §3.8): production by default, the local dev stack, or a custom origin for
 * testing. Each server gets its own on-disk partition, so cookies, IndexedDB
 * and service workers of two servers never mix. Pure: no Electron here.
 */

import { createHash } from 'node:crypto'
import servers from '../../servers.json'

export type ServerTarget =
  { kind: 'production' } | { kind: 'development' } | { kind: 'custom'; origin: string }

export const PRODUCTION: ServerTarget = { kind: 'production' }

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * A custom server's origin, normalised, or null when it is not one: no path,
 * query, fragment or credentials; `https:` for any host, `http:` only for
 * the loopback (a dev stack on this machine).
 */
export function normalizeCustomOrigin(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.username || url.password || url.search || url.hash) return null
  if (url.pathname !== '/' && url.pathname !== '') return null
  if (url.protocol === 'https:') return url.origin
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return url.origin
  return null
}

/** The origin the main window loads. */
export function serverOrigin(target: ServerTarget): string {
  switch (target.kind) {
    case 'production':
      return new URL(servers.production).origin
    case 'development':
      return new URL(servers.development).origin
    case 'custom':
      return target.origin
  }
}

/**
 * Where the shell reaches the server's API (the sign-in routes). Production
 * and a custom server serve it under `/api` (the Caddy layout); the dev stack
 * runs it on its own port.
 */
export function apiUrl(target: ServerTarget): string {
  switch (target.kind) {
    case 'production':
      return `${serverOrigin(target)}/api`
    case 'development':
      return new URL(servers.developmentApi).origin
    case 'custom':
      return `${target.origin}/api`
  }
}

/** The persistent session partition of a server. */
export function partitionFor(target: ServerTarget): string {
  switch (target.kind) {
    case 'production':
      return 'persist:narrative-prod'
    case 'development':
      return 'persist:narrative-dev'
    case 'custom':
      return `persist:narrative-custom-${createHash('sha256').update(target.origin).digest('hex').slice(0, 16)}`
  }
}

/** The host shown in the window title for every server but production. */
export function displayHost(target: ServerTarget): string | null {
  return target.kind === 'production' ? null : new URL(serverOrigin(target)).host
}

/**
 * `--server=<production|prod|development|dev|origin>`, honoured only by an
 * unpackaged build (tests and development); null when absent or invalid.
 */
export function parseServerArg(argv: readonly string[]): ServerTarget | null {
  const arg = argv.find((a) => a.startsWith('--server='))
  if (arg === undefined) return null
  const value = arg.slice('--server='.length)
  if (value === 'production' || value === 'prod') return { kind: 'production' }
  if (value === 'development' || value === 'dev') return { kind: 'development' }
  const origin = normalizeCustomOrigin(value)
  return origin === null ? null : { kind: 'custom', origin }
}

/**
 * The update feed's base URL, ending in `/` so `new URL(file, base)` keeps
 * the last path segment (`new URL('x.dmg', 'https://d/desktop')` would drop
 * `desktop`).
 */
export function feedBase(): string {
  return servers.updateFeed.endsWith('/') ? servers.updateFeed : `${servers.updateFeed}/`
}

/** The update signing key (OpenSSH one-line form), pinned in the build. */
export function updatePublicKey(): string {
  return servers.updatePublicKey
}
