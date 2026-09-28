/**
 * test-support/memoryUploadSessionStore.ts — an in-memory
 * `UploadSessionStore` with the Drizzle store's semantics (atomic claim of
 * an unbound, unexpired session; open-session count; sweep by expiry). The
 * Drizzle store runs against Postgres in uploadSessions.integration.test.ts.
 * Owners' emails come from `owners` (sub → email), like the users join.
 */

import type {
  UploadSessionRecord,
  UploadSessionService,
  UploadSessionStore,
} from '../media/uploadSessions.js'
import { createUploadSessionService } from '../media/uploadSessions.js'

export function createMemoryUploadSessionStore(
  owners: Record<string, string> = {},
): UploadSessionStore & { readonly rows: UploadSessionRecord[] } {
  const rows: UploadSessionRecord[] = []
  return {
    rows,
    async insert(record) {
      if (rows.some((r) => r.id === record.id || r.tokenHash === record.tokenHash)) {
        throw new Error('duplicate upload session')
      }
      rows.push({ ...record })
    },
    async findByHash(tokenHash) {
      const row = rows.find((r) => r.tokenHash === tokenHash)
      if (row === undefined) return null
      const email = owners[row.userSub] ?? null
      return { ...row, ownerEmail: email, ownerEmailVerified: email !== null }
    },
    async countOpen(userSub, now) {
      return rows.filter((r) => r.userSub === userSub && r.uploadId === null && r.expiresAt > now)
        .length
    },
    async claim(id, uploadId, now) {
      const row = rows.find((r) => r.id === id)
      if (row === undefined || row.uploadId !== null || row.expiresAt <= now) return false
      row.uploadId = uploadId
      return true
    },
    async sweep(before) {
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i]!.expiresAt < before) rows.splice(i, 1)
    },
  }
}

/** A service over a memory store whose sign-in policy lets everyone in. */
export function createAllowingUploadSessionService(
  store: UploadSessionStore = createMemoryUploadSessionStore(),
  now?: () => Date,
): UploadSessionService {
  return createUploadSessionService(store, {
    isOwnerAllowed: async () => true,
    ...(now === undefined ? {} : { now }),
  })
}
