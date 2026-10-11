/**
 * routes/desktopAuth.ts
 *
 * The desktop app's sign-in (ADR 0014, docs/plans/desktop-d0-spec.md §4).
 * Google refuses OAuth inside an Electron window, so the shell signs in
 * through the system browser and gets the result back as a one-time ticket:
 *
 *   GET  /auth/start?client=desktop&scheme=…&code_challenge=…
 *        &code_challenge_method=S256&desktop_state=…&returnTo=…
 *        → the browser sign-in of routes/auth.ts, with the desktop request
 *          carried in its signed state cookie (parseDesktopStart);
 *   GET  /auth/callback (desktop branch)
 *        → no session for the browser; a page that opens
 *          `<scheme>://auth/complete?ticket=ndt_…&state=…` (sendDesktopHandoff);
 *   POST /auth/desktop/redeem   ticket + verifier, form-encoded
 *        → the shell's hidden window posts this as a navigation in its own
 *          partition: a fresh session, the ordinary session cookie, 303 into
 *          the app (registerDesktopAuthRoutes).
 *
 * Why each piece:
 *   - The custom-scheme URL is a constant per registered scheme, never built
 *     from the request: `returnTo` stays a relative path (isSafeReturnTo).
 *   - The ticket is bound to the shell's PKCE challenge (auth/desktopTickets.ts),
 *     so another app that registers `narrative://` and catches the link
 *     cannot redeem it.
 *   - `desktop_state` is the shell's own nonce, echoed back in the link: the
 *     shell takes a link only for a sign-in it started (login CSRF into the
 *     app).
 *   - A page rather than a 302 keeps the ticket out of `Location` and so out
 *     of the proxy's access log.
 *   - The redeem takes only a navigation the shell starts itself
 *     (`Sec-Fetch-Site: none` plus the `X-Narrative-Desktop` header, which no
 *     form on any page can send), so no page — not even one on the app's own
 *     origin — can swap a browser's session for an attacker's (login CSRF);
 *     every failure gets the same answer, so it is no oracle.
 *   - Production hands tickets only to the release build's scheme; the dev
 *     build's scheme works against a development server only.
 *   - The hand-off page names the account and the desktop app, so a sign-in
 *     the person did not start (a local app that registered `narrative://`
 *     and opened the start URL itself, RFC 8252 §8.6) is visible; Google's
 *     account chooser (`prompt=select_account`) always asks first.
 *
 * Paths are registered without `/api` (Caddy strips it), like routes/auth.ts.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  DESKTOP_TICKET_TTL_MS,
  mintDesktopTicket,
  redeemDesktopTicket,
  type DesktopScheme,
  type DesktopTicketGrant,
} from '../auth/desktopTickets.js'
import { PKCE_CHALLENGE } from '../auth/pkce.js'
import { createSession, revokeSession, SESSION_COOKIE_NAME } from '../auth/session.js'
import { isSafeReturnTo, setSessionCookie } from '../auth/sessionCookie.js'
import { clientIpFromHeaders } from '../http/clientIp.js'
import { parseStrictForm } from '../http/formBody.js'
import { htmlHeaders, noStore } from '../http/htmlHeaders.js'
import type { AuthRoutesOpts } from './auth.js'

/** Where a ticket goes, per scheme a desktop build registers — the only custom-scheme targets. */
export const DESKTOP_COMPLETE_URLS: Readonly<Record<DesktopScheme, string>> = {
  narrative: 'narrative://auth/complete',
  'narrative-dev': 'narrative-dev://auth/complete',
}

/**
 * Limit of the redeem per caller (the client IP; the user, when the window
 * still carries a valid session — http/rateLimit.ts `rateLimitKey`): a person
 * signs in a few times a day, a retry loop is bounded.
 */
export const DESKTOP_REDEEM_RATE_LIMIT = { max: 30, timeWindow: 60_000 } as const

/** The `/auth/error` reason of every failed redeem. */
export const DESKTOP_SIGN_IN_FAILED = 'desktop_sign_in_failed'

/** The header the shell's redeem navigation carries; a form cannot set it. */
export const DESKTOP_SHELL_HEADER = 'x-narrative-desktop'

