/**
 * auth/personalAccessTokens.ts
 *
 * Personal access tokens (PATs): the second identity next to the session
 * cookie, for agents (Claude Code over MCP) and scripts (the batch HTTP API).
 * docs/plans/agentic-layer.md §4.5, §10 A1; ADR 0011.
 *
 * Token format
 * ------------
 *   nrt_<43 chars base64url>        e.g. nrt_Qm9vc3Rpbmcgc2VjcmV0cyBpcyBoYXJk...
 *
 *   - `nrt_` ("Narrative token") makes a leaked token recognisable to secret
 *     scanners and to people, and lets every auth path tell a PAT apart from
 *     other bearer values (the /metrics token) without touching the database.
 *   - The secret is 32 bytes of `crypto.randomBytes` (256 bits), so guessing
 *     or brute-forcing it is infeasible and no per-token salt is needed:
 *     SHA-256 of a uniformly random 256-bit value is a safe verifier.
 *
 * Storage
 * -------
 *   - Only SHA-256(raw) (`token_hash`, hex) and a short display `prefix`
 *     (`nrt_` + the first 6 secret characters) are stored. A read-only DB
 *     compromise yields no usable token.
 *   - The raw token is returned exactly once, by `create()`. It is never
 *     logged, never stored, never retrievable again.
 *
 * Lifecycle
 * ---------
 *   - Scopes: a non-empty subset of `PAT_SCOPES`. `mcp` = the MCP server at
 *     /api/mcp (Claude Code, claude.ai), `api` = the batch HTTP API at
 *     /api/commands. Tus uploads accept either (agents upload media there).
 *   - Expiry: 30, 90 or 365 days — every token expires (migration 0020 gave
 *     the tokens minted before this rule created_at + 365 days). Revocation
 *     sets `revoked_at`; a revoked or expired token is rejected on the next
 *     request.
 *   - Account kill switches reach tokens: `revokeAllSessionsForUser`
 *     (auth/session.ts) revokes every agent credential of the user through
 *     `revokeAllAgentCredentialsForUser` (auth/agentCredentials.ts), and
 *     `verify()` re-applies the sign-in allowlist (auth/signInPolicy.ts) to
 *     the token's owner on every use, so removing someone from
 *     OIDC_ALLOWED_EMAILS / their last deck permission stops their tokens at
 *     once, without anyone having to find and revoke them.
 *   - Cap: a user holds at most `MAX_ACTIVE_PATS_PER_USER` (20) active tokens
 *     (not revoked, not expired). One per machine/client is the expected use,
 *     and 20 is far above that while still bounding what a compromised session
 *     could mint. The cap is enforced atomically per user (advisory lock), so
 *     concurrent creations cannot overshoot it.
 *   - `last_used_at` is written at most once a minute per token
 *     (`PAT_LAST_USED_WRITE_INTERVAL_MS`), off the request's critical path.
 *
 * Who may manage tokens
 * ---------------------
 * Only a browser session. The token routes (routes/accessTokens.ts) use the
 * session-only `authPreHandler`, so a PAT can never mint, list or revoke
 * PATs — a leaked agent token cannot persist itself past its own revocation.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, desc, eq, gt, isNull, lte, or, sql, type SQL } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { Database } from '../db/client.js'
import { personalAccessTokens, users } from '../db/schema.js'
import { subsystemLogger } from '../observability/logger.js'
import type { AllowlistConfig } from './jwt.js'
import { isAllowedToSignIn } from './signInPolicy.js'

const log = subsystemLogger('auth')

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PAT_PREFIX = 'nrt_'

/** Every scope a token can carry. */
export const PAT_SCOPES = ['mcp', 'api'] as const
export type PatScope = (typeof PAT_SCOPES)[number]

/** Expiry choices offered at creation. There is no "never". */
export const PAT_EXPIRY_DAY_CHOICES = [30, 90, 365] as const
export type PatExpiryDays = (typeof PAT_EXPIRY_DAY_CHOICES)[number]

/** Active (not revoked, not expired) tokens a single user may hold. */
export const MAX_ACTIVE_PATS_PER_USER = 20

export const PAT_NAME_MAX_LENGTH = 80

/** `last_used_at` is written at most this often per token. */
export const PAT_LAST_USED_WRITE_INTERVAL_MS = 60_000

