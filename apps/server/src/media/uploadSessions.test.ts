import { describe, expect, it } from 'vitest'
import {
  UPLOAD_SESSION_CONTINUE_MS,
  UPLOAD_SESSION_TTL_MS,
  createUploadSessionService,
  hashUploadSessionToken,
  readBearerUploadSession,
} from './uploadSessions.js'
import { createMemoryUploadSessionStore } from '../test-support/memoryUploadSessionStore.js'

function clock(start = Date.parse('2026-09-28T12:00:00Z')) {
  let t = start
  return { now: () => new Date(t), advance: (ms: number) => (t += ms) }
}

describe('upload sessions', () => {
  it('issues a 256-bit token stored only as its hash', async () => {
    const store = createMemoryUploadSessionStore()
    const sessions = createUploadSessionService(store)
    const { token, expiresAt } = await sessions.issue({ userSub: 'u1', deckId: 'd1' })
    expect(token).toMatch(/^nus_[A-Za-z0-9_-]{43}$/)
    expect(store.rows).toHaveLength(1)
    expect(store.rows[0]!.tokenHash).toBe(hashUploadSessionToken(token))
    expect(JSON.stringify(store.rows)).not.toContain(token)
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(UPLOAD_SESSION_TTL_MS - 5_000)
  })

  it('verifies until it expires; a bound session continues for the grace period', async () => {
    const c = clock()
    const sessions = createUploadSessionService(createMemoryUploadSessionStore(), { now: c.now })
    const a = await sessions.issue({ userSub: 'u1', deckId: 'd1' })
    const b = await sessions.issue({ userSub: 'u1', deckId: 'd1' })
    const sb = (await sessions.verify(b.token))!
    expect(await sessions.claim(sb, 'upload-b')).toBe(true)
    c.advance(UPLOAD_SESSION_TTL_MS + 1)
    expect(await sessions.verify(a.token)).toBeNull()
    expect(await sessions.verify(b.token)).toMatchObject({ uploadId: 'upload-b' })
    c.advance(UPLOAD_SESSION_CONTINUE_MS)
    expect(await sessions.verify(b.token)).toBeNull()
  })

  it('binds once: a second claim, or a claim after expiry, fails', async () => {
    const c = clock()
    const sessions = createUploadSessionService(createMemoryUploadSessionStore(), { now: c.now })
    const { token } = await sessions.issue({ userSub: 'u1', deckId: 'd1' })
    const s = (await sessions.verify(token))!
    expect(await sessions.claim(s, 'first')).toBe(true)
    expect(await sessions.claim(s, 'second')).toBe(false)

    const late = await sessions.issue({ userSub: 'u1', deckId: 'd1' })
    const sl = (await sessions.verify(late.token))!
    c.advance(UPLOAD_SESSION_TTL_MS + 1)
    expect(await sessions.claim(sl, 'too-late')).toBe(false)
  })

  it('rejects malformed and unknown tokens, and sweeps day-old sessions when issuing', async () => {
    const c = clock()
    const store = createMemoryUploadSessionStore()
    const sessions = createUploadSessionService(store, { now: c.now })
    expect(await sessions.verify('nus_nope')).toBeNull()
    expect(await sessions.verify(`nus_${'A'.repeat(43)}`)).toBeNull()
    await sessions.issue({ userSub: 'u1', deckId: 'd1' })
    c.advance(UPLOAD_SESSION_TTL_MS + 25 * 60 * 60 * 1000)
    await sessions.issue({ userSub: 'u1', deckId: 'd1' })
    expect(store.rows).toHaveLength(1)
  })

  it('reads the token from a Bearer header only when it has the session prefix', () => {
    expect(readBearerUploadSession(`Bearer nus_${'a'.repeat(43)}`)).toBe(`nus_${'a'.repeat(43)}`)
    expect(readBearerUploadSession('Bearer nrt_something')).toBeNull()
    expect(readBearerUploadSession(undefined)).toBeNull()
  })
})
