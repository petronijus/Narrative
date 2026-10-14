/**
 * hocuspocus/authenticate.ts
 *
 * The Hocuspocus `onAuthenticate` hook, extracted from hocuspocus/index.ts so
 * the real code (not a copy) is unit-testable without a WebSocket server.
 *
 * Who is connecting, in precedence order:
 *   1. `share_token` query parameter → anonymous share-link access (decks only).
 *   2. BYPASS_AUTH → `dev-user`.
 *   3. The `narrative_session` cookie on the upgrade (ADR 0005). The browser
 *      sends the sentinel `token: 'cookie'` purely to make Hocuspocus run
 *      this hook; the value itself is ignored.
 *
 * Agent credentials are NOT accepted here (ADR 0011) — personal access
 * tokens, MCP OAuth tokens and codes, upload session tokens. Agents write only
 * through the server host (`openDirectConnection`, apps/server/src/agent/),
 * which validates every command, asks for confirmation where required,
 * attributes the change to a run and records it in the audit log. A raw Yjs
 * connection authenticated by a token would bypass all four. A connection
 * that presents one — as the auth-frame token or as an `Authorization:
 * Bearer nrt_…` (`nmo_…`, `nus_…`) header on the upgrade — is refused outright rather than
 * silently falling back to a cookie or a share token, so a misconfigured
 * client fails loudly instead of acting as someone it did not intend to.
 *
 * Failed attempts are throttled per client IP (WS_FAILED_AUTH_LIMIT): once an
 * address has failed that many times within the window, further attempts are
 * refused before any database lookup until the window resets. A success does
 * not reset the count, so a caller holding one valid session cannot use it to
 * clear the counter between guesses.
 *
 * Doc name routing (M16 P2):
 *   `deck:<id>`      → deck access via resolveDeckAccess
 *   `folder:<id>`    → resolveFolderContentAccess: a folder member, or a guest
 *                      of one of its decks (a deck grant or a share link to
 *                      one of them), so a shared deck renders with its
 *                      folder's tokens; read-only for all (the server writes it)
 *   `component:<id>` → resolveComponentAccess: the folder role (no share-link);
 *                      read-only for a viewer
 *   Legacy bare name → treated as deck id (backward compat)
 */

import { createHash } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'
import type { Database } from '../db/client.js'
import {
  resolveDeckAccess,
  resolveFolderContentAccess,
  resolveComponentAccess,
} from '../auth/permissions.js'
import { lookupSession, readCookieFromHeader, SESSION_COOKIE_NAME } from '../auth/session.js'
import { devSubFromCookieHeader } from '../auth/devIdentity.js'
import { looksLikeNarrativeCredential } from '@narrative/shared'
import { isRenderToken } from '../auth/renderTokens.js'
import { clientIpFromHeaders } from '../http/clientIp.js'
import { createFixedWindowLimiter, type FixedWindowLimiter } from '../http/fixedWindowLimiter.js'
import { subsystemLogger } from '../observability/logger.js'

const log = subsystemLogger('hocuspocus')

/**
 * Failed WebSocket authentications allowed per client IP per window. A
 * browser whose access was revoked retries with backoff and stays far below
 * it; a share-token or cookie spray does not.
 */
export const WS_FAILED_AUTH_LIMIT = { max: 30, windowMs: 10 * 60_000 } as const

/** Thrown (and sent to the client as the close reason) once an IP is throttled. */
export const WS_TOO_MANY_ATTEMPTS = 'Too many failed attempts'

export interface WsAuthDeps {
  db: Database
  bypass: boolean
  /**
   * Header carrying the real client IP behind the proxy chain (production:
   * `cf-connecting-ip`, see http/clientIp.ts). Unset → the socket address.
   */
  clientIpHeader?: string | undefined
  /** Failed-attempt counter; defaults to one sized by WS_FAILED_AUTH_LIMIT. */
  failedAuthLimiter?: FixedWindowLimiter
}

/** The subset of Hocuspocus' `onAuthenticatePayload` this hook reads and writes. */
export interface WsAuthPayload {
  documentName: string
  token: string
  requestParameters: URLSearchParams
  requestHeaders: IncomingHttpHeaders
  /** The upgrade request; only its peer address is read. */
  request?: { socket?: { remoteAddress?: string | undefined } | undefined }
  connection: { readOnly: boolean }
  context: Record<string, unknown>
}