const DESKTOP_STATE = /^[A-Za-z0-9_-]{43}$/
const FORM_BODY_LIMIT = 1024
const DESKTOP_PARAMS = [
  'scheme',
  'code_challenge',
  'code_challenge_method',
  'desktop_state',
] as const

/** The desktop part of a sign-in, carried in the signed OAuth state cookie. */
export interface DesktopStartState {
  challenge: string
  scheme: DesktopScheme
  state: string
}

export type DesktopStart =
  | { kind: 'web' }
  | { kind: 'desktop'; desktop: DesktopStartState }
  | { kind: 'invalid' }

function isDesktopScheme(value: unknown): value is DesktopScheme {
  return typeof value === 'string' && Object.hasOwn(DESKTOP_COMPLETE_URLS, value)
}

/** Whether a value read back from the state cookie is a well-formed desktop request. */
export function isDesktopStartState(value: unknown): value is DesktopStartState {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v['challenge'] === 'string' &&
    PKCE_CHALLENGE.test(v['challenge']) &&
    isDesktopScheme(v['scheme']) &&
    typeof v['state'] === 'string' &&
    DESKTOP_STATE.test(v['state'])
  )
}

/** The schemes a server hands tickets to: production only the release build's. */
export function allowedDesktopSchemes(isProd: boolean): readonly DesktopScheme[] {
  return isProd ? ['narrative'] : ['narrative', 'narrative-dev']
}

/**
 * Read the desktop parameters of `/auth/start`. Without `client` it is the
 * browser sign-in, which must not carry any desktop parameter either; with
 * `client=desktop` every parameter must be present, single and well formed,
 * and the scheme one this server serves.
 */
export function parseDesktopStart(
  query: Readonly<Record<string, unknown>>,
  isProd: boolean,
): DesktopStart {
  const client = query['client']
  if (client === undefined) {
    return DESKTOP_PARAMS.some((p) => query[p] !== undefined)
      ? { kind: 'invalid' }
      : { kind: 'web' }
  }
  if (client !== 'desktop' || query['code_challenge_method'] !== 'S256') return { kind: 'invalid' }
  const desktop = {
    challenge: query['code_challenge'],
    scheme: query['scheme'],
    state: query['desktop_state'],
  }
  if (!isDesktopStartState(desktop)) return { kind: 'invalid' }
  if (!allowedDesktopSchemes(isProd).includes(desktop.scheme)) return { kind: 'invalid' }
  return { kind: 'desktop', desktop }
}