const SECRET_BYTES = 32
/** base64url of 32 bytes is 43 characters (no padding). */
const RAW_TOKEN_RE = /^nrt_[A-Za-z0-9_-]{43}$/
const DISPLAY_SECRET_CHARS = 6
const DAY_MS = 24 * 60 * 60 * 1000
const SHA256_HEX_RE = /^[0-9a-f]{64}$/

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function isPatScope(value: unknown): value is PatScope {
  return typeof value === 'string' && (PAT_SCOPES as readonly string[]).includes(value)
}

export function isPatExpiryDays(value: unknown): value is PatExpiryDays {
  return typeof value === 'number' && (PAT_EXPIRY_DAY_CHOICES as readonly number[]).includes(value)
}

/**
 * Cheap syntactic check: does this bearer value claim to be a PAT? Anything
 * with the `nrt_` prefix is treated as a PAT claim (and then must verify);
 * everything else is some other credential and is left alone.
 */
export function looksLikePersonalAccessToken(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.startsWith(PAT_PREFIX)
}

/**
 * Strict syntactic check: exactly the shape `mintRawToken` produces
 * (`nrt_` + 43 base64url characters). Values that fail it never reach the
 * database; the rate limiter only gives well-formed tokens a bucket of their
 * own (http/bearerCache.ts).
 */
export function isWellFormedPersonalAccessToken(value: string | null | undefined): value is string {
  return typeof value === 'string' && RAW_TOKEN_RE.test(value)
}

/** SHA-256 hex of the raw token — what `token_hash` stores. */
export function hashPersonalAccessToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}

function mintRawToken(): string {
  return PAT_PREFIX + randomBytes(SECRET_BYTES).toString('base64url')
}

function displayPrefix(raw: string): string {
  return raw.slice(0, PAT_PREFIX.length + DISPLAY_SECRET_CHARS)
}

/** Constant-time comparison of two SHA-256 hex digests. */
function hashesEqual(a: string, b: string): boolean {
  if (!SHA256_HEX_RE.test(a) || !SHA256_HEX_RE.test(b)) return false
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
}

function isActive(row: Pick<PatRecord, 'revokedAt' | 'expiresAt'>, now: Date): boolean {
  return row.revokedAt === null && row.expiresAt.getTime() > now.getTime()
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A stored token row (the columns this module reads and writes). */
export interface PatRecord {
  id: string
  userSub: string
  name: string
  tokenHash: string
  prefix: string
  scopes: string[]
  createdAt: Date
  lastUsedAt: Date | null
  expiresAt: Date
  revokedAt: Date | null
}

/** A token row plus the owner's directory entry, as `findByHash` returns it. */
export interface PatRecordWithOwner extends PatRecord {
  /** Null when the owner has no `users` row (never signed in). */
  ownerEmail: string | null
  ownerEmailVerified: boolean | null
  ownerName: string | null
}

/** What the token list (and the creation response) shows. Never the hash. */
export interface PatSummary {
  id: string
  name: string
  prefix: string
  scopes: PatScope[]
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string
  expired: boolean
}

/** A verified token: who it acts for and what it may do. */
export interface VerifiedPat {
  tokenId: string
  userSub: string
  email: string | null
  name: string | null
  scopes: PatScope[]
}

export interface CreatePatInput {
  name: string
  scopes: PatScope[]
  /** 30, 90 or 365. */
  expiresInDays: PatExpiryDays
}

export type PatErrorCode =
  | 'invalid_name'
  | 'invalid_scopes'
  | 'invalid_expiry'
  | 'invalid_body'
  | 'token_limit_reached'

export class PatError extends Error {
  constructor(
    readonly code: PatErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'PatError'
  }
}

// ---------------------------------------------------------------------------
// Input validation (the route body)
// ---------------------------------------------------------------------------

/**
 * Validate a creation request body: `{ name, scopes, expiresInDays }`.
 * `expiresInDays` is required and one of PAT_EXPIRY_DAY_CHOICES.
 * Throws `PatError` with a user-presentable message.
 */
export function parseCreatePatInput(body: unknown): CreatePatInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new PatError('invalid_body', 'Expected a JSON object.')
  }
  const b = body as Record<string, unknown>

  const name = typeof b['name'] === 'string' ? b['name'].trim() : ''
  if (name.length === 0 || name.length > PAT_NAME_MAX_LENGTH) {
    throw new PatError(
      'invalid_name',
      `Give the token a name of 1 to ${PAT_NAME_MAX_LENGTH} characters.`,
    )
  }

  const rawScopes = b['scopes']
  if (
    !Array.isArray(rawScopes) ||
    rawScopes.length === 0 ||
    !rawScopes.every(isPatScope) ||
    new Set(rawScopes).size !== rawScopes.length
  ) {
    throw new PatError(
      'invalid_scopes',
      `Pick at least one scope, each once, from: ${PAT_SCOPES.join(', ')}.`,
    )
  }
  // Canonical order, so the stored array does not depend on the client.
  const scopes = PAT_SCOPES.filter((s) => rawScopes.includes(s))

  const rawExpiry = b['expiresInDays']
  if (!isPatExpiryDays(rawExpiry)) {
    throw new PatError(
      'invalid_expiry',
      `Expiry must be one of ${PAT_EXPIRY_DAY_CHOICES.join(', ')} days.`,
    )
  }

  return { name, scopes, expiresInDays: rawExpiry }
}

