/**
 * test-support/memoryPatStore.ts — an in-memory `PatStore` for unit tests.
 *
 * Mirrors the semantics of `createDrizzlePatStore` (auth/personalAccessTokens.ts)
 * closely enough that the service's behaviour — cap, revocation, expiry,
 * `last_used_at` throttling — is tested against real state rather than
 * against mocked query chains. Excluded from the production build.
 */

import type {
  PatRecord,
  PatRecordWithOwner,
  PatServiceOptions,
  PatStore,
} from '../auth/personalAccessTokens.js'

/** `isOwnerAllowed` for tests that are not about the sign-in policy. */
export const allowAllPatOwners: PatServiceOptions['isOwnerAllowed'] = async () => true

interface MemoryOwner {
  email: string | null
  name: string | null
  emailVerified?: boolean | null
}

export interface MemoryPatStore extends PatStore {
  /** Every stored row, as the database would hold it. */
  readonly rows: PatRecord[]
  /** Directory entries joined by `findByHash` (users.sub → email/name). */
  readonly owners: Map<string, MemoryOwner>
  /** Calls per method, for assertions like "malformed tokens never hit the store". */
  readonly calls: Record<keyof PatStore, number>
}

export function createMemoryPatStore(): MemoryPatStore {
  const rows: PatRecord[] = []
  const owners = new Map<string, MemoryOwner>()
  const calls: Record<keyof PatStore, number> = {
    insertIfUnderCap: 0,
    findByHash: 0,
    findById: 0,
    listForUser: 0,
    revoke: 0,
    touchLastUsed: 0,
  }

  const withOwner = (row: PatRecord | undefined): PatRecordWithOwner | null => {
    if (!row) return null
    const owner = owners.get(row.userSub)
    return {
      ...row,
      scopes: [...row.scopes],
      ownerEmail: owner?.email ?? null,
      ownerEmailVerified: owner?.emailVerified ?? null,
      ownerName: owner?.name ?? null,
    }
  }

  const active = (r: PatRecord, now: Date) =>
    r.revokedAt === null && r.expiresAt.getTime() > now.getTime()

  return {
    rows,
    owners,
    calls,

    async insertIfUnderCap(row, cap, now) {
      calls.insertIfUnderCap++
      const n = rows.filter((r) => r.userSub === row.userSub && active(r, now)).length
      if (n >= cap) return false
      rows.push({ ...row, scopes: [...row.scopes] })
      return true
    },

    async findByHash(tokenHash) {
      calls.findByHash++
      return withOwner(rows.find((r) => r.tokenHash === tokenHash))
    },

    async findById(id) {
      calls.findById++
      return withOwner(rows.find((r) => r.id === id))
    },

    async listForUser(userSub) {
      calls.listForUser++
      return rows
        .filter((r) => r.userSub === userSub && r.revokedAt === null)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map((r) => ({ ...r, scopes: [...r.scopes] }))
    },

    async revoke(userSub, id, now) {
      calls.revoke++
      const row = rows.find((r) => r.id === id && r.userSub === userSub && r.revokedAt === null)
      if (!row) return false
      row.revokedAt = now
      return true
    },

    async touchLastUsed(id, now, notBefore) {
      calls.touchLastUsed++
      const row = rows.find((r) => r.id === id)
      if (!row) return
      if (row.lastUsedAt === null || row.lastUsedAt.getTime() <= notBefore.getTime()) {
        row.lastUsedAt = now
      }
    },
  }
}