/** The custom-scheme link that hands a ticket to the shell. */
export function desktopHandoffUrl(desktop: DesktopStartState, ticket: string): string {
  const url = new URL(DESKTOP_COMPLETE_URLS[desktop.scheme])
  url.searchParams.set('ticket', ticket)
  url.searchParams.set('state', desktop.state)
  return url.toString()
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

/** The page the system browser shows after Google: it opens the app and says what to do next. */
export function desktopHandoffPage(url: string, email: string): string {
  const href = escapeHtml(url)
  const account = escapeHtml(email)
  const seconds = Math.round(DESKTOP_TICKET_TTL_MS / 1000)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="refresh" content="0;url=${href}">
<title>Opening Narrative</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; background: #030712; color: #f3f4f6; display: grid; place-items: center; min-height: 100vh; margin: 0; }
  main { max-width: 26rem; padding: 2rem; border: 1px solid #1f2937; border-radius: 0.5rem; background: #111827; }
  a { display: inline-block; margin: 1rem 0; padding: 0.6rem 1rem; border-radius: 0.375rem; background: #2563eb; color: #fff; text-decoration: none; }
  p { color: #9ca3af; margin: 0; }
</style>
</head>
<body>
<main>
<h1>Sign in to the Narrative desktop app</h1>
<p>You signed in as <strong>${account}</strong> for the Narrative desktop app. Narrative should open now. If it does not, open it with this button within ${seconds} seconds.</p>
<a href="${href}">Open Narrative</a>
<p>You can close this tab once Narrative has opened. If you did not start this sign-in, close this tab and do not open Narrative.</p>
</main>
</body>
</html>
`
}

/** Answer the callback of a desktop sign-in: mint the ticket and hand it to the shell. */
export async function sendDesktopHandoff(
  reply: FastifyReply,
  grant: DesktopTicketGrant,
  desktop: DesktopStartState,
): Promise<void> {
  const ticket = mintDesktopTicket(grant, desktop.challenge)
  await htmlHeaders(reply, [])
    .status(200)
    .send(desktopHandoffPage(desktopHandoffUrl(desktop, ticket), grant.user.email))
}

function header(req: FastifyRequest, name: string): string | undefined {
  const raw = req.headers[name]
  return Array.isArray(raw) ? raw[0] : raw
}

/**
 * Whether the redeem was started by the shell itself. Its hidden window posts
 * it as a navigation it starts (`webContents.loadURL` with `postData`), which
 * a browser marks `Sec-Fetch-Site: none`, and adds `X-Narrative-Desktop: 1`,
 * which no HTML form can send. Nothing else may redeem: not another site
 * (`cross-site`, `same-site`), and not a page on the app's own origin
 * (`same-origin` — an inline upload or an XSS there could otherwise swap the
 * person's session for an attacker's). Without fetch metadata only a request
 * with no `Origin` at all passes, and still only with the header.
 */
export function isDesktopRedeemSource(req: FastifyRequest): boolean {
  if (header(req, DESKTOP_SHELL_HEADER) !== '1') return false
  const site = header(req, 'sec-fetch-site')
  if (site !== undefined) return site === 'none'
  return header(req, 'origin') === undefined
}

/** The redeem route; registered (awaited) next to routes/auth.ts. */
export async function registerDesktopAuthRoutes(
  app: FastifyInstance,
  opts: AuthRoutesOpts,
): Promise<void> {
  const { db, verifier, spaOrigin, isProd, clientIpHeader } = opts
  const configured = (): boolean =>
    Boolean(process.env['OIDC_CLIENT_ID'] && process.env['OIDC_CLIENT_SECRET'] && verifier)
  const failed = `${spaOrigin}/auth/error?reason=${DESKTOP_SIGN_IN_FAILED}`

  // Its own scope that takes a form body only, parsed strictly
  // (http/formBody.ts); any other content type is answered 415.
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers()
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: FORM_BODY_LIMIT },
      (_req, body, done) => {
        try {
          done(null, parseStrictForm(body as string))
        } catch (e) {
          done(e as Error, undefined)
        }
      },
    )

    scope.post(
      '/auth/desktop/redeem',
      { config: { rateLimit: DESKTOP_REDEEM_RATE_LIMIT } },
      async (req, reply) => {
        noStore(reply)
        if (!configured()) return reply.status(500).send({ error: 'auth_not_configured' })
        if (!isDesktopRedeemSource(req)) {
          return reply.status(403).send({ error: 'forbidden_origin' })
        }
        const body = (req.body ?? {}) as Record<string, unknown>
        const grant = redeemDesktopTicket(body['ticket'], body['verifier'])
        if (grant === null) {
          // Never the ticket itself: it is a credential until it is used.
          req.log.warn({ reason: 'invalid_ticket' }, '[auth] desktop ticket refused')
          return reply.redirect(failed, 303)
        }

        // A session this window held before (another account, or a stale
        // one) ends here; the new one is minted fresh, so nothing an attacker
        // planted in the jar survives the sign-in. The same person's editors
        // on other devices stay connected.
        const previous = req.cookies[SESSION_COOKIE_NAME]
        if (previous) await revokeSession(db, previous, { keepConnectionsOf: grant.user.sub })

        const { rawId, expiresAt } = await createSession(db, {
          user: grant.user,
          userAgent: req.headers['user-agent']?.slice(0, 512),
          ip: clientIpFromHeaders(req.headers, req.ip, clientIpHeader),
        })
        setSessionCookie(reply, rawId, expiresAt, isProd)
        req.log.info({ sub: grant.user.sub }, '[auth] desktop sign-in redeemed')
        const returnTo = isSafeReturnTo(grant.returnTo) ? grant.returnTo : '/'
        return reply.redirect(`${spaOrigin}${returnTo}`, 303)
      },
    )
  })
}
