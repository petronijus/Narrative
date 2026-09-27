/**
 * mcp/oauth/store.integration.test.ts — the Drizzle OAuth store against a
 * real Postgres (migrations 0018 + 0021 + 0022): metadata-document clients
 * kept in `client_metadata_url` (no row in mcp_oauth_clients), display
 * snapshots and their fallback to the registered client, the registered
 * scopes / grant types and their snapshots, the refresh fingerprint and the
 * grant flag, the stale-registration sweep with its cascade, the 30-day
 * retention purge, and the account kill switch's bulk revocation (which also
 * expires unexchanged authorizations). The in-memory store (store.ts)
 * mirrors these semantics for the HTTP tests.
 *
 * Excluded from `pnpm test`; run with
 *   node --env-file=../../.env ../../node_modules/vitest/vitest.mjs run \
 *     --config vitest.integration.config.ts src/mcp/oauth/store.integration.test.ts
 *
 * Every row it creates carries a random suffix and dates in 2001, so the
 * sweep it runs (inactive before 2002) can only ever reach its own rows; it
 * deletes what is left afterwards.
 */

import { afterAll, describe, expect, it } from 'vitest'
import { eq, inArray, or, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db, pool } from '../../db/client.js'
import {
  mcpOauthAuthorizations,
  mcpOauthClients,
  mcpOauthGrants,
  mcpOauthTokens,
} from '../../db/schema.js'
import {
  createDrizzleOAuthStore,
  revokeAllMcpGrantsForUser,
  type AuthorizationRecord,
  type ClientRecord,
  type GrantRecord,
} from './store.js'

const suffix = nanoid(8)
const store = createDrizzleOAuthStore(db)
const user = `it-oauth-user-${suffix}`
const cimd = `https://it-${suffix.toLowerCase().replace(/[^a-z0-9]/g, 'x')}.example/client`
const old = new Date('2001-01-01T00:00:00Z')
const id = (name: string) => `it-${name}-${suffix}`

const createdClients: string[] = []
const createdGrants: string[] = []

async function client(name: string, extra: Partial<ClientRecord> = {}): Promise<string> {
  const c: ClientRecord = {
    id: id(name),
    clientName: `Registered ${name}`,
    redirectUris: ['http://127.0.0.1/callback'],
    tokenEndpointAuthMethod: 'none',
    clientSecretHash: null,
    clientUri: null,
    softwareId: null,
    softwareVersion: null,
    scopes: ['mcp', 'offline_access'],
    grantTypes: ['authorization_code', 'refresh_token'],
    createdAt: old,
    lastUsedAt: null,
    ...extra,
  }
  await store.insertClient(c)
  createdClients.push(c.id)
  return c.id
}

async function grant(name: string, clientId: string, extra: Partial<GrantRecord> = {}) {
  const g: GrantRecord = {
    id: id(`grant-${name}`),
    clientId,
    clientName: null,
    redirectUri: null,
    userSub: user,
    scopes: ['mcp', 'offline_access'],
    grantTypes: null,
    resource: 'https://narrative.example/api/mcp',
    createdAt: old,
    lastUsedAt: null,
    revokedAt: null,
    flaggedAt: null,
    flagReason: null,
    ...extra,
  }
  await store.insertGrant(g)
  createdGrants.push(g.id)
  await store.insertToken({
    tokenHash: id(`token-${name}`),
    grantId: g.id,
    kind: 'access',
    createdAt: old,
    expiresAt: new Date('2099-01-01T00:00:00Z'),
    usedAt: null,
    usedByFingerprint: null,
    revokedAt: null,
  })
  return g.id
}

function authorization(name: string, clientId: string, expiresAt: Date): AuthorizationRecord {
  return {
    id: id(`auth-${name}`),
    clientId,
    clientName: 'Snapshot name',
    clientRedirectUris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
    redirectUri: 'http://127.0.0.1:5000/callback',
    redirectUriProvided: true,
    clientGrantTypes: ['authorization_code', 'refresh_token'],
    codeChallenge: 'x'.repeat(43),
    scopes: ['mcp'],
    resource: 'https://narrative.example/api/mcp',
    state: null,
    csrfHash: 'h',
    userSub: null,
    createdAt: old,
    expiresAt,
    decidedAt: null,
    decision: null,
    codeHash: null,
    codeExpiresAt: null,
    exchangedAt: null,
    grantId: null,
  }
}