// ---------------------------------------------------------------------------
// Store — the only part that talks to the database
// ---------------------------------------------------------------------------

export interface PatStore {
  /**
   * Insert `row` unless `row.userSub` already holds `cap` active tokens.
   * Must be atomic per user: two concurrent calls cannot both pass the check
   * when only one slot is left. Returns whether the row was inserted.
   */
  insertIfUnderCap(row: PatRecord, cap: number, now: Date): Promise<boolean>
  findByHash(tokenHash: string): Promise<PatRecordWithOwner | null>
  /** A token by its public id, with its owner (the MCP session sweep re-checks live sessions). */
  findById(id: string): Promise<PatRecordWithOwner | null>
  /** The user's tokens that are not revoked (expired ones included), newest first. */
  listForUser(userSub: string): Promise<PatRecord[]>
  /** Revoke one of the user's own tokens. False when there is no such live token. */
  revoke(userSub: string, id: string, now: Date): Promise<boolean>
  /** Set `last_used_at = now` unless it is already later than `notBefore`. */
  touchLastUsed(id: string, now: Date, notBefore: Date): Promise<void>
}

export function createDrizzlePatStore(db: Database): PatStore {
  /** One token row with its owner's directory entry, by any unique column. */
  const findOne = async (where: SQL): Promise<PatRecordWithOwner | null> => {
    const [row] = await db
      .select({
        id: personalAccessTokens.id,
        userSub: personalAccessTokens.userSub,
        name: personalAccessTokens.name,
        tokenHash: personalAccessTokens.tokenHash,
        prefix: personalAccessTokens.prefix,
        scopes: personalAccessTokens.scopes,
        createdAt: personalAccessTokens.createdAt,
        lastUsedAt: personalAccessTokens.lastUsedAt,
        expiresAt: personalAccessTokens.expiresAt,
        revokedAt: personalAccessTokens.revokedAt,
        ownerEmail: users.email,
        ownerEmailVerified: users.emailVerified,
        ownerName: users.name,
      })
      .from(personalAccessTokens)
      .leftJoin(users, eq(users.sub, personalAccessTokens.userSub))
      .where(where)
      .limit(1)
    return row ?? null
  }

  return {
    async insertIfUnderCap(row, cap, now) {
      return db.transaction(async (tx) => {
        // Serialise creations per user for the duration of this transaction:
        // row locks cannot guard rows that do not exist yet, an advisory
        // lock keyed by the user can.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`pat:${row.userSub}`}, 0))`,
        )
        const [counted] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(personalAccessTokens)
          .where(
            and(
              eq(personalAccessTokens.userSub, row.userSub),
              isNull(personalAccessTokens.revokedAt),
              gt(personalAccessTokens.expiresAt, now),
            ),
          )
        if ((counted?.n ?? 0) >= cap) return false
        await tx.insert(personalAccessTokens).values(row)
        return true
      })
    },

    async findByHash(tokenHash) {
      return findOne(eq(personalAccessTokens.tokenHash, tokenHash))
    },

    async findById(id) {
      return findOne(eq(personalAccessTokens.id, id))
    },

    async listForUser(userSub) {
      return db
        .select()
        .from(personalAccessTokens)
        .where(
          and(eq(personalAccessTokens.userSub, userSub), isNull(personalAccessTokens.revokedAt)),
        )
        .orderBy(desc(personalAccessTokens.createdAt))
    },

    async revoke(userSub, id, now) {
      const rows = await db
        .update(personalAccessTokens)
        .set({ revokedAt: now })
        .where(
          and(
            eq(personalAccessTokens.id, id),
            eq(personalAccessTokens.userSub, userSub),
            isNull(personalAccessTokens.revokedAt),
          ),
        )
        .returning({ id: personalAccessTokens.id })
      return rows.length > 0
    },

    async touchLastUsed(id, now, notBefore) {
      await db
        .update(personalAccessTokens)
        .set({ lastUsedAt: now })
        .where(
          and(
            eq(personalAccessTokens.id, id),
            or(
              isNull(personalAccessTokens.lastUsedAt),
              lte(personalAccessTokens.lastUsedAt, notBefore),
            ),
          ),
        )
    },
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** What `verify()` knows about a token's owner when it asks the policy. */
export interface PatOwner {
  userSub: string
  /** Null when the owner has no `users` row. */
  email: string | null
  emailVerified: boolean
}

export interface PatServiceOptions {
  /**
   * Is the token's owner still allowed to use Narrative? Asked on every
   * verification, after the token itself checks out; `false` rejects the
   * token. Production passes `createPatOwnerPolicy` (the sign-in allowlist,
   * auth/signInPolicy.ts). Required, so no wiring can forget it.
   */
  isOwnerAllowed: (owner: PatOwner) => Promise<boolean>
  /** Injectable clock (tests). */
  now?: () => Date
  /** Where a failed background `last_used_at` write is reported. */
  onBackgroundError?: (err: unknown) => void
}

export interface PatService {
  /** Mint a token. The raw `token` exists only in this return value. */
  create(userSub: string, input: CreatePatInput): Promise<{ token: string; summary: PatSummary }>
  list(userSub: string): Promise<PatSummary[]>
  /** Revoke one of the user's own tokens. False when it does not exist (or is not theirs). */
  revoke(userSub: string, id: string): Promise<boolean>
  /**
   * Resolve a raw bearer value to its token, or null if unknown, malformed,
   * revoked, expired, or its owner is no longer allowed to sign in.
   */
  verify(raw: string): Promise<VerifiedPat | null>
  /**
   * Is the token `tokenId` still usable by `userSub` — theirs, not revoked,
   * not expired, and its owner still allowed to sign in? The same rules as
   * `verify`, by id, for re-checking a live MCP session (mcp/sessions.ts).
   */
  isLive(tokenId: string, userSub: string): Promise<boolean>
}

function toSummary(row: PatRecord, now: Date): PatSummary {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes.filter(isPatScope),
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString(),
    expired: row.expiresAt.getTime() <= now.getTime(),
  }
}

