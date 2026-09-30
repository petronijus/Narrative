import { describe, expect, it } from 'vitest'
import {
  MAX_OPEN_UPLOAD_SESSIONS,
  UploadSessionLimitError,
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
    const sessions = createUploadSessionService(store, { isOwnerAllowed: async () => true })
    const { token, expiresAt } = await sessions.issue({
      userSub: 'u1',
      owner: { deckId: 'd1' },
      sizeBytes: 1024,
      kind: 'image',
    })
    expect(token).toMatch(/^nus_[A-Za-z0-9_-]{43}$/)
    expect(store.rows).toHaveLength(1)
    expect(store.rows[0]!.tokenHash).toBe(hashUploadSessionToken(token))
    expect(JSON.stringify(store.rows)).not.toContain(token)
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(UPLOAD_SESSION_TTL_MS - 5_000)
  })

  it('verifies until it expires; a bound session continues for the grace period', async () => {
    const c = clock()
    const sessions = createUploadSessionService(createMemoryUploadSessionStore(), {
      isOwnerAllowed: async () => true,
      now: c.now,
    })
    const a = await sessions.issue({
      userSub: 'u1',
      owner: { deckId: 'd1' },
      sizeBytes: 1024,
      kind: 'image',
    })
    const b = await sessions.issue({
      userSub: 'u1',
      owner: { deckId: 'd1' },
      sizeBytes: 1024,
      kind: 'image',
    })
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
    const sessions = createUploadSessionService(createMemoryUploadSessionStore(), {
      isOwnerAllowed: async () => true,
      now: c.now,
    })
    const { token } = await sessions.issue({
      userSub: 'u1',
      owner: { deckId: 'd1' },
      sizeBytes: 1024,
      kind: 'image',
    })
    const s = (await sessions.verify(token))!
    expect(await sessions.claim(s, 'first')).toBe(true)
    expect(await sessions.claim(s, 'second')).toBe(false)

    const late = await sessions.issue({
      userSub: 'u1',
      owner: { deckId: 'd1' },
      sizeBytes: 1024,
      kind: 'image',
    })
    const sl = (await sessions.verify(late.token))!
    c.advance(UPLOAD_SESSION_TTL_MS + 1)
    expect(await sessions.claim(sl, 'too-late')).toBe(false)
  })

  it('rejects malformed and unknown tokens, and sweeps day-old sessions when issuing', async () => {
    const c = clock()
    const store = createMemoryUploadSessionStore()
    const sessions = createUploadSessionService(store, {
      isOwnerAllowed: async () => true,
      now: c.now,
    })
    expect(await sessions.verify('nus_nope')).toBeNull()
    expect(await sessions.verify(`nus_${'A'.repeat(43)}`)).toBeNull()
    await sessions.issue({ userSub: 'u1', owner: { deckId: 'd1' }, sizeBytes: 1024, kind: 'image' })
    c.advance(UPLOAD_SESSION_TTL_MS + 25 * 60 * 60 * 1000)
    await sessions.issue({ userSub: 'u1', owner: { deckId: 'd1' }, sizeBytes: 1024, kind: 'image' })
    expect(store.rows).toHaveLength(1)
  })

  it('reads the token from a Bearer header only when it has the session prefix', () => {
    expect(readBearerUploadSession(`Bearer nus_${'a'.repeat(43)}`)).toBe(`nus_${'a'.repeat(43)}`)
    expect(readBearerUploadSession('Bearer nrt_something')).toBeNull()
    expect(readBearerUploadSession(undefined)).toBeNull()
  })

  it('re-applies the sign-in policy on every use', async () => {
    let allowed = true
    const store = createMemoryUploadSessionStore({ u1: 'someone@example.org' })
    const seen: unknown[] = []
    const sessions = createUploadSessionService(store, {
      isOwnerAllowed: async (owner) => {
        seen.push(owner)
        return allowed
      },
    })
    const { token } = await sessions.issue({
      userSub: 'u1',
      owner: { deckId: 'd1' },
      sizeBytes: 1024,
      kind: 'image',
    })
    expect(await sessions.verify(token)).not.toBeNull()
    expect(seen[0]).toEqual({ userSub: 'u1', email: 'someone@example.org', emailVerified: true })
    allowed = false
    expect(await sessions.verify(token)).toBeNull()
  })

  it('keeps who asked for it, and caps the open sessions per user', async () => {
    const store = createMemoryUploadSessionStore()
    const sessions = createUploadSessionService(store, { isOwnerAllowed: async () => true })
    await sessions.issue({
      userSub: 'u1',
      owner: { deckId: 'd1' },
      credentialKey: 'token:t1',
      sizeBytes: 1024,
      kind: 'image',
    })
    expect(store.rows[0]!.credentialKey).toBe('token:t1')
    for (let i = 1; i < MAX_OPEN_UPLOAD_SESSIONS; i++) {
      await sessions.issue({
        userSub: 'u1',
        owner: { deckId: 'd1' },
        sizeBytes: 1024,
        kind: 'image',
      })
    }
    await expect(
      sessions.issue({ userSub: 'u1', owner: { deckId: 'd1' }, sizeBytes: 1024, kind: 'image' }),
    ).rejects.toBeInstanceOf(UploadSessionLimitError)
    // Another user is not affected; a used session no longer counts.
    await expect(
      sessions.issue({ userSub: 'u2', owner: { deckId: 'd1' }, sizeBytes: 1024, kind: 'image' }),
    ).resolves.toBeDefined()
    store.rows[0]!.uploadId = 'used'
    await expect(
      sessions.issue({ userSub: 'u1', owner: { deckId: 'd1' }, sizeBytes: 1024, kind: 'image' }),
    ).resolves.toBeDefined()
  })
})
