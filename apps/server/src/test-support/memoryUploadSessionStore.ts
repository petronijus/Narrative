/**
 * test-support/memoryUploadSessionStore.ts — an in-memory
 * `UploadSessionStore` with the Drizzle store's semantics (atomic claim of
 * an unbound, unexpired session; sweep by expiry). The Drizzle store runs
 * against Postgres in uploadSessions.integration.test.ts.
 */

import type { UploadSessionRecord, UploadSessionStore } from '../media/uploadSessions.js'

export function createMemoryUploadSessionStore(): UploadSessionStore & {
  readonly rows: UploadSessionRecord[]
} {
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
      return row === undefined ? null : { ...row }
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
