/**
 * hocuspocus/auth.test.ts
 *
 * Tests for Hocuspocus onAuthenticate logic and viewer write blocking.
 *
 * We don't spin up a full WebSocket server here — instead we test the
 * authentication logic in isolation by mocking the Hocuspocus Server and
 * calling the relevant hooks directly.
 *
 * Coverage:
 *   - Valid JWT + owner access → auth passes, readOnly=false
 *   - Valid JWT + no deck access → throws 'Forbidden'
 *   - Share token + valid viewer link → auth passes with role=viewer, readOnly=true
 *   - Invalid JWT → throws 'Invalid credentials'
 *   - No token, no share_token → throws 'Invalid credentials'
 *   - Viewer onStoreDocument → persistence blocked
 *   - Non-viewer onStoreDocument → persistence proceeds
 */

import { describe, it, expect, vi, beforeAll } from 'vitest'
import type { JwtVerifier, JwtPayload } from '../auth/jwt.js'
import type { DeckAccessResult } from '../auth/permissions.js'
import type { Database } from '../db/client.js'
import { PostgresPersistence } from './persistence.js'
import type { onStoreDocumentPayload } from '@hocuspocus/server'
import * as Y from 'yjs'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock resolveDeckAccess for isolation
vi.mock('../auth/permissions.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../auth/permissions.js')>()
  return {
    ...original,
    resolveDeckAccess: vi.fn(),
  }
})

const { resolveDeckAccess } = await import('../auth/permissions.js')
const resolveMock = resolveDeckAccess as ReturnType<typeof vi.fn>

// ---------------------------------------------------------------------------
// Inline auth logic (extracted from createHocuspocusServer for testability)
// The actual onAuthenticate handler from hocuspocus/index.ts is inlined here
// because Hocuspocus Server.configure() requires a running environment to
// invoke hooks. We extract the core logic into a testable function instead.
// ---------------------------------------------------------------------------

interface AuthContext {
  userId?: string
  deckId?: string
  role?: string
}

interface AuthInput {
  documentName: string
  token?: string | undefined
  shareToken?: string | null | undefined
  connection: { context: AuthContext }
}

/**
 * Core auth logic extracted from onAuthenticate — testable without a WS server.
 * Returns { readOnly } or throws.
 */