/**
 * How a share-link connection is named in its context and the logs: a hash
 * prefix, never characters of the token itself (a link stays valid until
 * revoked; a render token is a credential too).
 */
function shareDisplayId(shareToken: string | null): string {
  return `share:${createHash('sha256')
    .update(shareToken ?? '')
    .digest('hex')
    .slice(0, 8)}`
}

interface WsPrincipal {
  userId: string | null
  shareToken: string | null
}

/**
 * Does this connection present an agent credential anywhere — a personal
 * access token, an MCP OAuth token or code, an upload session token?
 */
function presentsAgentCredential(data: WsAuthPayload): boolean {
  const header = data.requestHeaders['authorization']
  const value = Array.isArray(header) ? header[0] : header
  const bearer = value === undefined ? undefined : /^Bearer[ \t]+(\S+)/i.exec(value)?.[1]
  return looksLikeNarrativeCredential(data.token) || looksLikeNarrativeCredential(bearer)
}

async function resolvePrincipal(data: WsAuthPayload, deps: WsAuthDeps): Promise<WsPrincipal> {
  if (presentsAgentCredential(data)) {
    log.warn(
      { doc: data.documentName },
      'refused a WebSocket connection presenting an agent credential',
    )
    throw new Error('Forbidden')
  }

  // Share token may arrive as a query param in the WS upgrade URL.
  // e.g. ws://host:3002?share_token=<id>
  // HocuspocusProvider appends query params to the WS URL and Hocuspocus
  // exposes them as `requestParameters: URLSearchParams` in the payload.
  const shareToken = data.requestParameters.get('share_token')
  if (shareToken) {
    // Share-token access — skip session validation entirely.
    // resolveDeckAccess validates the token; a folder doc admits it
    // read-only when it links to a deck of the folder. A component doc
    // admits no share link — only a render token minted for that master.
    return { userId: null, shareToken }
  }

  // BYPASS_AUTH (dev only): `dev-user`, or the synthetic identity the
  // `narrative_dev_as` cookie names (auth/devIdentity.ts).
  if (deps.bypass) {
    return { userId: devSubFromCookieHeader(data.requestHeaders['cookie']), shareToken: null }
  }

  // Authenticated path. The actual identity comes from the
  // `narrative_session` HttpOnly cookie carried on the WS upgrade, which is
  // same-origin with the SPA so the browser sends it automatically.
  const rawId = readCookieFromHeader(data.requestHeaders['cookie'], SESSION_COOKIE_NAME)
  if (!rawId) throw new Error('Invalid credentials')
  const session = await lookupSession(deps.db, rawId)
  if (!session) throw new Error('Invalid credentials')
  return { userId: session.userSub, shareToken: null }
}

export function createOnAuthenticate(deps: WsAuthDeps) {
  const authenticate = createAuthenticate(deps)
  const failures =
    deps.failedAuthLimiter ??
    createFixedWindowLimiter({
      max: WS_FAILED_AUTH_LIMIT.max,
      windowMs: WS_FAILED_AUTH_LIMIT.windowMs,
    })

  /**
   * Hocuspocus 2.15 builds a connection's context by merging what each hook
   * RETURNS into `hookPayload.context`, replacing that object with a spread
   * copy after every hook. `onConnect` and `onAuthenticate` of one
   * connection can overlap (the auth message arrives while the async
   * `onConnect` is still running), so when `onConnect`'s merge swaps the
   * object while this hook awaits the database, writes made to
   * `data.context` land on a discarded object and the connection ends up
   * without `userId`/`role` — breaking CONN-1 revocation, the active-editor
   * bubbles and the agent's `editor.context` / `editor.show`. The writes
   * therefore also come back as the hook's return value, which Hocuspocus
   * merges into whichever context object is current.
   */
  return async function onAuthenticate(data: WsAuthPayload): Promise<Record<string, unknown>> {
    const ip = clientIpFromHeaders(
      data.requestHeaders,
      data.request?.socket?.remoteAddress,
      deps.clientIpHeader,
    )
    if (failures.isBlocked(ip)) {
      log.warn({ doc: data.documentName, ip }, 'WebSocket authentication throttled')
      throw new Error(WS_TOO_MANY_ATTEMPTS)
    }

    const before = new Map(Object.entries(data.context))
    try {
      await authenticate(data)
    } catch (err) {
      // A well-formed render token is checked in memory (no database cost
      // to protect) and cannot be guessed; its refusals — a page holding a
      // token that just expired — must not lock the render worker's one
      // address out for everyone (auth/renderTokens.ts).
      const shareToken = data.requestParameters.get('share_token')
      if (shareToken === null || !isRenderToken(shareToken)) failures.hit(ip)
      throw err
    }
    const additions: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(data.context)) {
      if (!before.has(key) || before.get(key) !== value) additions[key] = value
    }
    return additions
  }
}

