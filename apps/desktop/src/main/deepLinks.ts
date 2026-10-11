/**
 * main/deepLinks.ts
 *
 * What a launch of the app carries (docs/plans/desktop-d0-spec.md §3.5,
 * §3.1): a `narrative://` link (the sign-in hand-off) and .pptx files the
 * operating system opened with it. A second launch hands this payload to the
 * running instance, and Electron drops an oversized hand-over message
 * entirely, so the payload is capped and validated on both sides. Pure: no
 * Electron here.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The scheme each build registers: the release build and an unpackaged dev build. */
export type DesktopScheme = 'narrative' | 'narrative-dev'

export interface LaunchPayload {
  deepLink: string | null
  files: string[]
}

export const MAX_LAUNCH_FILES = 20
export const MAX_LAUNCH_PATH_BYTES = 4096
/** The hand-over budget (JSON bytes) a second instance may send. */
export const MAX_LAUNCH_PAYLOAD_BYTES = 8 * 1024
const MAX_DEEP_LINK_LENGTH = 512

const TICKET = /^ndt_[A-Za-z0-9_-]{43}$/
const STATE = /^[A-Za-z0-9_-]{43}$/

function parseUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

/**
 * Read a launch's command line. Skips the executable, the app path, every
 * switch and the module after `-r` / `--require` (Playwright and Chromium
 * put their own arguments first, so positions are meaningless).
 */
export function parseLaunchArgs(
  argv: readonly string[],
  appPath: string,
  cwd: string,
  scheme: DesktopScheme,
): LaunchPayload {
  const payload: LaunchPayload = { deepLink: null, files: [] }
  const app = path.resolve(appPath)
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '-r' || arg === '--require') {
      i++
      continue
    }
    if (arg.startsWith('-')) continue
    if (path.resolve(cwd, arg) === app) continue
    const url = parseUrl(arg)
    if (url?.protocol === `${scheme}:`) {
      if (payload.deepLink === null && arg.length <= MAX_DEEP_LINK_LENGTH) payload.deepLink = arg
      continue
    }
    if (payload.files.length >= MAX_LAUNCH_FILES) continue
    const file = url?.protocol === 'file:' ? fileURLToPath(url) : url === null ? arg : null
    if (file !== null && file.toLowerCase().endsWith('.pptx')) {
      payload.files.push(path.resolve(cwd, file))
    }
  }
  return payload
}

/**
 * The payload a second instance hands over: the link first, then as many
 * files as fit the budget. `dropped` is how many files did not fit; the
 * second instance says so instead of losing them silently.
 */
export function capLaunchPayload(payload: LaunchPayload): {
  payload: LaunchPayload
  dropped: number
} {
  const capped: LaunchPayload = { deepLink: payload.deepLink, files: [] }
  let dropped = 0
  for (const file of payload.files) {
    const next = { ...capped, files: [...capped.files, file] }
    const fits =
      Buffer.byteLength(file) <= MAX_LAUNCH_PATH_BYTES &&
      capped.files.length < MAX_LAUNCH_FILES &&
      Buffer.byteLength(JSON.stringify(next)) <= MAX_LAUNCH_PAYLOAD_BYTES
    if (fits) capped.files.push(file)
    else dropped++
  }
  return { payload: capped, dropped }
}

/** The payload received from a second instance, or an empty one when it is malformed. */
export function validateLaunchPayload(data: unknown, scheme: DesktopScheme): LaunchPayload {
  const empty: LaunchPayload = { deepLink: null, files: [] }
  if (typeof data !== 'object' || data === null) return empty
  const raw = data as Record<string, unknown>
  const link = raw['deepLink']
  const deepLink =
    typeof link === 'string' &&
    link.length <= MAX_DEEP_LINK_LENGTH &&
    parseUrl(link)?.protocol === `${scheme}:`
      ? link
      : null
  const files = Array.isArray(raw['files'])
    ? raw['files']
        .filter(
          (f): f is string =>
            typeof f === 'string' &&
            Buffer.byteLength(f) <= MAX_LAUNCH_PATH_BYTES &&
            path.isAbsolute(f) &&
            f.toLowerCase().endsWith('.pptx'),
        )
        .slice(0, MAX_LAUNCH_FILES)
    : []
  return { deepLink, files }
}

/**
 * The ticket and state of a sign-in hand-off link
 * (`<scheme>://auth/complete?ticket=ndt_…&state=…`), or null for any other link.
 */
export function parseCompleteUrl(
  link: string,
  scheme: DesktopScheme,
): { ticket: string; state: string } | null {
  const url = parseUrl(link)
  if (url === null || url.protocol !== `${scheme}:`) return null
  if (url.host !== 'auth' || url.pathname !== '/complete') return null
  const ticket = url.searchParams.get('ticket')
  const state = url.searchParams.get('state')
  if (ticket === null || state === null || !TICKET.test(ticket) || !STATE.test(state)) return null
  if (
    url.searchParams.getAll('ticket').length !== 1 ||
    url.searchParams.getAll('state').length !== 1
  )
    return null
  return { ticket, state }
}
