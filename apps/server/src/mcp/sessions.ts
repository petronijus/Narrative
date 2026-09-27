/**
 * mcp/sessions.ts — stateful Streamable HTTP sessions (MCP transport spec
 * 2025-11-25, "Session Management").
 *
 *   - A session starts with an `initialize` POST without `Mcp-Session-Id`;
 *     the SDK transport assigns a random UUID and returns it in that header.
 *   - It is bound to ONE user and ONE credential (the PAT, or the OAuth
 *     grant — which survives token refresh) at initialize. Every later
 *     request must carry the session id AND authenticate as the same user
 *     with the same credential, or it gets 404 "Session not found" — the
 *     same answer as for an unknown id, so a session id is never an oracle,
 *     and a client re-initializes as the spec requires.
 *   - It ends on DELETE, after `idleMs` without requests (default 30 min),
 *     when its credential is revoked (an OAuth grant, or one personal access
 *     token — auth/agentSessions.ts), when the user's access is revoked as a
 *     whole (the account kill switch), when the user opens
 *     more than `maxPerUser` sessions (the least recently used one goes), or
 *     at shutdown. Ending a session closes its open runs (ServerHost
 *     `endSession`), which records them as closed.
 *   - The sweep (every minute) also RE-VERIFIES each live session's
 *     credential and its user's sign-in policy (`verifyCredential`) and ends
 *     the sessions whose credential died: a revoked or expired personal
 *     access token, a revoked OAuth grant, a user removed from the allowlist.
 *     The in-process revocation paths close sessions at once
 *     (auth/agentSessions.ts); the sweep is what reaches revocations made
 *     OUTSIDE this process — the `revokeUserAccess` ops script, a database
 *     edit, an allowlist change — so an idle open SSE stream dies within a
 *     minute instead of living until its next request. A verification that
 *     fails (database down) keeps the session and is logged: availability
 *     over a false close, the next request re-verifies anyway.
 * Sessions live in process memory: the API runs as one instance (like the
 * rate limiter). A restart ends every session; clients re-initialize.
 */

import { randomUUID } from 'node:crypto'
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type { AgentConfirmations } from '../agent/confirmations.js'
import type { ServerHost } from '../agent/serverHost.js'
import { credentialKey } from './auth.js'
import type { Guidance } from './guidance.js'
import { createSessionServer, type SessionIdentity } from './server.js'
import type { ToolCatalog } from './tools.js'

export const MCP_SESSION_IDLE_MS = 30 * 60_000
export const MCP_MAX_SESSIONS_PER_USER = 16
const SWEEP_INTERVAL_MS = 60_000
const SESSION_HEADER = 'mcp-session-id'

interface McpSession {
  id: string
  userId: string
  credentialKey: string
  transport: StreamableHTTPServerTransport
  server: Server
  lastSeen: number
  /** POSTs being handled; a session with work in flight is never reaped. */
  inFlight: number
  closed: boolean
}

export interface McpSessionManagerOptions {
  host: ServerHost
  /** Pending out-of-band confirmations, shared with the host and the confirmation page. */
  confirmations: AgentConfirmations
  /** The Narrative page of a confirmation (`<SPA>/confirm/<id>`). */
  confirmUrl: (id: string) => string
  catalog: ToolCatalog
  guidance: Guidance
  version: string
  log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>
  idleMs?: number
  maxPerUser?: number
  now?: () => number
  /** Start the idle sweeper (default true; tests call `sweep()` themselves). */
  sweep?: boolean
  /**
   * Is the credential a session was opened with still valid for its user —
   * token or grant live, and the user still allowed to sign in? Asked by the
   * sweep for every live session (once per credential). Without it the sweep
   * only reaps idle sessions.
   */
  verifyCredential?: (credentialKey: string, userId: string) => Promise<boolean>
}

function jsonRpcError(
  reply: FastifyReply,
  status: number,
  code: number,
  message: string,
): FastifyReply {
  return reply.status(status).send({ jsonrpc: '2.0', error: { code, message }, id: null })
}