export function createPatService(store: PatStore, opts: PatServiceOptions): PatService {
  const now = opts.now ?? (() => new Date())
  const onBackgroundError =
    opts.onBackgroundError ??
    ((err: unknown) => {
      log.error({ err }, 'failed to record personal access token use')
    })

  // In-process throttle on top of the conditional UPDATE: a burst of
  // concurrent requests on one token all read the same stale `last_used_at`
  // before the first write lands, and would each issue an UPDATE. This map
  // lets exactly one of them write per interval. Bounded by the number of
  // tokens used since boot (≤ MAX_ACTIVE_PATS_PER_USER per user).
  const lastTouchMs = new Map<string, number>()

  function recordUse(row: PatRecord, at: Date): void {
    const nowMs = at.getTime()
    const lastKnown = Math.max(row.lastUsedAt?.getTime() ?? 0, lastTouchMs.get(row.id) ?? 0)
    if (nowMs - lastKnown < PAT_LAST_USED_WRITE_INTERVAL_MS) return
    lastTouchMs.set(row.id, nowMs)
    const notBefore = new Date(nowMs - PAT_LAST_USED_WRITE_INTERVAL_MS)
    // Off the critical path: authentication never waits on this write.
    store.touchLastUsed(row.id, at, notBefore).catch(onBackgroundError)
  }

  return {
    async create(userSub, input) {
      const at = now()
      const token = mintRawToken()
      const row: PatRecord = {
        id: nanoid(),
        userSub,
        name: input.name,
        tokenHash: hashPersonalAccessToken(token),
        prefix: displayPrefix(token),
        scopes: [...input.scopes],
        createdAt: at,
        lastUsedAt: null,
        expiresAt: new Date(at.getTime() + input.expiresInDays * DAY_MS),
        revokedAt: null,
      }
      const inserted = await store.insertIfUnderCap(row, MAX_ACTIVE_PATS_PER_USER, at)
      if (!inserted) {
        throw new PatError(
          'token_limit_reached',
          `You already have ${MAX_ACTIVE_PATS_PER_USER} active tokens. Revoke one you no longer use first.`,
        )
      }
      return { token, summary: toSummary(row, at) }
    },

    async list(userSub) {
      const at = now()
      const rows = await store.listForUser(userSub)
      return rows.map((r) => toSummary(r, at))
    },

    async revoke(userSub, id) {
      return store.revoke(userSub, id, now())
    },

    async verify(raw) {
      // Malformed values never reach the database.
      if (!isWellFormedPersonalAccessToken(raw)) return null
      const hash = hashPersonalAccessToken(raw)
      const row = await store.findByHash(hash)
      if (!row) return null
      // The indexed lookup already matched on equality; comparing again in
      // constant time keeps the decision itself free of a timing signal.
      if (!hashesEqual(row.tokenHash, hash)) return null
      const at = now()
      if (!isActive(row, at)) return null
      const scopes = row.scopes.filter(isPatScope)
      if (scopes.length === 0) return null
      const ownerAllowed = await opts.isOwnerAllowed({
        userSub: row.userSub,
        email: row.ownerEmail,
        emailVerified: row.ownerEmailVerified === true,
      })
      if (!ownerAllowed) {
        log.info(
          { tokenId: row.id, userSub: row.userSub },
          'personal access token refused: its owner is no longer allowed to sign in',
        )
        return null
      }
      recordUse(row, at)
      return {
        tokenId: row.id,
        userSub: row.userSub,
        email: row.ownerEmail,
        name: row.ownerName,
        scopes,
      }
    },

    async isLive(tokenId, userSub) {
      const row = await store.findById(tokenId)
      if (!row || row.userSub !== userSub || !isActive(row, now())) return false
      if (row.scopes.filter(isPatScope).length === 0) return false
      return opts.isOwnerAllowed({
        userSub: row.userSub,
        email: row.ownerEmail,
        emailVerified: row.ownerEmailVerified === true,
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Account-level operations
// ---------------------------------------------------------------------------

/**
 * `isOwnerAllowed` for a PAT service built without a sign-in policy (the
 * defaults in auth/fastifyAuth.ts and media/tus.ts): no token verifies. Fail
 * closed, so a wiring that forgets the policy disables tokens instead of
 * letting them outlive their owner's access.
 */
export const refuseAllPatOwners: PatServiceOptions['isOwnerAllowed'] = async () => false

/**
 * The production `isOwnerAllowed`: the sign-in allowlist (env allowlist, then
 * pending invite or deck permission). An owner without a `users` row has no
 * email to check and is refused. The owner's email and `email_verified` come
 * from the `users` row `findByHash` already joined, so an env-allowlisted
 * owner costs no extra query.
 */
export function createPatOwnerPolicy(
  db: Database,
  allowlist: AllowlistConfig,
): PatServiceOptions['isOwnerAllowed'] {
  return async (owner) => {
    if (owner.email === null) return false
    return isAllowedToSignIn(db, allowlist, {
      email: owner.email,
      emailVerified: owner.emailVerified,
    })
  }
}

/**
 * Revoke every live token of a user. Returns how many were revoked. Called by
 * `revokeAllAgentCredentialsForUser` (auth/agentCredentials.ts), never
 * directly by a route.
 */
export async function revokeAllPersonalAccessTokensForUser(
  db: Database,
  userSub: string,
  now: Date = new Date(),
): Promise<number> {
  const rows = await db
    .update(personalAccessTokens)
    .set({ revokedAt: now })
    .where(and(eq(personalAccessTokens.userSub, userSub), isNull(personalAccessTokens.revokedAt)))
    .returning({ id: personalAccessTokens.id })
  return rows.length
}