async function runAuthenticate(
  input: AuthInput,
  opts: {
    verifier: JwtVerifier | null
    bypass: boolean
    db: Database
  },
): Promise<{ readOnly: boolean }> {
  const { documentName, token, shareToken, connection } = input
  const { verifier, bypass, db } = opts

  let userId: string | null = null

  if (shareToken) {
    // Share-token access — skip JWT
  } else if (bypass) {
    userId = 'dev-user'
  } else if (token) {
    if (!verifier) throw new Error('Invalid credentials')
    try {
      const payload = await verifier.verify(token)
      userId = payload.sub
    } catch {
      throw new Error('Invalid credentials')
    }
  } else {
    throw new Error('Invalid credentials')
  }

  const access = await resolveDeckAccess(db, {
    deckId: documentName,
    userId,
    shareToken: shareToken ?? null,
  })

  if (!access) {
    throw new Error('Forbidden')
  }

  const displayId = userId ?? `share:${shareToken?.slice(0, 8)}`
  connection.context.userId = displayId
  connection.context.deckId = documentName
  connection.context.role = access.role

  return { readOnly: access.role === 'viewer' }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeVerifier(result: JwtPayload | 'throw'): JwtVerifier {
  return {
    verify: vi.fn(async (token: string) => {
      if (result === 'throw') throw new Error('Invalid credentials')
      if (token === 'valid') return result
      throw new Error('Invalid credentials')
    }),
  }
}

function makeMockDb(): Database {
  return {} as unknown as Database
}

function makeConnection(): { context: AuthContext } {
  return { context: {} }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('onAuthenticate core logic', () => {
  beforeAll(() => {
    vi.clearAllMocks()
  })

  it('valid JWT + owner access → auth passes, readOnly=false', async () => {
    const user: JwtPayload = { sub: 'user-1' }
    const access: DeckAccessResult = { role: 'owner', reason: 'direct' }
    resolveMock.mockResolvedValueOnce(access)

    const conn = makeConnection()
    const result = await runAuthenticate(
      { documentName: 'deck-1', token: 'valid', shareToken: null, connection: conn },
      { verifier: makeVerifier(user), bypass: false, db: makeMockDb() },
    )

    expect(result.readOnly).toBe(false)
    expect(conn.context.role).toBe('owner')
    expect(conn.context.userId).toBe('user-1')
  })

  it('valid JWT + no deck access → throws Forbidden', async () => {
    resolveMock.mockResolvedValueOnce(null)
    const user: JwtPayload = { sub: 'user-2' }

    const conn = makeConnection()
    await expect(
      runAuthenticate(
        { documentName: 'deck-x', token: 'valid', shareToken: null, connection: conn },
        { verifier: makeVerifier(user), bypass: false, db: makeMockDb() },
      ),
    ).rejects.toThrow('Forbidden')
  })

  it('share token + viewer access → auth passes, readOnly=true', async () => {
    const access: DeckAccessResult = { role: 'viewer', reason: 'share-link' }
    resolveMock.mockResolvedValueOnce(access)

    const conn = makeConnection()
    const result = await runAuthenticate(
      { documentName: 'deck-1', shareToken: 'share-token-abc', connection: conn },
      { verifier: null, bypass: false, db: makeMockDb() },
    )

    expect(result.readOnly).toBe(true)
    expect(conn.context.role).toBe('viewer')
  })

  it('share token + editor access → readOnly=false', async () => {
    const access: DeckAccessResult = { role: 'editor', reason: 'share-link' }
    resolveMock.mockResolvedValueOnce(access)

    const conn = makeConnection()
    const result = await runAuthenticate(
      { documentName: 'deck-1', shareToken: 'edit-token', connection: conn },
      { verifier: null, bypass: false, db: makeMockDb() },
    )

    expect(result.readOnly).toBe(false)
  })

  it('invalid JWT → throws Invalid credentials', async () => {
    resolveMock.mockResolvedValueOnce({ role: 'owner', reason: 'direct' })
    const conn = makeConnection()

    await expect(
      runAuthenticate(
        { documentName: 'deck-1', token: 'bad-token', shareToken: null, connection: conn },
        { verifier: makeVerifier('throw'), bypass: false, db: makeMockDb() },
      ),
    ).rejects.toThrow('Invalid credentials')
  })

  it('no token and no share_token → throws Invalid credentials', async () => {
    const conn = makeConnection()

    await expect(
      runAuthenticate(
        { documentName: 'deck-1', connection: conn },
        { verifier: makeVerifier('throw'), bypass: false, db: makeMockDb() },
      ),
    ).rejects.toThrow('Invalid credentials')
  })

  it('bypass mode → uses dev-user without calling verifier', async () => {
    const access: DeckAccessResult = { role: 'editor', reason: 'direct' }
    resolveMock.mockResolvedValueOnce(access)
    const verifier = makeVerifier({ sub: 'should-not-be-called' })

    const conn = makeConnection()
    await runAuthenticate(
      { documentName: 'deck-1', token: 'ignored', shareToken: null, connection: conn },
      { verifier, bypass: true, db: makeMockDb() },
    )

    expect(conn.context.userId).toBe('dev-user')
    expect(verifier.verify).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// PostgresPersistence viewer write blocking
// ---------------------------------------------------------------------------

describe('PostgresPersistence — viewer write blocking', () => {
  it('skips persistence when context.role is viewer', async () => {
    const mockDb = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockResolvedValue([]),
      }),
    }

    const persistence = new PostgresPersistence({ db: mockDb as unknown as Database })
    const doc = new Y.Doc()

    const payload: onStoreDocumentPayload = {
      document: doc,
      documentName: 'deck-1',
      context: { role: 'viewer', userId: 'viewer-user' },
    } as unknown as onStoreDocumentPayload

    await persistence.onStoreDocument(payload)

    expect(mockDb.insert).not.toHaveBeenCalled()
  })

  // PERF-2: onStoreDocument now runs the insert+compaction-delete inside
  // db.transaction(). This mock models the transactional store path: the tx
  // exposes insert().values().returning() and delete().where(). We assert the
  // non-viewer write actually reaches the insert inside the transaction.
  function makeTxDb() {
    const mockInsert = vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 1 }]),
      }),
    })
    const mockDelete = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue({ rowCount: 0 }),
    })
    const tx = { insert: mockInsert, delete: mockDelete }
    const db = {
      transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    }
    return { db, mockInsert }
  }

  it('persists when context.role is editor', async () => {
    const { db, mockInsert } = makeTxDb()
    const persistence = new PostgresPersistence({ db: db as unknown as Database })
    const doc = new Y.Doc()

    const payload: onStoreDocumentPayload = {
      document: doc,
      documentName: 'deck-1',
      context: { role: 'editor', userId: 'editor-user' },
    } as unknown as onStoreDocumentPayload

    await persistence.onStoreDocument(payload)

    expect(mockInsert).toHaveBeenCalled()
  })

  it('persists when context.role is owner', async () => {
    const { db, mockInsert } = makeTxDb()
    const persistence = new PostgresPersistence({ db: db as unknown as Database })
    const doc = new Y.Doc()

    const payload: onStoreDocumentPayload = {
      document: doc,
      documentName: 'deck-1',
      context: { role: 'owner', userId: 'owner-user' },
    } as unknown as onStoreDocumentPayload

    await persistence.onStoreDocument(payload)

    expect(mockInsert).toHaveBeenCalled()
  })

  it('persists when context is undefined (unauthenticated server-side write)', async () => {
    const { db, mockInsert } = makeTxDb()
    const persistence = new PostgresPersistence({ db: db as unknown as Database })
    const doc = new Y.Doc()

    const payload: onStoreDocumentPayload = {
      document: doc,
      documentName: 'deck-1',
      context: undefined,
    } as unknown as onStoreDocumentPayload

    await persistence.onStoreDocument(payload)

    expect(mockInsert).toHaveBeenCalled()
  })
})