afterAll(async () => {
  await db
    .delete(mcpOauthGrants)
    .where(or(inArray(mcpOauthGrants.id, createdGrants), eq(mcpOauthGrants.userSub, user)))
  await db
    .delete(mcpOauthAuthorizations)
    .where(sql`${mcpOauthAuthorizations.id} LIKE ${`it-auth-%-${suffix}`}`)
  if (createdClients.length > 0)
    await db.delete(mcpOauthClients).where(inArray(mcpOauthClients.id, createdClients))
  await pool.end()
})

describe('metadata-document clients', () => {
  it('stores their client_id URL apart from registered ids, and reads it back unchanged', async () => {
    const a = authorization('cimd', cimd, new Date('2099-01-01T00:00:00Z'))
    await store.insertAuthorization(a)
    const [row] = await db
      .select({
        clientId: mcpOauthAuthorizations.clientId,
        url: mcpOauthAuthorizations.clientMetadataUrl,
      })
      .from(mcpOauthAuthorizations)
      .where(eq(mcpOauthAuthorizations.id, a.id))
    expect(row).toEqual({ clientId: null, url: cimd })
    expect(await store.getAuthorization(a.id)).toMatchObject({
      clientId: cimd,
      clientName: 'Snapshot name',
      clientRedirectUris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
      redirectUriProvided: true,
      clientGrantTypes: ['authorization_code', 'refresh_token'],
    })
  })

  it('keeps registered scopes and grant types, and reads old rows as null', async () => {
    // Recently used, so the stale-client sweep below leaves them alone.
    const withTypes = await client('typed', {
      scopes: ['mcp'],
      grantTypes: ['authorization_code'],
      lastUsedAt: new Date(),
    })
    expect(await store.getClient(withTypes)).toMatchObject({
      scopes: ['mcp'],
      grantTypes: ['authorization_code'],
    })
    const legacy = await client('legacy-types', {
      scopes: null,
      grantTypes: null,
      lastUsedAt: new Date(),
    })
    expect(await store.getClient(legacy)).toMatchObject({ scopes: null, grantTypes: null })
  })

  it('lists and verifies their grants from the snapshot, and older grants from the registration', async () => {
    const registered = await client('listed')
    await grant('cimd', cimd, {
      clientName: 'Claude Code',
      redirectUri: 'http://127.0.0.1:5000/callback',
    })
    await grant('legacy', registered)
    const connections = await store.listUserGrants(user)
    expect(connections.map((c) => [c.clientName, c.kind, c.redirectUris])).toEqual(
      expect.arrayContaining([
        ['Claude Code', 'metadata_document', ['http://127.0.0.1:5000/callback']],
        ['Registered listed', 'registered', ['http://127.0.0.1/callback']],
      ]),
    )
    expect((await store.findToken(id('token-cimd')))?.client).toEqual({
      id: cimd,
      clientName: 'Claude Code',
    })
    expect((await store.findToken(id('token-legacy')))?.client).toEqual({
      id: registered,
      clientName: 'Registered listed',
    })
  })
})

describe('deleteStaleRegisteredClients', () => {
  it('deletes idle registrations without a live grant or pending request, with their revoked grants', async () => {
    const idle = await client('idle')
    const revokedOnly = await client('revoked-only')
    await grant('revoked', revokedOnly, { revokedAt: old })
    const live = await client('live')
    await grant('live', live)
    const pending = await client('pending')
    await store.insertAuthorization(
      authorization('pending', pending, new Date('2099-01-01T00:00:00Z')),
    )
    const recent = await client('recent', { lastUsedAt: new Date() })

    const deleted = await store.deleteStaleRegisteredClients(
      new Date('2002-01-01T00:00:00Z'),
      new Date(),
    )
    const left = await db
      .select({ id: mcpOauthClients.id })
      .from(mcpOauthClients)
      .where(inArray(mcpOauthClients.id, [idle, revokedOnly, live, pending, recent]))
    expect(left.map((r) => r.id).sort()).toEqual([live, pending, recent].sort())
    // `listed` from the previous test has a live grant too; nothing else is that old.
    expect(deleted).toBe(2)
    // The cascade took the revoked grant and its token.
    expect(
      await db
        .select()
        .from(mcpOauthGrants)
        .where(eq(mcpOauthGrants.id, id('grant-revoked'))),
    ).toEqual([])
    expect(
      await db
        .select()
        .from(mcpOauthTokens)
        .where(eq(mcpOauthTokens.tokenHash, id('token-revoked'))),
    ).toEqual([])
  })
})

