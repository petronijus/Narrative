/**
 * mcp/oauth/store.ts — persistence of the MCP OAuth authorization server
 * (migrations 0018, 0021). An interface with a Drizzle implementation and an
 * in-memory one with the same semantics for tests. Every state transition
 * that must happen at most once (deciding a consent, exchanging a code,
 * rotating a refresh token) is a single conditional UPDATE, so two
 * concurrent requests cannot both win.
 *
 * Client ids: records carry the client_id exactly as the client sends it —
 * a registered client's random id, or a Client ID Metadata Document client's
 * https URL (clientMetadata.ts). The Drizzle store keeps the two in separate
 * columns (`client_id` with its foreign key to mcp_oauth_clients, and
 * `client_metadata_url`, exactly one set), because a metadata-document
 * client is never a row of mcp_oauth_clients.
 *
 * Retention (`purgeRetained`, hourly through the service's maintenance):
 * authorizations decided or exchanged, and grants revoked, more than
 * RETENTION (30 days, service.ts) ago are deleted — registered and
 * metadata-document clients alike — so the tables hold recent history, not
 * every connection ever made.
 */

import { and, desc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm'
import type { Database } from '../../db/client.js'
import {
  mcpOauthAuthorizations,
  mcpOauthClients,
  mcpOauthGrants,
  mcpOauthTokens,
  users,
} from '../../db/schema.js'
import { isClientIdMetadataUrl } from './clientMetadata.js'

export type TokenEndpointAuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic'

export interface ClientRecord {
  id: string
  clientName: string
  redirectUris: string[]
  tokenEndpointAuthMethod: TokenEndpointAuthMethod
  clientSecretHash: string | null
  clientUri: string | null
  softwareId: string | null
  softwareVersion: string | null
  /** Registered scopes (migration 0022). Null on older registrations: every supported scope. */
  scopes: string[] | null
  /** Registered grant types (migration 0022). Null on older registrations: both. */
  grantTypes: string[] | null
  createdAt: Date
  lastUsedAt: Date | null
}

export interface AuthorizationRecord {
  id: string
  /** Registered client id, or a metadata-document client's URL. */
  clientId: string
  /** The client's name when the request was made (display). Null on rows before migration 0021. */
  clientName: string | null
  /** Every redirect URI the client declared when the request was made. Null before 0021. */
  clientRedirectUris: string[] | null
  redirectUri: string
  /** /authorize received redirect_uri explicitly, so /token must repeat it (migration 0022). */
  redirectUriProvided: boolean
  /** The client's grant types when the request was made (migration 0022; null before). */
  clientGrantTypes: string[] | null
  codeChallenge: string
  scopes: string[]
  resource: string
  state: string | null
  csrfHash: string
  userSub: string | null
  createdAt: Date
  expiresAt: Date
  decidedAt: Date | null
  decision: 'approved' | 'denied' | null
  codeHash: string | null
  codeExpiresAt: Date | null
  exchangedAt: Date | null
  grantId: string | null
}

export interface GrantRecord {
  id: string
  /** Registered client id, or a metadata-document client's URL. */
  clientId: string
  /** The client's name when the user approved it. Null on grants before migration 0021. */
  clientName: string | null
  /** The redirect URI the user approved. Null on grants before migration 0021. */
  redirectUri: string | null
  userSub: string
  scopes: string[]
  /** The client's grant types when the user approved it (migration 0022; null before = refresh allowed). */
  grantTypes: string[] | null
  resource: string
  createdAt: Date
  lastUsedAt: Date | null
  revokedAt: Date | null
  /** A refresh token of the grant was replayed (migration 0022). */
  flaggedAt: Date | null
  flagReason: string | null
}

export interface TokenRecord {
  tokenHash: string
  grantId: string
  kind: 'access' | 'refresh'
  createdAt: Date
  expiresAt: Date
  usedAt: Date | null
  /** Refresh tokens: fingerprint of the request that rotated it (migration 0022). */
  usedByFingerprint: string | null
  revokedAt: Date | null
}

/** A grant with what the sign-in policy needs to know about its user. */
export interface GrantOwnerLookup {
  grant: GrantRecord
  userEmail: string | null
  userEmailVerified: boolean
}

/** What one retention purge deleted. */
export interface RetentionPurge {
  authorizations: number
  grants: number
}

/** A token with the grant and client it belongs to (what verification needs). */
export interface TokenLookup {
  token: TokenRecord
  grant: GrantRecord
  client: Pick<ClientRecord, 'id' | 'clientName'>
  userEmail: string | null
  userName: string | null
  userEmailVerified: boolean
}

export interface ConnectionRecord {
  grant: GrantRecord
  clientName: string
  /** Where the connection returns to: the approved redirect URI, or (older grants) the client's. */
  redirectUris: string[]
  kind: 'registered' | 'metadata_document'
}

/** The name shown for a client whose name is known nowhere (a deleted registration). */
export const UNKNOWN_CLIENT_NAME = 'Unknown application'

export interface McpOAuthStore {
  insertClient(client: ClientRecord): Promise<void>
  getClient(id: string): Promise<ClientRecord | null>
  touchClient(id: string, at: Date): Promise<void>

  insertAuthorization(a: AuthorizationRecord): Promise<void>
  getAuthorization(id: string): Promise<AuthorizationRecord | null>
  /**
   * Bind the consenting user and set a fresh consent-form CSRF hash: succeeds
   * when unbound or already bound to `userSub`, undecided and unexpired.
   */
  bindAuthorizationUser(id: string, userSub: string, csrfHash: string, now: Date): Promise<boolean>
  /** Record the decision once: undecided, unexpired and bound to `userSub`. */
  decideAuthorization(
    id: string,
    userSub: string,
    decision: { approved: true; codeHash: string; codeExpiresAt: Date } | { approved: false },
    now: Date,
  ): Promise<boolean>
  /** Mark a code exchanged once; returns the authorization, or null when unknown or already exchanged. */
  claimCode(codeHash: string, now: Date): Promise<AuthorizationRecord | null>
  findAuthorizationByCode(codeHash: string): Promise<AuthorizationRecord | null>
  setAuthorizationGrant(id: string, grantId: string): Promise<void>

  insertGrant(g: GrantRecord): Promise<void>
  /** Revoke a grant and all its tokens. Returns whether it was live. */
  revokeGrant(id: string, now: Date): Promise<boolean>
  /** Revoke a grant only if it belongs to `userSub`. */
  revokeUserGrant(userSub: string, id: string, now: Date): Promise<boolean>
  listUserGrants(userSub: string): Promise<ConnectionRecord[]>
  touchGrant(id: string, now: Date, notBefore: Date): Promise<void>
  /** Mark a grant as suspicious (a refresh replay); the first flag's time is kept. */
  flagGrant(id: string, reason: string, now: Date): Promise<void>
  /** A grant with its user's email, for re-checking the sign-in policy (the MCP session sweep). */
  getGrantOwner(id: string): Promise<GrantOwnerLookup | null>
  /**
   * The account kill switch: revoke every live grant of the user with its
   * tokens, AND expire every authorization of theirs that has not been
   * exchanged yet — undecided requests and approved codes alike — so a code
   * decided before the kill switch can never be exchanged after it. One
   * transaction. Returns how many grants were revoked.
   */
  revokeAllForUser(userSub: string, now: Date): Promise<number>

  insertToken(t: TokenRecord): Promise<void>
  findToken(tokenHash: string): Promise<TokenLookup | null>
  /**
   * Mark a refresh token used once, recording the rotating request's
   * fingerprint; false when it was already used or revoked.
   */
  useRefreshToken(tokenHash: string, now: Date, fingerprint: string | null): Promise<boolean>
  /** Delete expired tokens and authorizations older than `before`. */
  purgeExpired(before: Date): Promise<void>
  /**
   * Delete authorizations decided or exchanged before `before` (never a
   * pending one) and grants revoked before `before` (tokens cascade).
   */
  purgeRetained(before: Date): Promise<RetentionPurge>
  /**
   * Delete registered (DCR) clients inactive since `inactiveBefore` (last
   * used, or created when never used) that have no live grant and no
   * authorization request still pending at `now`; their revoked grants,
   * tokens and old authorizations go with them. Returns how many clients.
   */
  deleteStaleRegisteredClients(inactiveBefore: Date, now: Date): Promise<number>
}

// ---------------------------------------------------------------------------
// Drizzle
// ---------------------------------------------------------------------------

function toClient(row: typeof mcpOauthClients.$inferSelect): ClientRecord {
  return {
    ...row,
    tokenEndpointAuthMethod: row.tokenEndpointAuthMethod as TokenEndpointAuthMethod,
    scopes: row.scopes ?? null,
    grantTypes: row.grantTypes ?? null,
  }
}

/** The two client columns for a client_id (see the file header). */
function clientColumns(clientId: string): {
  clientId: string | null
  clientMetadataUrl: string | null
} {
  return isClientIdMetadataUrl(clientId)
    ? { clientId: null, clientMetadataUrl: clientId }
    : { clientId, clientMetadataUrl: null }
}

function clientIdOf(row: { clientId: string | null; clientMetadataUrl: string | null }): string {
  return row.clientId ?? row.clientMetadataUrl ?? ''
}

function toAuthorization(row: typeof mcpOauthAuthorizations.$inferSelect): AuthorizationRecord {
  return {
    id: row.id,
    clientId: clientIdOf(row),
    clientName: row.clientName,
    clientRedirectUris: row.clientRedirectUris,
    redirectUri: row.redirectUri,
    redirectUriProvided: row.redirectUriProvided,
    clientGrantTypes: row.clientGrantTypes ?? null,
    codeChallenge: row.codeChallenge,
    scopes: row.scopes,
    resource: row.resource,
    state: row.state,
    csrfHash: row.csrfHash,
    userSub: row.userSub,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    decidedAt: row.decidedAt,
    decision:
      row.decision === 'approved' ? 'approved' : row.decision === 'denied' ? 'denied' : null,
    codeHash: row.codeHash,
    codeExpiresAt: row.codeExpiresAt,
    exchangedAt: row.exchangedAt,
    grantId: row.grantId,
  }
}

function toGrant(row: typeof mcpOauthGrants.$inferSelect): GrantRecord {
  return {
    id: row.id,
    clientId: clientIdOf(row),
    clientName: row.clientName,
    redirectUri: row.redirectUri,
    userSub: row.userSub,
    scopes: row.scopes,
    grantTypes: row.grantTypes ?? null,
    resource: row.resource,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    flaggedAt: row.flaggedAt ?? null,
    flagReason: row.flagReason ?? null,
  }
}

function toToken(row: typeof mcpOauthTokens.$inferSelect): TokenRecord {
  return {
    ...row,
    kind: row.kind === 'refresh' ? 'refresh' : 'access',
    usedByFingerprint: row.usedByFingerprint ?? null,
  }
}

export function createDrizzleOAuthStore(db: Database): McpOAuthStore {
  const store: McpOAuthStore = {
    async insertClient(client) {
      await db.insert(mcpOauthClients).values(client)
    },
    async getClient(id) {
      const [row] = await db
        .select()
        .from(mcpOauthClients)
        .where(eq(mcpOauthClients.id, id))
        .limit(1)
      return row ? toClient(row) : null
    },
    async touchClient(id, at) {
      await db.update(mcpOauthClients).set({ lastUsedAt: at }).where(eq(mcpOauthClients.id, id))
    },

    async insertAuthorization(a) {
      await db.insert(mcpOauthAuthorizations).values({ ...a, ...clientColumns(a.clientId) })
    },
    async getAuthorization(id) {
      const [row] = await db
        .select()
        .from(mcpOauthAuthorizations)
        .where(eq(mcpOauthAuthorizations.id, id))
        .limit(1)
      return row ? toAuthorization(row) : null
    },
    async bindAuthorizationUser(id, userSub, csrfHash, now) {
      const rows = await db
        .update(mcpOauthAuthorizations)
        .set({ userSub, csrfHash })
        .where(
          and(
            eq(mcpOauthAuthorizations.id, id),
            isNull(mcpOauthAuthorizations.decidedAt),
            gt(mcpOauthAuthorizations.expiresAt, now),
            or(isNull(mcpOauthAuthorizations.userSub), eq(mcpOauthAuthorizations.userSub, userSub)),
          ),
        )
        .returning({ id: mcpOauthAuthorizations.id })
      return rows.length > 0
    },
    async decideAuthorization(id, userSub, decision, now) {
      const rows = await db
        .update(mcpOauthAuthorizations)
        .set({
          decidedAt: now,
          decision: decision.approved ? 'approved' : 'denied',
          ...(decision.approved
            ? { codeHash: decision.codeHash, codeExpiresAt: decision.codeExpiresAt }
            : {}),
        })
        .where(
          and(
            eq(mcpOauthAuthorizations.id, id),
            isNull(mcpOauthAuthorizations.decidedAt),
            gt(mcpOauthAuthorizations.expiresAt, now),
            eq(mcpOauthAuthorizations.userSub, userSub),
          ),
        )
        .returning({ id: mcpOauthAuthorizations.id })
      return rows.length > 0
    },
    async claimCode(codeHash, now) {
      const rows = await db
        .update(mcpOauthAuthorizations)
        .set({ exchangedAt: now })
        .where(
          and(
            eq(mcpOauthAuthorizations.codeHash, codeHash),
            isNull(mcpOauthAuthorizations.exchangedAt),
          ),
        )
        .returning()
      return rows[0] ? toAuthorization(rows[0]) : null
    },
    async findAuthorizationByCode(codeHash) {
      const [row] = await db
        .select()
        .from(mcpOauthAuthorizations)
        .where(eq(mcpOauthAuthorizations.codeHash, codeHash))
        .limit(1)
      return row ? toAuthorization(row) : null
    },
    async setAuthorizationGrant(id, grantId) {
      await db
        .update(mcpOauthAuthorizations)
        .set({ grantId })
        .where(eq(mcpOauthAuthorizations.id, id))
    },

    async insertGrant(g) {
      await db.insert(mcpOauthGrants).values({ ...g, ...clientColumns(g.clientId) })
    },
    async revokeGrant(id, now) {
      return db.transaction(async (tx) => {
        const rows = await tx
          .update(mcpOauthGrants)
          .set({ revokedAt: now })
          .where(and(eq(mcpOauthGrants.id, id), isNull(mcpOauthGrants.revokedAt)))
          .returning({ id: mcpOauthGrants.id })
        await tx
          .update(mcpOauthTokens)
          .set({ revokedAt: now })
          .where(and(eq(mcpOauthTokens.grantId, id), isNull(mcpOauthTokens.revokedAt)))
        return rows.length > 0
      })
    },
    async revokeUserGrant(userSub, id, now) {
      const [row] = await db
        .select({ id: mcpOauthGrants.id })
        .from(mcpOauthGrants)
        .where(and(eq(mcpOauthGrants.id, id), eq(mcpOauthGrants.userSub, userSub)))
        .limit(1)
      if (!row) return false
      return store.revokeGrant(id, now)
    },
    async listUserGrants(userSub) {
      const rows = await db
        .select({
          grant: mcpOauthGrants,
          clientName: mcpOauthClients.clientName,
          redirectUris: mcpOauthClients.redirectUris,
        })
        .from(mcpOauthGrants)
        .leftJoin(mcpOauthClients, eq(mcpOauthClients.id, mcpOauthGrants.clientId))
        .where(and(eq(mcpOauthGrants.userSub, userSub), isNull(mcpOauthGrants.revokedAt)))
        .orderBy(desc(mcpOauthGrants.createdAt))
      return rows.map((r) => connection(toGrant(r.grant), r.clientName, r.redirectUris))
    },
    async touchGrant(id, now, notBefore) {
      await db
        .update(mcpOauthGrants)
        .set({ lastUsedAt: now })
        .where(
          and(
            eq(mcpOauthGrants.id, id),
            or(isNull(mcpOauthGrants.lastUsedAt), lt(mcpOauthGrants.lastUsedAt, notBefore)),
          ),
        )
    },
    async flagGrant(id, reason, now) {
      await db
        .update(mcpOauthGrants)
        .set({ flaggedAt: sql`COALESCE(${mcpOauthGrants.flaggedAt}, ${now})`, flagReason: reason })
        .where(eq(mcpOauthGrants.id, id))
    },
    async getGrantOwner(id) {
      const [row] = await db
        .select({
          grant: mcpOauthGrants,
          userEmail: users.email,
          userEmailVerified: users.emailVerified,
        })
        .from(mcpOauthGrants)
        .leftJoin(users, eq(users.sub, mcpOauthGrants.userSub))
        .where(eq(mcpOauthGrants.id, id))
        .limit(1)
      if (!row) return null
      return {
        grant: toGrant(row.grant),
        userEmail: row.userEmail ?? null,
        userEmailVerified: row.userEmailVerified === true,
      }
    },
    async revokeAllForUser(userSub, now) {
      return revokeAllMcpGrantsForUser(db, userSub, now)
    },

    async insertToken(t) {
      await db.insert(mcpOauthTokens).values(t)
    },
    async findToken(tokenHash) {
      const [row] = await db
        .select({
          token: mcpOauthTokens,
          grant: mcpOauthGrants,
          clientName: mcpOauthClients.clientName,
          userEmail: users.email,
          userName: users.name,
          userEmailVerified: users.emailVerified,
        })
        .from(mcpOauthTokens)
        .innerJoin(mcpOauthGrants, eq(mcpOauthGrants.id, mcpOauthTokens.grantId))
        .leftJoin(mcpOauthClients, eq(mcpOauthClients.id, mcpOauthGrants.clientId))
        .leftJoin(users, eq(users.sub, mcpOauthGrants.userSub))
        .where(eq(mcpOauthTokens.tokenHash, tokenHash))
        .limit(1)
      if (!row) return null
      const grant = toGrant(row.grant)
      return {
        token: toToken(row.token),
        grant,
        client: {
          id: grant.clientId,
          clientName: grant.clientName ?? row.clientName ?? UNKNOWN_CLIENT_NAME,
        },
        userEmail: row.userEmail ?? null,
        userName: row.userName ?? null,
        userEmailVerified: row.userEmailVerified === true,
      }
    },
    async useRefreshToken(tokenHash, now, fingerprint) {
      const rows = await db
        .update(mcpOauthTokens)
        .set({ usedAt: now, usedByFingerprint: fingerprint })
        .where(
          and(
            eq(mcpOauthTokens.tokenHash, tokenHash),
            eq(mcpOauthTokens.kind, 'refresh'),
            isNull(mcpOauthTokens.usedAt),
            isNull(mcpOauthTokens.revokedAt),
          ),
        )
        .returning({ tokenHash: mcpOauthTokens.tokenHash })
      return rows.length > 0
    },
    async purgeExpired(before) {
      await db.delete(mcpOauthTokens).where(lt(mcpOauthTokens.expiresAt, before))
      await db.delete(mcpOauthAuthorizations).where(
        and(
          lt(mcpOauthAuthorizations.expiresAt, before),
          // Keep exchanged authorizations while their grant lives: a replayed
          // code must still be recognised (and revoke the grant).
          sql`(${mcpOauthAuthorizations.grantId} IS NULL OR ${mcpOauthAuthorizations.exchangedAt} IS NULL)`,
        ),
      )
    },
    async purgeRetained(before) {
      const authorizations = await db
        .delete(mcpOauthAuthorizations)
        .where(
          or(
            lt(mcpOauthAuthorizations.exchangedAt, before),
            lt(mcpOauthAuthorizations.decidedAt, before),
          ),
        )
        .returning({ id: mcpOauthAuthorizations.id })
      const grants = await db
        .delete(mcpOauthGrants)
        .where(lt(mcpOauthGrants.revokedAt, before))
        .returning({ id: mcpOauthGrants.id })
      return { authorizations: authorizations.length, grants: grants.length }
    },
    async deleteStaleRegisteredClients(inactiveBefore, now) {
      const rows = await db
        .delete(mcpOauthClients)
        .where(
          and(
            sql`COALESCE(${mcpOauthClients.lastUsedAt}, ${mcpOauthClients.createdAt}) < ${inactiveBefore}`,
            sql`NOT EXISTS (SELECT 1 FROM ${mcpOauthGrants} WHERE ${mcpOauthGrants.clientId} = ${mcpOauthClients.id} AND ${mcpOauthGrants.revokedAt} IS NULL)`,
            sql`NOT EXISTS (SELECT 1 FROM ${mcpOauthAuthorizations} WHERE ${mcpOauthAuthorizations.clientId} = ${mcpOauthClients.id} AND ${mcpOauthAuthorizations.expiresAt} > ${now})`,
          ),
        )
        .returning({ id: mcpOauthClients.id })
      return rows.length
    },
  }
  return store
}

/** A connection for display: snapshot first, then the registered client's row. */
function connection(
  grant: GrantRecord,
  registeredName: string | null,
  registeredRedirectUris: string[] | null,
): ConnectionRecord {
  return {
    grant,
    clientName: grant.clientName ?? registeredName ?? UNKNOWN_CLIENT_NAME,
    redirectUris:
      grant.redirectUri !== null ? [grant.redirectUri] : [...(registeredRedirectUris ?? [])],
    kind: isClientIdMetadataUrl(grant.clientId) ? 'metadata_document' : 'registered',
  }
}

/**
 * Revoke every live MCP OAuth grant (and so every token) of a user, and
 * expire every authorization of theirs not exchanged yet (undecided requests
 * and approved codes: `expires_at` and `code_expires_at` become now, which
 * the consent, decision and code exchange all check), in one transaction.
 * For the account kill switch (auth/agentCredentials.ts). Returns how many
 * grants.
 */
export async function revokeAllMcpGrantsForUser(
  db: Database,
  userSub: string,
  now: Date = new Date(),
): Promise<number> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(mcpOauthGrants)
      .set({ revokedAt: now })
      .where(and(eq(mcpOauthGrants.userSub, userSub), isNull(mcpOauthGrants.revokedAt)))
      .returning({ id: mcpOauthGrants.id })
    if (rows.length > 0) {
      await tx
        .update(mcpOauthTokens)
        .set({ revokedAt: now })
        .where(
          and(
            isNull(mcpOauthTokens.revokedAt),
            sql`${mcpOauthTokens.grantId} IN (SELECT ${mcpOauthGrants.id} FROM ${mcpOauthGrants} WHERE ${mcpOauthGrants.userSub} = ${userSub})`,
          ),
        )
    }
    // A code the user approved moments ago must not outlive the kill switch
    // (it would mint a fresh grant), and neither may a request still on its
    // consent page. Unbound requests belong to nobody yet; the revoked
    // sessions keep the user from binding them.
    await tx
      .update(mcpOauthAuthorizations)
      .set({ expiresAt: now, codeExpiresAt: now })
      .where(
        and(
          eq(mcpOauthAuthorizations.userSub, userSub),
          isNull(mcpOauthAuthorizations.exchangedAt),
        ),
      )
    return rows.length
  })
}