function createAuthenticate(deps: WsAuthDeps) {
  const { db } = deps

  return async function authenticate(data: WsAuthPayload): Promise<void> {
    const { documentName, connection } = data
    const { userId, shareToken } = await resolvePrincipal(data, deps)

    if (documentName.startsWith('folder:')) {
      // Folder doc — its members, and read-only the guests of its decks.
      const folderId = documentName.slice('folder:'.length)
      const access = await resolveFolderContentAccess(db, { folderId, userId, shareToken })
      if (!access) throw new Error('Forbidden')

      const displayId = userId ?? shareDisplayId(shareToken)
      // Write the context here; the exported wrapper returns these writes so
      // Hocuspocus merges them (see createOnAuthenticate).
      data.context.userId = displayId
      data.context.folderId = folderId
      data.context.role = access.role
      // CONN-1: a revoked share link closes this connection too.
      if (shareToken) data.context.shareToken = shareToken

      // Read-only for every role: tokens change only through the server
      // (services/tokens.ts validates them and carries a change into the
      // folder's decks), which writes over its own direct connection. A
      // browser writing raw updates would bypass both.
      connection.readOnly = true

      log.info(
        { doc: documentName, user: displayId, role: access.role, reason: access.via },
        'authenticate',
      )
      return
    }

    if (documentName.startsWith('component:')) {
      // Component doc — the folder's members with their folder role. No share
      // link reaches it; the render page of the master's card does, with a
      // render token minted for this component, read-only.
      const componentId = documentName.slice('component:'.length)
      const access = await resolveComponentAccess(db, { componentId, userId, shareToken })
      if (!access) throw new Error('Forbidden')

      const displayId = userId ?? shareDisplayId(shareToken)
      data.context.userId = displayId
      data.context.componentId = componentId
      data.context.role = access.role
      // A render token's connection ends with the token.
      if (access.reason === 'render' && shareToken) data.context.shareToken = shareToken

      connection.readOnly = access.role === 'viewer'

      log.info(
        { doc: documentName, user: displayId, role: access.role, reason: access.reason },
        'authenticate',
      )
      return
    }

    // Deck doc (deck:<id> prefix or legacy bare id)
    const access = await resolveDeckAccess(db, {
      deckId: documentName,
      userId,
      shareToken,
    })
    if (!access) throw new Error('Forbidden')

    const displayId = userId ?? shareDisplayId(shareToken)

    data.context.userId = displayId
    data.context.deckId = documentName
    data.context.role = access.role

    // CONN-1: record the principal that authorised this connection so a
    // later revocation can target exactly the right live connections.
    //   - share-token connections carry the full token (userId is only the
    //     `share:<hash>` display id, not enough to disambiguate).
    //   - authenticated connections carry the real userId via displayId.
    if (shareToken) {
      data.context.shareToken = shareToken
    }
    // Resolve the bare deck id (strip the optional `deck:` prefix) so
    // revoke sites can match on the same id the DB / routes use.
    data.context.deckIdResolved = documentName.startsWith('deck:')
      ? documentName.slice('deck:'.length)
      : documentName

    // Mark connection as readOnly for viewer role.
    // Hocuspocus won't accept update messages from readOnly connections.
    connection.readOnly = access.role === 'viewer'

    log.info(
      { doc: documentName, user: displayId, role: access.role, reason: access.reason },
      'authenticate',
    )
  }
}
