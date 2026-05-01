/**
 * hocuspocus/auth.component.test.ts
 *
 * Tests for Hocuspocus onAuthenticate logic when the documentName starts with
 * `component:<id>` (M16 P5).
 *
 * Strategy: inline the auth routing logic (same pattern as auth.folder.test.ts)
 * and mock resolveComponentAccess / resolveFolderAccess / resolveDeckAccess.
 *
 * Coverage:
 *   - component:<id> + owner JWT → auth passes, readOnly=false, context.componentId set
 *   - component:<id> + non-owner JWT → throws 'Forbidden'
 *   - component:<id> + share_token → throws 'Forbidden' (no share-link for components)
 *   - component:<id> + no token → throws 'Invalid credentials'
 *   - component:<id> + missing component (resolveComponentAccess returns null) → throws 'Forbidden'
 *   - folder:<id> doc name still routes to resolveFolderAccess, not component
 *   - deck:<id> doc name still routes to resolveDeckAccess, not component
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { JwtVerifier, JwtPayload } from '../auth/jwt.js'
import type {
  DeckAccessResult,
  FolderAccessResult,
  ComponentAccessResult,
} from '../auth/permissions.js'
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
    resolveComponentAccess: vi.fn(),
  }
})

const { resolveDeckAccess, resolveFolderAccess, resolveComponentAccess } =
  await import('../auth/permissions.js')
const deckMock = resolveDeckAccess as ReturnType<typeof vi.fn>
const folderMock = resolveFolderAccess as ReturnType<typeof vi.fn>
const componentMock = resolveComponentAccess as ReturnType<typeof vi.fn>

// ---------------------------------------------------------------------------
// Inline auth logic (mirrors hocuspocus/index.ts onAuthenticate)
// Re-inlined here so the test doesn't spin up a WS server.
// ---------------------------------------------------------------------------

interface AuthContext {
  userId?: string
  deckId?: string
  folderId?: string
  componentId?: string
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
    if (!userId) throw new Error('Forbidden')
    const access = await resolveFolderAccess(db, { folderId, userId })
    if (!access) throw new Error('Forbidden')
    connection.context.userId = userId
    connection.context.folderId = folderId
    connection.context.role = access.role
    connection.readOnly = false
    return
  }

  if (documentName.startsWith('component:')) {
    const componentId = documentName.slice('component:'.length)
    if (!userId) throw new Error('Forbidden')
    const access = await resolveComponentAccess(db, { componentId, userId })
    if (!access) throw new Error('Forbidden')
    connection.context.userId = userId
    connection.context.componentId = componentId
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

describe('onAuthenticate — component:<id> routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('component doc + owner JWT → auth passes, readOnly=false, context.componentId set', async () => {
    const access: ComponentAccessResult = { role: 'owner', reason: 'direct' }
    componentMock.mockResolvedValueOnce(access)

    const conn = makeConnection()
    await runAuthenticate(
      {
        documentName: 'component:comp-1',
        token: 'valid',
        shareToken: null,
        connection: conn,
      },
      { verifier: makeVerifier({ sub: 'user-owner' }), bypass: false, db: makeMockDb() },
    )

    expect(conn.context.componentId).toBe('comp-1')
    expect(conn.context.role).toBe('owner')
    expect(conn.context.userId).toBe('user-owner')
    expect(conn.readOnly).toBe(false)
    expect(folderMock).not.toHaveBeenCalled()
    expect(deckMock).not.toHaveBeenCalled()
    expect(componentMock).toHaveBeenCalledWith(makeMockDb(), {
      componentId: 'comp-1',
      userId: 'user-owner',
    })
  })

  it('component doc + non-owner (resolveComponentAccess returns null) → throws Forbidden', async () => {
    componentMock.mockResolvedValueOnce(null)

    const conn = makeConnection()
    await expect(
      runAuthenticate(
        { documentName: 'component:comp-1', token: 'valid', shareToken: null, connection: conn },
        { verifier: makeVerifier({ sub: 'other-user' }), bypass: false, db: makeMockDb() },
      ),
    ).rejects.toThrow('Forbidden')
  })

  it('component doc + share_token → throws Forbidden (share-link not supported)', async () => {
    const conn = makeConnection()
    await expect(
      runAuthenticate(
        {
          documentName: 'component:comp-1',
          token: undefined,
          shareToken: 'some-share-token',
          connection: conn,
        },
        { verifier: null, bypass: false, db: makeMockDb() },
      ),
    ).rejects.toThrow('Forbidden')

    expect(componentMock).not.toHaveBeenCalled()
  })

  it('component doc + no token → throws Invalid credentials', async () => {
    const conn = makeConnection()
    await expect(
      runAuthenticate(
        { documentName: 'component:comp-1', connection: conn },
        { verifier: null, bypass: false, db: makeMockDb() },
      ),
    ).rejects.toThrow('Invalid credentials')
  })

  it('component doc + missing component → throws Forbidden', async () => {
    // resolveComponentAccess returns null when the component row doesn't exist
    componentMock.mockResolvedValueOnce(null)

    const conn = makeConnection()
    await expect(
      runAuthenticate(
        {
          documentName: 'component:nonexistent',
          token: 'valid',
          shareToken: null,
          connection: conn,
        },
        { verifier: makeVerifier({ sub: 'user-1' }), bypass: false, db: makeMockDb() },
      ),
    ).rejects.toThrow('Forbidden')
  })

  it('component doc + bypass mode → uses dev-user, passes if owner', async () => {
    componentMock.mockResolvedValueOnce({ role: 'owner', reason: 'direct' })

    const conn = makeConnection()
    await runAuthenticate(
      { documentName: 'component:comp-bypass', connection: conn },
      { verifier: null, bypass: true, db: makeMockDb() },
    )

    expect(conn.context.userId).toBe('dev-user')
    expect(conn.context.componentId).toBe('comp-bypass')
    expect(componentMock).toHaveBeenCalledWith(makeMockDb(), {
      componentId: 'comp-bypass',
      userId: 'dev-user',
    })
  })

  it('folder:<id> doc still routes to resolveFolderAccess, not component', async () => {
    folderMock.mockResolvedValueOnce({ role: 'owner', reason: 'direct' } as FolderAccessResult)

    const conn = makeConnection()
    await runAuthenticate(
      { documentName: 'folder:folder-1', token: 'valid', shareToken: null, connection: conn },
      { verifier: makeVerifier({ sub: 'user-1' }), bypass: false, db: makeMockDb() },
    )

    expect(conn.context.folderId).toBe('folder-1')
    expect(componentMock).not.toHaveBeenCalled()
    expect(deckMock).not.toHaveBeenCalled()
  })

  it('deck:<id> doc still routes to resolveDeckAccess, not component', async () => {
    deckMock.mockResolvedValueOnce({ role: 'owner', reason: 'direct' } as DeckAccessResult)

    const conn = makeConnection()
    await runAuthenticate(
      { documentName: 'deck:deck-1', token: 'valid', shareToken: null, connection: conn },
      { verifier: makeVerifier({ sub: 'user-1' }), bypass: false, db: makeMockDb() },
    )

    expect(conn.context.deckId).toBe('deck:deck-1')
    expect(componentMock).not.toHaveBeenCalled()
    expect(folderMock).not.toHaveBeenCalled()
  })
})