export class McpSessionManager {
  private readonly sessions = new Map<string, McpSession>()
  private readonly idleMs: number
  private readonly maxPerUser: number
  private readonly now: () => number
  private readonly timer: ReturnType<typeof setInterval> | null
  /** A sweep is running; the next tick is skipped rather than overlapping it. */
  private sweeping = false

  constructor(private readonly opts: McpSessionManagerOptions) {
    this.idleMs = opts.idleMs ?? MCP_SESSION_IDLE_MS
    this.maxPerUser = opts.maxPerUser ?? MCP_MAX_SESSIONS_PER_USER
    this.now = opts.now ?? Date.now
    if (opts.sweep === false) this.timer = null
    else {
      this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS)
      this.timer.unref?.()
    }
  }

  get size(): number {
    return this.sessions.size
  }

  /** Session ids of a user (tests, diagnostics). */
  sessionsOf(userId: string): string[] {
    return [...this.sessions.values()].filter((s) => s.userId === userId).map((s) => s.id)
  }

  /** Serve one authenticated /mcp request (`req.user` / `req.auth` set by the pre-handler). */
  async handle(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const userId = req.user?.sub
    const credential = credentialKey(req)
    if (userId === undefined || credential === null) {
      await jsonRpcError(reply, 401, -32001, 'Unauthorized')
      return
    }
    const header = req.headers[SESSION_HEADER]
    const sessionId = Array.isArray(header) ? header[0] : header

    if (sessionId === undefined || sessionId === '') {
      if (req.method !== 'POST' || !isInitializeRequest(req.body)) {
        await jsonRpcError(
          reply,
          400,
          -32000,
          'Bad Request: no session. Start with an initialize request.',
        )
        return
      }
      const session = await this.open(userId, credential)
      await this.dispatch(session, req, reply)
      return
    }

    const session = this.sessions.get(sessionId)
    if (
      session === undefined ||
      session.closed ||
      session.userId !== userId ||
      session.credentialKey !== credential
    ) {
      await jsonRpcError(reply, 404, -32001, 'Session not found')
      return
    }
    await this.dispatch(session, req, reply)
  }

  private async open(userId: string, credential: string): Promise<McpSession> {
    await this.enforceUserCap(userId)
    const identity: SessionIdentity = { sessionId: null, userId }
    // Assigned right below; the transport callbacks only run after connect.
    let session!: McpSession
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        identity.sessionId = id
        session.id = id
        this.sessions.set(id, session)
        this.opts.log.info({ session: id, user: userId }, 'MCP session opened')
      },
      onsessionclosed: (id) => this.close(id, 'deleted by the client'),
    })
    const server = createSessionServer(identity, {
      host: this.opts.host,
      catalog: this.opts.catalog,
      guidance: this.opts.guidance,
      version: this.opts.version,
      confirmations: this.opts.confirmations,
      confirmUrl: this.opts.confirmUrl,
      onActivity: () => {
        session.lastSeen = this.now()
      },
      // Which client connected and what it can do (elicitation modes decide
      // how confirmations are asked, mcp/confirm.ts) — worth one log line.
      onInitialized: ({ clientName, capabilities }) => {
        this.opts.log.info(
          { session: session.id, user: userId, clientName: clientName ?? null, capabilities },
          'MCP client initialized',
        )
      },
    })
    session = {
      id: '',
      userId,
      credentialKey: credential,
      transport,
      server,
      lastSeen: this.now(),
      inFlight: 0,
      closed: false,
    }
    // Set before connect(): the SDK chains its own close handler after it.
    transport.onclose = () => {
      if (session.id !== '') void this.close(session.id, 'transport closed')
    }
    server.onerror = (err) => this.opts.log.warn({ err, session: session.id }, 'MCP session error')
    // The SDK's Node transport declares its optional callbacks without
    // `| undefined`, which our `exactOptionalPropertyTypes` rejects against
    // its own Transport interface; the object is that interface.
    await server.connect(transport as unknown as Transport)
    return session
  }

  private async dispatch(
    session: McpSession,
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    session.lastSeen = this.now()
    const counts = req.method === 'POST'
    if (counts) session.inFlight++
    // The transport writes the response itself (JSON or an SSE stream).
    reply.hijack()
    try {
      await session.transport.handleRequest(req.raw, reply.raw, req.body)
    } catch (err) {
      this.opts.log.error({ err, session: session.id }, 'MCP transport failed')
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' })
        reply.raw.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal error' },
            id: null,
          }),
        )
      }
    } finally {
      if (counts) session.inFlight--
      session.lastSeen = this.now()
    }
  }

  private async enforceUserCap(userId: string): Promise<void> {
    const mine = [...this.sessions.values()].filter((s) => s.userId === userId && !s.closed)
    if (mine.length < this.maxPerUser) return
    const oldest = mine
      .sort((a, b) => a.lastSeen - b.lastSeen)
      .slice(0, mine.length - this.maxPerUser + 1)
    for (const s of oldest) await this.close(s.id, 'too many sessions for this user')
  }

  /** End a session: close its transport and its open runs. Idempotent. */
  async close(sessionId: string, reason: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session === undefined || session.closed) return
    session.closed = true
    this.sessions.delete(sessionId)
    this.opts.log.info({ session: sessionId, user: session.userId, reason }, 'MCP session closed')
    try {
      await session.server.close()
    } catch (err) {
      this.opts.log.warn({ err, session: sessionId }, 'closing an MCP session transport failed')
    }
    try {
      await this.opts.host.endSession(`mcp:${sessionId}`)
    } catch (err) {
      this.opts.log.error({ err, session: sessionId }, 'closing the runs of an MCP session failed')
    }
  }

  /** End every session that authenticated with `credential` (a revoked grant or token). */
  async closeCredential(credential: string, reason = 'credential revoked'): Promise<number> {
    const matching = [...this.sessions.values()].filter((s) => s.credentialKey === credential)
    for (const s of matching) await this.close(s.id, reason)
    return matching.length
  }

  /** End every session of a user (the account kill switch, auth/agentCredentials.ts). */
  async closeUser(userId: string, reason = 'account access revoked'): Promise<number> {
    const matching = [...this.sessions.values()].filter((s) => s.userId === userId)
    for (const s of matching) await this.close(s.id, reason)
    return matching.length
  }

  /**
   * End idle sessions, then sessions whose credential no longer verifies
   * (see the file header). Runs every minute unless disabled.
   */
  async sweep(): Promise<void> {
    if (this.sweeping) return
    this.sweeping = true
    try {
      const cutoff = this.now() - this.idleMs
      const idle = [...this.sessions.values()].filter(
        (s) => s.inFlight === 0 && s.lastSeen < cutoff,
      )
      for (const s of idle) await this.close(s.id, 'idle')
      await this.closeDeadCredentials()
    } finally {
      this.sweeping = false
    }
  }

  private async closeDeadCredentials(): Promise<void> {
    const verify = this.opts.verifyCredential
    if (verify === undefined) return
    // One check per (credential, user): a user's sessions usually share one.
    const groups = new Map<string, McpSession[]>()
    for (const s of this.sessions.values()) {
      if (s.closed) continue
      const key = `${s.credentialKey}\u0000${s.userId}`
      const group = groups.get(key)
      if (group === undefined) groups.set(key, [s])
      else group.push(s)
    }
    const verdicts = await Promise.all(
      [...groups.values()].map(async (group) => {
        const { credentialKey, userId } = group[0]!
        try {
          return { group, live: await verify(credentialKey, userId) }
        } catch (err) {
          this.opts.log.warn(
            { err, user: userId },
            'MCP session sweep: verifying a credential failed; keeping its sessions',
          )
          return { group, live: true }
        }
      }),
    )
    for (const { group, live } of verdicts) {
      if (live) continue
      for (const s of group) await this.close(s.id, 'credential no longer valid')
    }
  }

  async closeAll(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer)
    for (const id of [...this.sessions.keys()]) await this.close(id, 'server shutdown')
  }
}