describe('refresh fingerprints and flags', () => {
  it('records the rotating fingerprint once, and flags a grant keeping the first time', async () => {
    const registered = await client('fingerprint')
    const g = await grant('fingerprint', registered, { grantTypes: ['authorization_code'] })
    await store.insertToken({
      tokenHash: id('refresh-fingerprint'),
      grantId: g,
      kind: 'refresh',
      createdAt: old,
      expiresAt: new Date('2099-01-01T00:00:00Z'),
      usedAt: null,
      usedByFingerprint: null,
      revokedAt: null,
    })
    expect(await store.useRefreshToken(id('refresh-fingerprint'), new Date(), 'fp-1')).toBe(true)
    expect(await store.useRefreshToken(id('refresh-fingerprint'), new Date(), 'fp-2')).toBe(false)
    expect((await store.findToken(id('refresh-fingerprint')))?.token.usedByFingerprint).toBe('fp-1')

    const first = new Date('2001-06-01T00:00:00Z')
    await store.flagGrant(g, 'replayed', first)
    await store.flagGrant(g, 'replayed again', new Date())
    const owner = await store.getGrantOwner(g)
    expect(owner?.grant).toMatchObject({
      flaggedAt: first,
      flagReason: 'replayed again',
      grantTypes: ['authorization_code'],
    })
    expect(await store.getGrantOwner(id('grant-nope'))).toBeNull()
  })
})

describe('purgeRetained', () => {
  it('deletes decided or exchanged authorizations and revoked grants older than the cutoff, and nothing pending', async () => {
    const retained = await client('retained')
    const revokedGrant = await grant('purged', retained, { revokedAt: old })
    const liveGrant = await grant('kept', retained)
    const decided = {
      ...authorization('decided', retained, old),
      decidedAt: old,
      decision: 'denied' as const,
    }
    const pendingOld = authorization('pending-old', retained, new Date('2099-01-01T00:00:00Z'))
    await store.insertAuthorization(decided)
    await store.insertAuthorization(pendingOld)

    const purged = await store.purgeRetained(new Date('2002-01-01T00:00:00Z'))
    expect(purged.grants).toBeGreaterThanOrEqual(1)
    expect(purged.authorizations).toBeGreaterThanOrEqual(1)
    expect(await store.getAuthorization(decided.id)).toBeNull()
    expect(await store.getAuthorization(pendingOld.id)).not.toBeNull()
    expect(await store.getGrantOwner(revokedGrant)).toBeNull()
    expect(await store.findToken(id('token-purged'))).toBeNull()
    expect(await store.getGrantOwner(liveGrant)).not.toBeNull()
  })
})

describe('revokeAllMcpGrantsForUser', () => {
  it('revokes every live grant of the user, of both client kinds, with their tokens', async () => {
    const revoked = await revokeAllMcpGrantsForUser(db, user)
    expect(revoked).toBeGreaterThanOrEqual(3)
    expect(await store.listUserGrants(user)).toEqual([])
    for (const token of ['token-cimd', 'token-legacy', 'token-live'])
      expect((await store.findToken(id(token)))?.token.revokedAt).not.toBeNull()
  })

  it('expires the user’s undecided requests and approved, unexchanged codes', async () => {
    const future = new Date('2099-01-01T00:00:00Z')
    const killed = await client('killed')
    const undecided = { ...authorization('undecided', killed, future), userSub: user }
    const approved = {
      ...authorization('approved', killed, future),
      userSub: user,
      decidedAt: new Date(),
      decision: 'approved' as const,
      codeHash: id('code-approved'),
      codeExpiresAt: future,
    }
    const someoneElse = { ...authorization('other', killed, future), userSub: `${user}-other` }
    for (const a of [undecided, approved, someoneElse]) await store.insertAuthorization(a)
    const at = new Date()
    await revokeAllMcpGrantsForUser(db, user, at)
    expect((await store.getAuthorization(undecided.id))?.expiresAt).toEqual(at)
    expect(await store.getAuthorization(approved.id)).toMatchObject({
      expiresAt: at,
      codeExpiresAt: at,
    })
    expect((await store.getAuthorization(someoneElse.id))?.expiresAt).toEqual(future)
    // Nobody can bind or decide them any more.
    expect(await store.bindAuthorizationUser(undecided.id, user, 'h2', new Date())).toBe(false)
  })
})
