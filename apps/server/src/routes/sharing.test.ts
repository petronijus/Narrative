/**
 * routes/sharing.test.ts
 *
 * Tests for sharing management endpoints.
 *
 * Strategy: mock all auth helper functions (listPermissions, grantPermission, etc.)
 * and resolveDeckAccess so tests don't depend on a real Drizzle DB.
 *
 * Coverage:
 *   GET /decks/:id/permissions          → returns list
 *   POST /decks/:id/permissions         → grants permission, 204
 *   DELETE /decks/:id/permissions/:uid  → revokes, 204; 409 on last owner
 *   GET /decks/:id/share-links          → returns active links
 *   POST /decks/:id/share-links         → creates link, returns {id, url}
 *   DELETE /decks/:id/share-links/:lid  → revokes, 204
 *   Non-owner access → 403
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerAuthPlugin } from '../auth/fastifyAuth.js'
import type { Database } from '../db/client.js'
import type { DeckRole, DeckAccessResult, PermissionRow } from '../auth/permissions.js'
import type { ShareLinkRow } from '../auth/shareLinks.js'
import { scriptedDb } from '../test-support/scriptedDb.js'

// ---------------------------------------------------------------------------
// Mock auth modules — so no Drizzle queries run in route tests
// vi.mock is hoisted to top of file, so factories cannot reference outer variables.
// We use vi.fn() inside the factories and re-import after mocking to get references.
// ---------------------------------------------------------------------------

vi.mock('../auth/permissions.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../auth/permissions.js')>()
  return {
    ...original,
    resolveDeckAccess: vi.fn(),
    listPermissions: vi.fn(),
    grantPermission: vi.fn(),
    revokePermission: vi.fn(),
    // After a revoke: does the user still reach the deck's folder another way?
    resolveFolderContentAccess: vi.fn(),
    roleAtLeast: original.roleAtLeast, // keep real implementation for role checks
  }
})

vi.mock('../auth/shareLinks.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../auth/shareLinks.js')>()
  return {
    ...original,
    listShareLinks: vi.fn(),
    createShareLink: vi.fn(),
    revokeShareLink: vi.fn(),
  }
})

vi.mock('../auth/users.js', () => ({
  getUserByEmail: vi.fn(),
  listUsersBySubs: vi.fn(),
  upsertUser: vi.fn(),
  getUserBySub: vi.fn(),
}))

vi.mock('../auth/invites.js', () => ({
  createInvite: vi.fn(),
  listPendingInvitesForDeck: vi.fn(),
  revokeInvite: vi.fn(),
  consumePendingInvitesForEmail: vi.fn(),
}))

vi.mock('../email/client.js', () => ({
  sendEmail: vi.fn(),
}))

// Import after mocking to get mock fn references
const permissions = await import('../auth/permissions.js')
const shareLinksModule = await import('../auth/shareLinks.js')
const usersModule = await import('../auth/users.js')
const invitesModule = await import('../auth/invites.js')
const emailModule = await import('../email/client.js')
const { registerSharingRoutes } = await import('./sharing.js')

const mockResolveDeckAccess = permissions.resolveDeckAccess as ReturnType<typeof vi.fn>
const mockListPermissions = permissions.listPermissions as ReturnType<typeof vi.fn>
const mockGrantPermission = permissions.grantPermission as ReturnType<typeof vi.fn>
const mockRevokePermission = permissions.revokePermission as ReturnType<typeof vi.fn>
const mockListShareLinks = shareLinksModule.listShareLinks as ReturnType<typeof vi.fn>
const mockCreateShareLink = shareLinksModule.createShareLink as ReturnType<typeof vi.fn>
const mockRevokeShareLink = shareLinksModule.revokeShareLink as ReturnType<typeof vi.fn>
const mockGetUserByEmail = usersModule.getUserByEmail as ReturnType<typeof vi.fn>
const mockGetUserBySub = usersModule.getUserBySub as ReturnType<typeof vi.fn>
const mockListUsersBySubs = usersModule.listUsersBySubs as ReturnType<typeof vi.fn>
const mockCreateInvite = invitesModule.createInvite as ReturnType<typeof vi.fn>
const mockListPendingInvites = invitesModule.listPendingInvitesForDeck as ReturnType<typeof vi.fn>
const mockRevokeInvite = invitesModule.revokeInvite as ReturnType<typeof vi.fn>
const mockSendEmail = emailModule.sendEmail as ReturnType<typeof vi.fn>

// ---------------------------------------------------------------------------
// App builder
// ---------------------------------------------------------------------------

async function buildApp(
  ownerAccess: DeckAccessResult | null = { role: 'owner', reason: 'direct' },
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  const db = {} as Database // unused — all db calls are mocked at function level

  registerAuthPlugin(app, { bypass: true, db })

  // Default: dev-user has specified access on any deck
  mockResolveDeckAccess.mockResolvedValue(ownerAccess)

  await registerSharingRoutes(app, db)
  await app.ready()
  return app
}

// ---------------------------------------------------------------------------
// Tests — permissions
// ---------------------------------------------------------------------------

describe('GET /decks/:id/permissions (enriched with users)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveDeckAccess.mockResolvedValue({ role: 'owner', reason: 'direct' })
  })

  it('enriches each permission row with email + name from users directory', async () => {
    const now = new Date()
    mockListPermissions.mockResolvedValue([
      { userId: 'sub-dev', role: 'owner', grantedAt: now, grantedBy: null },
      { userId: 'sub-alice', role: 'editor', grantedAt: now, grantedBy: 'sub-dev' },
    ])
    mockListUsersBySubs.mockResolvedValue([
      {
        sub: 'sub-alice',
        email: 'alice@example.com',
        name: 'Alice',
        pictureUrl: null,
        firstSeenAt: now,
        lastSeenAt: now,
      },
    ])

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/decks/deck-1/permissions' })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as Array<{
      userId: string
      email: string | null
      name: string | null
    }>
    expect(body).toHaveLength(2)
    const alice = body.find((r) => r.userId === 'sub-alice')!
    expect(alice.email).toBe('alice@example.com')
    expect(alice.name).toBe('Alice')
    // dev-user has no directory row — should still appear, with null fields
    const dev = body.find((r) => r.userId === 'sub-dev')!
    expect(dev.email).toBeNull()
    expect(dev.name).toBeNull()
  })
})

describe('POST /decks/:id/permissions (invite by email)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveDeckAccess.mockResolvedValue({ role: 'owner', reason: 'direct' })
    mockGrantPermission.mockResolvedValue(undefined)
  })

  it('grants directly with kind=granted when the email already has a user row', async () => {
    const now = new Date()
    mockGetUserByEmail.mockResolvedValue({
      sub: 'sub-bob',
      email: 'bob@example.com',
      name: 'Bob',
      pictureUrl: null,
      firstSeenAt: now,
      lastSeenAt: now,
    })
    const app = await buildApp()

    const res = await app.inject({
      method: 'POST',
      url: '/decks/deck-1/permissions',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'bob@example.com', role: 'editor' }),
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { kind: string; user: { userId: string; role: string } }
    expect(body.kind).toBe('granted')
    expect(body.user.userId).toBe('sub-bob')
    expect(body.user.role).toBe('editor')

    expect(mockGrantPermission).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: 'sub-bob', role: 'editor', grantedBy: 'dev-user' }),
    )
    expect(mockCreateInvite).not.toHaveBeenCalled()
    // Instant-grant path does NOT send an invite email — the collaborator
    // already has an account, the dialog already shows them in the list.
    await new Promise((r) => setImmediate(r))
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('creates a pending invite with kind=pending when the email is unknown', async () => {
    mockGetUserByEmail.mockResolvedValue(null)
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    mockCreateInvite.mockResolvedValue({ id: 'inv-xyz', expiresAt, replaced: false })
    const app = await buildApp()

    const res = await app.inject({
      method: 'POST',
      url: '/decks/deck-1/permissions',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'newcomer@example.com', role: 'viewer' }),
    })

    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body) as {
      kind: string
      invite: { id: string; email: string; role: string }
    }
    expect(body.kind).toBe('pending')
    expect(body.invite.email).toBe('newcomer@example.com')
    expect(body.invite.role).toBe('viewer')
    expect(body.invite.id).toBe('inv-xyz')

    expect(mockCreateInvite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        deckId: 'deck-1',
        email: 'newcomer@example.com',
        role: 'viewer',
        invitedBySub: 'dev-user',
      }),
    )
    expect(mockGrantPermission).not.toHaveBeenCalled()
  })

  it('fires invite email after creating a pending invite', async () => {
    mockGetUserByEmail.mockResolvedValue(null)
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    mockCreateInvite.mockResolvedValue({ id: 'inv-mail', expiresAt, replaced: false })

    const now = new Date()
    mockGetUserBySub.mockResolvedValue({
      sub: 'dev-user',
      email: 'inviter@example.com',
      name: 'Inviter Name',
      pictureUrl: null,
      firstSeenAt: now,
      lastSeenAt: now,
    })

    // Per-test app with a db.select stub that returns the deck row used in
    // the email subject. Built inline (not via buildApp) because the
    // shared helper passes an empty object as db.
    const localApp = Fastify({ logger: false })
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ title: 'Quarterly Update' }]),
          }),
        }),
      }),
    } as unknown as Database
    mockResolveDeckAccess.mockResolvedValue({ role: 'owner', reason: 'direct' })
    registerAuthPlugin(localApp, { bypass: true, db })
    await registerSharingRoutes(localApp, db)
    await localApp.ready()

    const prevSpa = process.env['SPA_ORIGIN']
    process.env['SPA_ORIGIN'] = 'https://narrative.test'

    const res = await localApp.inject({
      method: 'POST',
      url: '/decks/deck-1/permissions',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'pending@example.com', role: 'editor' }),
    })

    expect(res.statusCode).toBe(201)
    // Let the fire-and-forget background work flush.
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    expect(mockSendEmail).toHaveBeenCalledTimes(1)
    const arg = mockSendEmail.mock.calls[0]![0] as {
      to: string
      subject: string
      html: string
      text: string
    }
    expect(arg.to).toBe('pending@example.com')
    expect(arg.subject).toContain('Quarterly Update')
    expect(arg.subject).toContain('Inviter Name')
    expect(arg.text).toContain('https://narrative.test/api/auth/start?returnTo=')
    expect(arg.text).toContain(encodeURIComponent('/deck/deck-1'))
    expect(arg.html).toContain('Quarterly Update')

    if (prevSpa === undefined) delete process.env['SPA_ORIGIN']
    else process.env['SPA_ORIGIN'] = prevSpa
  })

  it('returns 400 on missing email', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/decks/deck-1/permissions',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'editor' }),
    })
    expect(res.statusCode).toBe(400)
  })

  it('returns 400 on malformed email', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/decks/deck-1/permissions',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email', role: 'editor' }),
    })
    expect(res.statusCode).toBe(400)
  })

  it('returns 400 on invalid role', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/decks/deck-1/permissions',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'x@y.z', role: 'superadmin' }),
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects self-role-change with 409 (only another owner can change you)', async () => {
    // The caller is `dev-user` (bypass mode). If the resolved user for the
    // posted email has the SAME sub, the server must refuse.
    const now = new Date()
    mockGetUserByEmail.mockResolvedValue({
      sub: 'dev-user',
      email: 'me@example.com',
      name: 'Me',
      pictureUrl: null,
      firstSeenAt: now,
      lastSeenAt: now,
    })
    const app = await buildApp()

    const res = await app.inject({
      method: 'POST',
      url: '/decks/deck-1/permissions',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'me@example.com', role: 'viewer' }),
    })

    expect(res.statusCode).toBe(409)
    expect(mockGrantPermission).not.toHaveBeenCalled()
  })
})

describe('GET /decks/:id/invites', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveDeckAccess.mockResolvedValue({ role: 'owner', reason: 'direct' })
  })

  it('returns pending invites for the deck', async () => {
    const now = new Date()
    const expiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    mockListPendingInvites.mockResolvedValue([
      {
        id: 'inv-1',
        deckId: 'deck-1',
        email: 'pending@example.com',
        role: 'editor',
        invitedBySub: 'dev-user',
        invitedAt: now,
        expiresAt: expiry,
        acceptedAt: null,
        acceptedBySub: null,
      },
    ])
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/decks/deck-1/invites' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as Array<{ id: string; email: string; role: string }>
    expect(body).toHaveLength(1)
    expect(body[0]!.email).toBe('pending@example.com')
    expect(body[0]!.role).toBe('editor')
  })
})

describe('DELETE /decks/:id/invites/:inviteId', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveDeckAccess.mockResolvedValue({ role: 'owner', reason: 'direct' })
    mockRevokeInvite.mockResolvedValue(undefined)
  })

  it('cancels a pending invite and returns 204', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'DELETE',
      url: '/decks/deck-1/invites/inv-1',
    })
    expect(res.statusCode).toBe(204)
    expect(mockRevokeInvite).toHaveBeenCalledWith(expect.anything(), {
      deckId: 'deck-1',
      inviteId: 'inv-1',
    })
  })
})

describe('DELETE /decks/:id/permissions/:userId', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRevokePermission.mockResolvedValue(undefined)
  })

  it('revokes permission and returns 204 when multiple owners exist', async () => {
    const now = new Date()
    mockResolveDeckAccess.mockResolvedValue({ role: 'owner', reason: 'direct' })
    // Two owners exist — safe to revoke alice
    mockListPermissions.mockResolvedValue([
      { userId: 'dev-user', role: 'owner', grantedAt: now, grantedBy: null },
      { userId: 'alice', role: 'owner', grantedAt: now, grantedBy: 'dev-user' },
    ])

    // The DELETE route queries deckPermissions directly (not listPermissions)
    // for the owner count, then the deck's folder — whose token document
    // the revoked user leaves when this deck was their way into it.
    const { db } = scriptedDb({
      selects: [[{ userId: 'dev-user' }, { userId: 'alice' }], [{ folderId: 'f1' }]],
    })
    vi.mocked(permissions.resolveFolderContentAccess).mockResolvedValue(null)

    const app = Fastify({ logger: false })
    registerAuthPlugin(app, { bypass: true, db })
    mockResolveDeckAccess.mockResolvedValue({ role: 'owner', reason: 'direct' })
    await registerSharingRoutes(app, db)
    await app.ready()

    const res = await app.inject({
      method: 'DELETE',
      url: '/decks/deck-1/permissions/alice',
    })

    expect(res.statusCode).toBe(204)
    expect(mockRevokePermission).toHaveBeenCalledWith(expect.anything(), {
      deckId: 'deck-1',
      userId: 'alice',
    })
    expect(permissions.resolveFolderContentAccess).toHaveBeenCalledWith(expect.anything(), {
      folderId: 'f1',
      userId: 'alice',
    })
  })

  it('returns 409 when revoking the last owner', async () => {
    mockResolveDeckAccess.mockResolvedValue({ role: 'owner', reason: 'direct' })

    // Only one owner row (alice) — revoking would leave deck ownerless.
    // Caller is `dev-user`, target is `alice` so the self-revoke guard
    // does NOT fire and we exercise the last-owner branch.
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ userId: 'alice' }]),
        }),
      }),
    } as unknown as Database

    const app = Fastify({ logger: false })
    registerAuthPlugin(app, { bypass: true, db })
    mockResolveDeckAccess.mockResolvedValue({ role: 'owner', reason: 'direct' })
    await registerSharingRoutes(app, db)
    await app.ready()

    const res = await app.inject({
      method: 'DELETE',
      url: '/decks/deck-1/permissions/alice',
    })

    expect(res.statusCode).toBe(409)
    const body = JSON.parse(res.body) as { error: string }
    expect(body.error).toContain('last owner')
  })

  it('returns 409 when caller tries to remove themselves', async () => {
    mockResolveDeckAccess.mockResolvedValue({ role: 'owner', reason: 'direct' })
    const app = await buildApp()

    // The caller is `dev-user` (bypass mode). Targeting the same id
    // triggers the self-revoke guard before the last-owner branch.
    const res = await app.inject({
      method: 'DELETE',
      url: '/decks/deck-1/permissions/dev-user',
    })

    expect(res.statusCode).toBe(409)
    const body = JSON.parse(res.body) as { error: string }
    expect(body.error).toContain('cannot remove yourself')
    expect(mockRevokePermission).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Tests — share links
// ---------------------------------------------------------------------------

describe('GET /decks/:id/share-links', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveDeckAccess.mockResolvedValue({ role: 'owner', reason: 'direct' })
  })

  it('returns array of active share links', async () => {
    const now = new Date()
    mockListShareLinks.mockResolvedValue([
      {
        id: 'link-abc',
        role: 'viewer',
        createdAt: now,
        expiresAt: null,
        createdBy: 'dev-user',
        revoked: false,
      },
      {
        id: 'link-old',
        role: 'viewer',
        createdAt: now,
        expiresAt: null,
        createdBy: 'dev-user',
        revoked: true, // revoked — should be filtered out
      },
    ])
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/decks/deck-1/share-links' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { id: string; revoked: boolean }[]
    expect(Array.isArray(body)).toBe(true)
    // Only active (non-revoked) links returned
    expect(body.every((l) => !l.revoked)).toBe(true)
    expect(body).toHaveLength(1)
    expect(body[0]?.id).toBe('link-abc')
  })
})

describe('POST /decks/:id/share-links', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveDeckAccess.mockResolvedValue({ role: 'owner', reason: 'direct' })
    mockCreateShareLink.mockResolvedValue({ id: 'link-new-123', deckId: 'deck-1', role: 'viewer' })
  })

  it('creates a share link and returns {id, url}', async () => {
    const app = await buildApp()

    const res = await app.inject({
      method: 'POST',
      url: '/decks/deck-1/share-links',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'viewer' }),
    })

    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body) as { id: string; url: string }
    expect(body.id).toBe('link-new-123')
    expect(body.url).toContain('share_token=link-new-123')
    expect(body.url).toContain('deck-1')
  })

  it('creates a share link with expiresAt', async () => {
    const app = await buildApp()
    const expiresAt = new Date(Date.now() + 86400_000).toISOString()

    const res = await app.inject({
      method: 'POST',
      url: '/decks/deck-1/share-links',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'editor', expiresAt }),
    })

    expect(res.statusCode).toBe(201)
    expect(mockCreateShareLink).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ role: 'editor', expiresAt: expect.any(Date) }),
    )
  })

  it('returns 400 when role is missing', async () => {
    const app = await buildApp()

    const res = await app.inject({
      method: 'POST',
      url: '/decks/deck-1/share-links',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.statusCode).toBe(400)
  })
})

describe('DELETE /decks/:id/share-links/:linkId', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveDeckAccess.mockResolvedValue({ role: 'owner', reason: 'direct' })
    mockRevokeShareLink.mockResolvedValue(undefined)
  })

  it('revokes share link and returns 204', async () => {
    const app = await buildApp()

    const res = await app.inject({
      method: 'DELETE',
      url: '/decks/deck-1/share-links/link-abc',
    })

    expect(res.statusCode).toBe(204)
    expect(mockRevokeShareLink).toHaveBeenCalledWith(expect.anything(), 'link-abc', 'deck-1')
  })
})

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

describe('non-owner access', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 403 when user has viewer role', async () => {
    mockResolveDeckAccess.mockResolvedValue({ role: 'viewer', reason: 'direct' })
    const app = await buildApp({ role: 'viewer', reason: 'direct' })

    const res = await app.inject({ method: 'GET', url: '/decks/deck-1/permissions' })
    expect(res.statusCode).toBe(403)
  })

  it('returns 403 when user has editor role', async () => {
    mockResolveDeckAccess.mockResolvedValue({ role: 'editor', reason: 'direct' })
    const app = await buildApp({ role: 'editor', reason: 'direct' })

    const res = await app.inject({ method: 'GET', url: '/decks/deck-1/permissions' })
    expect(res.statusCode).toBe(403)
  })
})