// ---------------------------------------------------------------------------
// In memory (tests)
// ---------------------------------------------------------------------------

export interface MemoryOAuthStore extends McpOAuthStore {
  readonly clients: Map<string, ClientRecord>
  readonly authorizations: Map<string, AuthorizationRecord>
  readonly grants: Map<string, GrantRecord>
  readonly tokens: Map<string, TokenRecord>
  readonly users: Map<
    string,
    { email: string | null; name: string | null; emailVerified?: boolean }
  >
}

export function createMemoryOAuthStore(): MemoryOAuthStore {
  const clients = new Map<string, ClientRecord>()
  const authorizations = new Map<string, AuthorizationRecord>()
  const grants = new Map<string, GrantRecord>()
  const tokens = new Map<string, TokenRecord>()
  const userDirectory = new Map<
    string,
    { email: string | null; name: string | null; emailVerified?: boolean }
  >()
  const copy = <T>(v: T): T => structuredClone(v)

  const expireUnexchanged = (userSub: string, now: Date): void => {
    for (const a of authorizations.values()) {
      if (a.userSub !== userSub || a.exchangedAt !== null) continue
      a.expiresAt = now
      a.codeExpiresAt = now
    }
  }

  const revoke = (id: string, now: Date): boolean => {
    const g = grants.get(id)
    if (g === undefined || g.revokedAt !== null) return false
    g.revokedAt = now
    for (const t of tokens.values()) if (t.grantId === id && t.revokedAt === null) t.revokedAt = now
    return true
  }

  return {
    clients,
    authorizations,
    grants,
    tokens,
    users: userDirectory,
    async insertClient(c) {
      clients.set(c.id, copy(c))
    },
    async getClient(id) {
      const c = clients.get(id)
      return c ? copy(c) : null
    },
    async touchClient(id, at) {
      const c = clients.get(id)
      if (c) c.lastUsedAt = at
    },
    async insertAuthorization(a) {
      authorizations.set(a.id, copy(a))
    },
    async getAuthorization(id) {
      const a = authorizations.get(id)
      return a ? copy(a) : null
    },
    async bindAuthorizationUser(id, userSub, csrfHash, now) {
      const a = authorizations.get(id)
      if (!a || a.decidedAt !== null || a.expiresAt <= now) return false
      if (a.userSub !== null && a.userSub !== userSub) return false
      a.userSub = userSub
      a.csrfHash = csrfHash
      return true
    },
    async decideAuthorization(id, userSub, decision, now) {
      const a = authorizations.get(id)
      if (!a || a.decidedAt !== null || a.expiresAt <= now || a.userSub !== userSub) return false
      a.decidedAt = now
      a.decision = decision.approved ? 'approved' : 'denied'
      if (decision.approved) {
        a.codeHash = decision.codeHash
        a.codeExpiresAt = decision.codeExpiresAt
      }
      return true
    },
    async claimCode(codeHash, now) {
      const a = [...authorizations.values()].find((x) => x.codeHash === codeHash)
      if (!a || a.exchangedAt !== null) return null
      a.exchangedAt = now
      return copy(a)
    },
    async findAuthorizationByCode(codeHash) {
      const a = [...authorizations.values()].find((x) => x.codeHash === codeHash)
      return a ? copy(a) : null
    },
    async setAuthorizationGrant(id, grantId) {
      const a = authorizations.get(id)
      if (a) a.grantId = grantId
    },
    async insertGrant(g) {
      grants.set(g.id, copy(g))
    },
    async revokeGrant(id, now) {
      return revoke(id, now)
    },
    async revokeUserGrant(userSub, id, now) {
      const g = grants.get(id)
      if (!g || g.userSub !== userSub) return false
      return revoke(id, now)
    },
    async listUserGrants(userSub) {
      return [...grants.values()]
        .filter((g) => g.userSub === userSub && g.revokedAt === null)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map((g) => {
          const c = clients.get(g.clientId)
          return connection(copy(g), c?.clientName ?? null, c ? [...c.redirectUris] : null)
        })
    },
    async touchGrant(id, now, notBefore) {
      const g = grants.get(id)
      if (g && (g.lastUsedAt === null || g.lastUsedAt < notBefore)) g.lastUsedAt = now
    },
    async flagGrant(id, reason, now) {
      const g = grants.get(id)
      if (!g) return
      g.flaggedAt ??= now
      g.flagReason = reason
    },
    async getGrantOwner(id) {
      const g = grants.get(id)
      if (!g) return null
      const u = userDirectory.get(g.userSub)
      return {
        grant: copy(g),
        userEmail: u?.email ?? null,
        userEmailVerified: u?.emailVerified === true,
      }
    },
    async revokeAllForUser(userSub, now) {
      let revoked = 0
      for (const g of grants.values()) if (g.userSub === userSub && revoke(g.id, now)) revoked++
      expireUnexchanged(userSub, now)
      return revoked
    },
    async insertToken(t) {
      tokens.set(t.tokenHash, copy(t))
    },
    async findToken(tokenHash) {
      const t = tokens.get(tokenHash)
      if (!t) return null
      const g = grants.get(t.grantId)!
      const c = clients.get(g.clientId)
      const u = userDirectory.get(g.userSub)
      return {
        token: copy(t),
        grant: copy(g),
        client: {
          id: g.clientId,
          clientName: g.clientName ?? c?.clientName ?? UNKNOWN_CLIENT_NAME,
        },
        userEmail: u?.email ?? null,
        userName: u?.name ?? null,
        userEmailVerified: u?.emailVerified === true,
      }
    },
    async useRefreshToken(tokenHash, now, fingerprint) {
      const t = tokens.get(tokenHash)
      if (!t || t.kind !== 'refresh' || t.usedAt !== null || t.revokedAt !== null) return false
      t.usedAt = now
      t.usedByFingerprint = fingerprint
      return true
    },
    async purgeExpired(before) {
      for (const [k, t] of tokens) if (t.expiresAt < before) tokens.delete(k)
      for (const [k, a] of authorizations)
        if (a.expiresAt < before && (a.grantId === null || a.exchangedAt === null))
          authorizations.delete(k)
    },
    async purgeRetained(before) {
      let purgedAuthorizations = 0
      for (const [k, a] of authorizations) {
        if (
          (a.exchangedAt !== null && a.exchangedAt < before) ||
          (a.decidedAt !== null && a.decidedAt < before)
        ) {
          authorizations.delete(k)
          purgedAuthorizations++
        }
      }
      let purgedGrants = 0
      for (const [gid, g] of grants) {
        if (g.revokedAt === null || g.revokedAt >= before) continue
        // The foreign keys: tokens cascade, authorizations' grant_id is set null.
        for (const [th, t] of tokens) if (t.grantId === gid) tokens.delete(th)
        for (const a of authorizations.values()) if (a.grantId === gid) a.grantId = null
        grants.delete(gid)
        purgedGrants++
      }
      return { authorizations: purgedAuthorizations, grants: purgedGrants }
    },
    async deleteStaleRegisteredClients(inactiveBefore, now) {
      let deleted = 0
      for (const [id, c] of clients) {
        if ((c.lastUsedAt ?? c.createdAt) >= inactiveBefore) continue
        const live = [...grants.values()].some((g) => g.clientId === id && g.revokedAt === null)
        const pending = [...authorizations.values()].some(
          (a) => a.clientId === id && a.expiresAt > now,
        )
        if (live || pending) continue
        // The cascade of the foreign keys: grants, their tokens, authorizations.
        for (const [gid, g] of grants) {
          if (g.clientId !== id) continue
          for (const [th, t] of tokens) if (t.grantId === gid) tokens.delete(th)
          grants.delete(gid)
        }
        for (const [aid, a] of authorizations) if (a.clientId === id) authorizations.delete(aid)
        clients.delete(id)
        deleted++
      }
      return deleted
    },
  }
}
