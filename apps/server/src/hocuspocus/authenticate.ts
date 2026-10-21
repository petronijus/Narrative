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
 * Document epoch (ADR 0017): once access is granted, the document's epoch
 * and the instance's restore generation are read and the epoch to tell is
 * kept in the context (hocuspocus/documentEpoch.ts sends it); a token
 * claiming an epoch that is no longer current for what the client's Y.Doc
 * holds is refused with the reason `stale-document` — not counted as a
 * failed attempt, it is an honest client with an old copy.
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
import type { Database } from '../db/client.js'
import {
  resolveDeckAccess,
  resolveFolderContentAccess,
  resolveComponentAccess,
} from '../auth/permissions.js'
import { lookupSession, readCookieFromHeader, SESSION_COOKIE_NAME } from '../auth/session.js'
import { devSubFromCookieHeader } from '../auth/devIdentity.js'
import { claimedDocumentEpoch, looksLikeNarrativeCredential } from '@narrative/shared'
import { isRenderToken } from '../auth/renderTokens.js'
import { clientIpFromHeaders } from '../http/clientIp.js'
import { createFixedWindowLimiter, type FixedWindowLimiter } from '../http/fixedWindowLimiter.js'
import { subsystemLogger } from '../observability/logger.js'
import {
  DOC_EPOCH_CONTEXT_KEY,
  StaleDocumentError,
  claimIsCurrent,
  epochToTell,
  readDocumentEpoch,
} from './documentEpoch.js'

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

/**
 * The header carrying the upgrade request's peer address into the hooks.
 * Hocuspocus 4 hands hooks a web `Request`, which has no socket; the
 * server's `onUpgrade` (hocuspocus/index.ts) still sees the Node request and
 * writes the socket's address here — always, over whatever a client sent —
 * before the Request is built from it.
 */
export const PEER_ADDRESS_HEADER = 'x-narrative-peer-address'

/** The subset of Hocuspocus' `onAuthenticatePayload` this hook reads and writes. */
export interface WsAuthPayload {
  documentName: string
  token: string
  requestParameters: URLSearchParams
  requestHeaders: Headers
  connectionConfig: { readOnly: boolean }
  context: Record<string, unknown>
  /** The connecting socket (Hocuspocus' `socketId`). */
  socketId?: string
  /** The engine: which connections the document already has. */
  instance?: {
    documents: Map<string, { getConnections(): ReadonlyArray<{ socketId: string }> }>
  }
}

/**
 * Whether this socket already holds a connection to the document. Hocuspocus
 * 4 lets one socket open a document again under another session key
 * (`name\0sessionId`, session-aware providers); each passes onAuthenticate
 * and becomes one more connection every broadcast fans out to — thousands on
 * one socket from one share link. Our provider opens a document once per
 * socket (it does not enable session awareness), so a second one is refused.
 */
function socketAlreadyConnected(data: WsAuthPayload): boolean {
  if (data.socketId === undefined) return false
  const document = data.instance?.documents.get(data.documentName)
  return document?.getConnections().some((c) => c.socketId === data.socketId) ?? false
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
  const value = data.requestHeaders.get('authorization') ?? undefined
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
    return {
      userId: devSubFromCookieHeader(data.requestHeaders.get('cookie') ?? undefined),
      shareToken: null,
    }
  }

  // Authenticated path. The actual identity comes from the
  // `narrative_session` HttpOnly cookie carried on the WS upgrade, which is
  // same-origin with the SPA so the browser sends it automatically.
  const rawId = readCookieFromHeader(
    data.requestHeaders.get('cookie') ?? undefined,
    SESSION_COOKIE_NAME,
  )
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
   * Hocuspocus (2.15 through 4.x) builds a connection's context by merging what each hook
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
      Object.fromEntries(data.requestHeaders),
      data.requestHeaders.get(PEER_ADDRESS_HEADER) ?? undefined,
      deps.clientIpHeader,
    )
    if (failures.isBlocked(ip)) {
      log.warn({ doc: data.documentName, ip }, 'WebSocket authentication throttled')
      throw new Error(WS_TOO_MANY_ATTEMPTS)
    }

    const before = new Map(Object.entries(data.context))
    try {
      if (socketAlreadyConnected(data)) {
        log.warn(
          { doc: data.documentName, ip },
          'refused a second connection of one socket to a document',
        )
        throw new Error('Forbidden')
      }
      await authenticate(data)
    } catch (err) {
      // A well-formed render token is checked in memory (no database cost
      // to protect) and cannot be guessed; its refusals — a page holding a
      // token that just expired — must not lock the render worker's one
      // address out for everyone (auth/renderTokens.ts).
      // A stale epoch is an honest client holding an old copy (ADR 0017).
      const shareToken = data.requestParameters.get('share_token')
      const counted = !(err instanceof StaleDocumentError)
      if (counted && (shareToken === null || !isRenderToken(shareToken))) failures.hit(ip)
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

  /**
   * After the access check: the document's epoch into the context, and a
   * claim of another epoch for what the client holds refused (ADR 0017).
   */
  async function checkEpoch(data: WsAuthPayload): Promise<void> {
    const current = await readDocumentEpoch(db, data.documentName)
    // The owner was deleted between the access check and now.
    if (current === null) throw new Error('Forbidden')
    const claimed = claimedDocumentEpoch(data.token)
    if (claimed !== null && !claimIsCurrent(claimed, current)) {
      log.info(
        { doc: data.documentName, claimed, current },
        'refused a connection holding a stale document',
      )
      throw new StaleDocumentError(data.documentName, claimed, current)
    }
    data.context[DOC_EPOCH_CONTEXT_KEY] = epochToTell(current)
  }

  return async function authenticate(data: WsAuthPayload): Promise<void> {
    const { documentName, connectionConfig } = data
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
      connectionConfig.readOnly = true
      await checkEpoch(data)

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

      connectionConfig.readOnly = access.role === 'viewer'
      await checkEpoch(data)

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
    connectionConfig.readOnly = access.role === 'viewer'
    await checkEpoch(data)

    log.info(
      { doc: documentName, user: displayId, role: access.role, reason: access.reason },
      'authenticate',
    )
  }
}
