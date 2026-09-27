/**
 * http/bearerCache.ts
 *
 * In-memory knowledge about the bearer tokens the API has recently seen —
 * no database, no secret material (only SHA-256 hashes of the raw values).
 * It lets the per-client pre-limit (http/rateLimit.ts) key a request on the
 * TOKEN it carries instead of its IP address, which matters because some
 * clients share their egress: every claude.ai user calls /api/mcp from
 * Anthropic's address range (160.79.104.0/21), so a per-IP budget would be
 * one budget for all of them, and junk traffic from that range would
 * exhaust it for everyone.
 *
 * Only syntactically valid agent credentials count as bearers here:
 *   - `nmo_` + 43 base64url characters — an MCP OAuth access token
 *     (mcp/oauth/service.ts, ACCESS_TOKEN_PREFIX; 256 random bits);
 *   - `nrt_` + 43 base64url characters — a personal access token
 *     (auth/personalAccessTokens.ts, `isWellFormedPersonalAccessToken`).
 * Anything else (the /metrics token, malformed values) is not a bearer for
 * this purpose and the request stays keyed on its IP.
 *
 * Three sets, each bounded (least recently used entries go first) and
 * expiring by an injectable clock:
 *
 *   invalid  hashes whose verification FAILED recently (NEGATIVE_TTL_MS,
 *            60 s). Such a bearer is treated as no credential at all: the
 *            pre-limit keys it on the IP again (repeating a junk token earns
 *            no private budget), and the credential resolvers answer
 *            "invalid" without a database lookup (auth/identity.ts,
 *            mcp/auth.ts). Only a verification that returned "no" records
 *            a failure — never a thrown error (a database outage must not
 *            lock valid tokens out). The TTL is short so a token refused for
 *            a transient reason (the owner re-added to the allowlist) works
 *            again within a minute.
 *   seen     hashes the pre-limit has already admitted recently (SEEN_TTL_MS,
 *            10 min, sliding: every successful verification refreshes it). A
 *            bearer NOT in this set is a "new bearer": it costs a database
 *            lookup the attacker can multiply at will by minting random
 *            values, so new bearers are counted per client IP against their
 *            own limit (NEW_BEARER_PRE_LIMIT) before they get a token bucket.
 *            A failed verification removes the hash from `seen`, so a junk
 *            value is "new" again once its negative entry expires.
 *
 * Single process, like every other limiter here (the API runs as one
 * instance).
 */

import { createHash } from 'node:crypto'
import { isWellFormedPersonalAccessToken } from '../auth/personalAccessTokens.js'

/** How long a failed verification is remembered. */
export const NEGATIVE_TTL_MS = 60_000
/** Most failed-verification hashes kept (least recently used evicted). */
export const NEGATIVE_MAX_ENTRIES = 10_000
/** How long an admitted bearer counts as already seen (sliding). */
export const SEEN_TTL_MS = 10 * 60_000
/** Most seen hashes kept (least recently used evicted). */
export const SEEN_MAX_ENTRIES = 50_000

/** The shape of an MCP OAuth access token (mcp/oauth/service.ts: `nmo_` + 32 random bytes, base64url). */
const MCP_ACCESS_TOKEN_RE = /^nmo_[A-Za-z0-9_-]{43}$/

/** A syntactically valid agent bearer from an `Authorization` header. */
export interface AgentBearer {
  kind: 'mcp-oauth' | 'personal-access-token'
  raw: string
  /** SHA-256 hex of `raw`. */
  hash: string
}

export function hashBearer(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}

/** The raw value of `Authorization: Bearer <value>`, or null. */
export function bearerFromHeader(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header
  if (!value) return null
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(value)
  return match?.[1] ?? null
}

/** Classify a raw bearer value; null when it is not a well-formed agent credential. */
export function agentBearer(raw: string | null | undefined): AgentBearer | null {
  if (typeof raw !== 'string') return null
  const kind = MCP_ACCESS_TOKEN_RE.test(raw)
    ? 'mcp-oauth'
    : isWellFormedPersonalAccessToken(raw)
      ? 'personal-access-token'
      : null
  return kind === null ? null : { kind, raw, hash: hashBearer(raw) }
}

/** A bounded, expiring set of strings; re-inserting moves an entry to the young end. */
class ExpiringLruSet {
  // A Map iterates in insertion order: the first key is the least recently used.
  private readonly entries = new Map<string, number>()

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number,
  ) {}

  add(key: string): void {
    this.entries.delete(key)
    this.entries.set(key, this.now() + this.ttlMs)
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  has(key: string): boolean {
    const expiresAt = this.entries.get(key)
    if (expiresAt === undefined) return false
    if (expiresAt <= this.now()) {
      this.entries.delete(key)
      return false
    }
    return true
  }

  delete(key: string): void {
    this.entries.delete(key)
  }

  get size(): number {
    return this.entries.size
  }
}

export interface BearerCacheOptions {
  /** Injectable clock (tests). */
  now?: () => number
  negativeTtlMs?: number
  negativeMaxEntries?: number
  seenTtlMs?: number
  seenMaxEntries?: number
}

export class BearerCache {
  private readonly invalid: ExpiringLruSet
  private readonly seen: ExpiringLruSet

  constructor(opts: BearerCacheOptions = {}) {
    const now = opts.now ?? Date.now
    this.invalid = new ExpiringLruSet(
      opts.negativeTtlMs ?? NEGATIVE_TTL_MS,
      opts.negativeMaxEntries ?? NEGATIVE_MAX_ENTRIES,
      now,
    )
    this.seen = new ExpiringLruSet(
      opts.seenTtlMs ?? SEEN_TTL_MS,
      opts.seenMaxEntries ?? SEEN_MAX_ENTRIES,
      now,
    )
  }

  /** Did this bearer fail verification within the negative TTL? */
  isKnownInvalid(raw: string): boolean {
    return this.invalid.has(hashBearer(raw))
  }

  isKnownInvalidHash(hash: string): boolean {
    return this.invalid.has(hash)
  }

  /** Verification said no (never call this for a thrown error). */
  recordInvalid(raw: string): void {
    const hash = hashBearer(raw)
    this.invalid.add(hash)
    this.seen.delete(hash)
  }

  /** Verification succeeded: keep the bearer out of the new-bearer limit. */
  recordValid(raw: string): void {
    const hash = hashBearer(raw)
    this.invalid.delete(hash)
    this.seen.add(hash)
  }

  hasSeenHash(hash: string): boolean {
    return this.seen.has(hash)
  }

  markSeenHash(hash: string): void {
    this.seen.add(hash)
  }

  /** Entry counts (tests, diagnostics). */
  sizes(): { invalid: number; seen: number } {
    return { invalid: this.invalid.size, seen: this.seen.size }
  }
}
