/**
 * hocuspocus/auth.folder.test.ts
 *
 * Tests for Hocuspocus onAuthenticate logic when the documentName starts with
 * `folder:<id>` (M16 P2).
 *
 * Strategy: inline the auth routing logic (same pattern as auth.test.ts) and
 * mock resolveFolderAccess / resolveDeckAccess for isolation.
 *
 * Coverage:
 *   - folder:<id> + owner JWT → auth passes, readOnly=false
 *   - folder:<id> + non-owner JWT → throws 'Forbidden'
 *   - folder:<id> + share_token → throws 'Forbidden' (no share-link for folders)
 *   - folder:<id> + no token → throws 'Invalid credentials'
 *   - deck:<id> (existing path) still routes to resolveDeckAccess, not folder
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { JwtVerifier, JwtPayload } from '../auth/jwt.js'
import type { DeckAccessResult, FolderAccessResult } from '../auth/permissions.js'
import type { Database } from '../db/client.js'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../auth/permissions.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../auth/permissions.js')>()
  return {
    ...original,
    resolveDeckAccess: vi.fn(),
    resolveFolderAccess: vi.fn(),
  }
})

const { resolveDeckAccess, resolveFolderAccess } = await import('../auth/permissions.js')
const deckMock = resolveDeckAccess as ReturnType<typeof vi.fn>
const folderMock = resolveFolderAccess as ReturnType<typeof vi.fn>

// ---------------------------------------------------------------------------
// Inline auth logic (mirrors hocuspocus/index.ts onAuthenticate)
// Re-inlined here so the test doesn't spin up a WS server.
// ---------------------------------------------------------------------------

interface AuthContext {
  userId?: string
  deckId?: string
  folderId?: string
  role?: string
}

interface AuthInput {
  documentName: string
  token?: string | undefined
  shareToken?: string | null | undefined
  connection: { context: AuthContext; readOnly: boolean }
}

async function runAuthenticate(
  input: AuthInput,
  opts: {
    verifier: JwtVerifier | null
    bypass: boolean
    db: Database
  },
): Promise<void> {
  const { documentName, token, shareToken, connection } = input
  const { verifier, bypass, db } = opts

  let userId: string | null = null

  if (shareToken) {
    // share-token path
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

  if (documentName.startsWith('folder:')) {
    const folderId = documentName.slice('folder:'.length)

    if (!userId) {
      throw new Error('Forbidden')
    }

    const access = await resolveFolderAccess(db, { folderId, userId })
    if (!access) {
      throw new Error('Forbidden')
    }

    connection.context.userId = userId
    connection.context.folderId = folderId
    connection.context.role = access.role
    connection.readOnly = false
    return
  }

  // Deck path
  const access = await resolveDeckAccess(db, {
    deckId: documentName,
    userId,
    shareToken: shareToken ?? null,
  })

  if (!access) throw new Error('Forbidden')

  const displayId = userId ?? `share:${shareToken?.slice(0, 8)}`
  connection.context.userId = displayId
  connection.context.deckId = documentName
  connection.context.role = access.role
  connection.readOnly = access.role === 'viewer'
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeVerifier(result: JwtPayload | 'throw'): JwtVerifier {
  return {
    verify: vi.fn(async (token: string) => {
      if (result === 'throw') throw new Error('bad')
      if (token === 'valid') return result
      throw new Error('bad token')
    }),
  }
}

function makeMockDb(): Database {
  return {} as unknown as Database
}

function makeConnection(): { context: AuthContext; readOnly: boolean } {
  return { context: {}, readOnly: false }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('onAuthenticate — folder:<id> routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('folder doc + owner JWT → auth passes, readOnly=false, context.folderId set', async () => {
    const access: FolderAccessResult = { role: 'owner', reason: 'direct' }
    folderMock.mockResolvedValueOnce(access)

    const conn = makeConnection()
    await runAuthenticate(
      { documentName: 'folder:folder-1', token: 'valid', shareToken: null, connection: conn },
      { verifier: makeVerifier({ sub: 'user-owner' }), bypass: false, db: makeMockDb() },
    )

    expect(conn.context.folderId).toBe('folder-1')
    expect(conn.context.role).toBe('owner')
    expect(conn.context.userId).toBe('user-owner')
    expect(conn.readOnly).toBe(false)
    // resolveDeckAccess should NOT have been called
    expect(deckMock).not.toHaveBeenCalled()
    // resolveFolderAccess should have been called with correct args
    expect(folderMock).toHaveBeenCalledWith(makeMockDb(), {
      folderId: 'folder-1',
      userId: 'user-owner',
    })
  })

  it('folder doc + non-owner JWT (resolveFolderAccess returns null) → throws Forbidden', async () => {
    folderMock.mockResolvedValueOnce(null)

    const conn = makeConnection()
    await expect(
      runAuthenticate(
        { documentName: 'folder:folder-1', token: 'valid', shareToken: null, connection: conn },
        { verifier: makeVerifier({ sub: 'other-user' }), bypass: false, db: makeMockDb() },
      ),
    ).rejects.toThrow('Forbidden')

    expect(conn.readOnly).toBe(false) // never set (threw before)
  })

  it('folder doc + share_token → throws Forbidden (share-link not supported for folders)', async () => {
    const conn = makeConnection()
    await expect(
      runAuthenticate(
        {
          documentName: 'folder:folder-1',
          token: undefined,
          shareToken: 'some-share-token',
          connection: conn,
        },
        { verifier: null, bypass: false, db: makeMockDb() },
      ),
    ).rejects.toThrow('Forbidden')

    expect(folderMock).not.toHaveBeenCalled()
  })

  it('folder doc + no token → throws Invalid credentials', async () => {
    const conn = makeConnection()
    await expect(
      runAuthenticate(
        { documentName: 'folder:folder-1', connection: conn },
        { verifier: null, bypass: false, db: makeMockDb() },
      ),
    ).rejects.toThrow('Invalid credentials')
  })

  it('folder doc + bypass mode → uses dev-user, passes if owner', async () => {
    folderMock.mockResolvedValueOnce({ role: 'owner', reason: 'direct' })

    const conn = makeConnection()
    await runAuthenticate(
      { documentName: 'folder:folder-bypass', connection: conn },
      { verifier: null, bypass: true, db: makeMockDb() },
    )

    expect(conn.context.userId).toBe('dev-user')
    expect(conn.context.folderId).toBe('folder-bypass')
    expect(folderMock).toHaveBeenCalledWith(makeMockDb(), {
      folderId: 'folder-bypass',
      userId: 'dev-user',
    })
  })

  it('deck:<id> doc name still routes to resolveDeckAccess, not folder', async () => {
    // Reset between tests
    deckMock.mockResolvedValueOnce({ role: 'owner', reason: 'direct' } as DeckAccessResult)
    folderMock.mockReset()

    const conn = makeConnection()
    await runAuthenticate(
      { documentName: 'deck:deck-1', token: 'valid', shareToken: null, connection: conn },
      { verifier: makeVerifier({ sub: 'user-1' }), bypass: false, db: makeMockDb() },
    )

    expect(conn.context.deckId).toBe('deck:deck-1')
    expect(folderMock).not.toHaveBeenCalled()
    expect(deckMock).toHaveBeenCalledWith(makeMockDb(), {
      deckId: 'deck:deck-1',
      userId: 'user-1',
      shareToken: null,
    })
  })
})
