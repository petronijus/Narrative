/**
 * hocuspocus/authenticate.test.ts
 *
 * The real `onAuthenticate` hook (hocuspocus/authenticate.ts):
 *   - a personal access token is refused on the WebSocket, whether it comes
 *     as the auth-frame token or as an `Authorization` header, and even next
 *     to a valid cookie, a share token or BYPASS_AUTH (ADR 0011: agents write
 *     only through the server host);
 *   - the browser paths keep working: session cookie, share link, BYPASS_AUTH,
 *     folder and component docs;
 *   - failed attempts are throttled per client IP before any lookup.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../auth/permissions.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../auth/permissions.js')>()
  return {
    ...original,
    resolveDeckAccess: vi.fn(),
    resolveFolderContentAccess: vi.fn(),
    resolveComponentAccess: vi.fn(),
  }
})

vi.mock('../auth/session.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../auth/session.js')>()
  return {
    ...original,
    lookupSession: vi.fn(async (_db: unknown, raw: string) =>
      raw === 'good-session'
        ? { userSub: 'cookie-user', userEmail: 'c@example.com', userName: null }
        : null,
    ),
  }
})

import {
  resolveDeckAccess,
  resolveFolderContentAccess,
  resolveComponentAccess,
} from '../auth/permissions.js'
import { lookupSession } from '../auth/session.js'
import {
  createOnAuthenticate,
  WS_FAILED_AUTH_LIMIT,
  WS_TOO_MANY_ATTEMPTS,
  type WsAuthDeps,
  type WsAuthPayload,
} from './authenticate.js'
import { createFixedWindowLimiter } from '../http/fixedWindowLimiter.js'
import type { Database } from '../db/client.js'

const deckAccess = vi.mocked(resolveDeckAccess)
const folderAccess = vi.mocked(resolveFolderContentAccess)
const componentAccess = vi.mocked(resolveComponentAccess)
const sessions = vi.mocked(lookupSession)

/** A syntactically valid PAT (it is never verified — the WS does not look it up). */
const PAT = `nrt_${'k'.repeat(43)}`
const COOKIE = { cookie: 'narrative_session=good-session' }

function payload(
  over: Partial<WsAuthPayload> & { params?: Record<string, string>; ip?: string } = {},
): WsAuthPayload {
  const { params, ip, ...rest } = over
  return {
    documentName: 'deck:d1',
    token: 'cookie',
    requestParameters: new URLSearchParams(params ?? {}),
    requestHeaders: {},
    request: { socket: { remoteAddress: ip ?? '203.0.113.7' } },
    connection: { readOnly: true },
    context: {},
    ...rest,
  }
}

function onAuthenticate(over: Partial<WsAuthDeps> = {}) {
  return createOnAuthenticate({ db: {} as Database, bypass: false, ...over })
}

beforeEach(() => {
  vi.clearAllMocks()
  deckAccess.mockResolvedValue({ role: 'editor', reason: 'direct' })
  folderAccess.mockResolvedValue({ role: 'owner', via: 'folder' })
  componentAccess.mockResolvedValue({ role: 'owner', reason: 'folder' })
})

describe('personal access tokens are refused on the WebSocket', () => {
  it('refuses a PAT sent as the auth-frame token, even with a valid cookie', async () => {
    await expect(onAuthenticate()(payload({ token: PAT, requestHeaders: COOKIE }))).rejects.toThrow(
      'Forbidden',
    )
    expect(sessions).not.toHaveBeenCalled()
    expect(deckAccess).not.toHaveBeenCalled()
  })

  it('refuses a PAT sent as an Authorization header on the upgrade', async () => {
    await expect(
      onAuthenticate()(payload({ requestHeaders: { ...COOKIE, authorization: `Bearer ${PAT}` } })),
    ).rejects.toThrow('Forbidden')
    expect(deckAccess).not.toHaveBeenCalled()
  })

  it('refuses a PAT next to a share token, under BYPASS_AUTH, and for every doc kind', async () => {
    await expect(
      onAuthenticate()(payload({ token: PAT, params: { share_token: 'link-123' } })),
    ).rejects.toThrow('Forbidden')
    await expect(onAuthenticate({ bypass: true })(payload({ token: PAT }))).rejects.toThrow(
      'Forbidden',
    )
    for (const documentName of ['folder:f1', 'component:c1']) {
      await expect(
        onAuthenticate()(payload({ token: PAT, documentName, requestHeaders: COOKIE })),
      ).rejects.toThrow('Forbidden')
    }
    expect(deckAccess).not.toHaveBeenCalled()
    expect(folderAccess).not.toHaveBeenCalled()
    expect(componentAccess).not.toHaveBeenCalled()
  })

  it('refuses every other agent credential the same way (MCP OAuth, upload session)', async () => {
    for (const prefix of ['nmo', 'nmr', 'nmc', 'nms', 'nus']) {
      const credential = `${prefix}_${'k'.repeat(43)}`
      await expect(
        onAuthenticate()(payload({ token: credential, requestHeaders: COOKIE })),
        prefix,
      ).rejects.toThrow('Forbidden')
      await expect(
        onAuthenticate()(
          payload({ requestHeaders: { ...COOKIE, authorization: `Bearer ${credential}` } }),
        ),
        prefix,
      ).rejects.toThrow('Forbidden')
    }
    expect(deckAccess).not.toHaveBeenCalled()
  })

  it('ignores a non-PAT bearer value (the /metrics token) and uses the cookie', async () => {
    const data = payload({ requestHeaders: { ...COOKIE, authorization: 'Bearer metrics-secret' } })
    await onAuthenticate()(data)
    expect(data.context.userId).toBe('cookie-user')
  })
})

describe('browser paths', () => {
  it('uses the session cookie; the sentinel token is ignored', async () => {
    const data = payload({ requestHeaders: COOKIE })
    const additions = await onAuthenticate()(data)
    expect(additions).toEqual({
      userId: 'cookie-user',
      deckId: 'deck:d1',
      deckIdResolved: 'd1',
      role: 'editor',
    })
    expect(data.connection.readOnly).toBe(false)
  })

  it('makes a viewer connection read-only', async () => {
    deckAccess.mockResolvedValue({ role: 'viewer', reason: 'direct' })
    const data = payload({ requestHeaders: COOKIE, connection: { readOnly: false } })
    await onAuthenticate()(data)
    expect(data.connection.readOnly).toBe(true)
  })

  it('refuses a connection with no cookie, or an unknown one', async () => {
    await expect(onAuthenticate()(payload())).rejects.toThrow('Invalid credentials')
    await expect(
      onAuthenticate()(payload({ requestHeaders: { cookie: 'narrative_session=stale' } })),
    ).rejects.toThrow('Invalid credentials')
  })

  it('refuses when the user has no access to the deck', async () => {
    deckAccess.mockResolvedValue(null)
    await expect(onAuthenticate()(payload({ requestHeaders: COOKIE }))).rejects.toThrow('Forbidden')
  })

  it('keeps share-link access for decks', async () => {
    deckAccess.mockResolvedValue({ role: 'viewer', reason: 'share-link' })
    const data = payload({ params: { share_token: 'link-123' } })
    await onAuthenticate()(data)
    // Named by a hash prefix, never by characters of the token itself.
    expect(data.context).toMatchObject({
      userId: expect.stringMatching(/^share:[0-9a-f]{8}$/),
      shareToken: 'link-123',
    })
    expect(data.context.userId).not.toContain('link')
    expect(data.connection.readOnly).toBe(true)
  })

  it("admits a share link read-only to its deck's folder document, never to a component", async () => {
    folderAccess.mockResolvedValue({ role: 'viewer', via: 'deck' })
    const folder = payload({ documentName: 'folder:f1', params: { share_token: 'link-123' } })
    await onAuthenticate()(folder)
    expect(folderAccess).toHaveBeenCalledWith(expect.anything(), {
      folderId: 'f1',
      userId: null,
      shareToken: 'link-123',
    })
    expect(folder.context).toMatchObject({
      userId: expect.stringMatching(/^share:[0-9a-f]{8}$/),
      shareToken: 'link-123',
    })
    expect(folder.connection.readOnly).toBe(true)

    // A component admits no share link (resolveComponentAccess: only a
    // render token minted for that master — permissions.integration.test.ts).
    componentAccess.mockResolvedValueOnce(null)
    await expect(
      onAuthenticate()(
        payload({ documentName: 'component:c1', params: { share_token: 'link-123' } }),
      ),
    ).rejects.toThrow('Forbidden')
    expect(componentAccess).toHaveBeenCalledWith(expect.anything(), {
      componentId: 'c1',
      userId: null,
      shareToken: 'link-123',
    })
  })

  it('resolves folder and component docs for the cookie user', async () => {
    const folder = payload({ documentName: 'folder:f1', requestHeaders: COOKIE })
    await onAuthenticate()(folder)
    expect(folderAccess).toHaveBeenCalledWith(expect.anything(), {
      folderId: 'f1',
      userId: 'cookie-user',
      shareToken: null,
    })
    expect(folder.context).toMatchObject({ userId: 'cookie-user', folderId: 'f1', role: 'owner' })

    const component = payload({ documentName: 'component:c1', requestHeaders: COOKIE })
    await onAuthenticate()(component)
    expect(component.context).toMatchObject({ userId: 'cookie-user', componentId: 'c1' })
  })

  it('keeps BYPASS_AUTH: dev-user', async () => {
    const data = payload()
    await onAuthenticate({ bypass: true })(data)
    expect(data.context.userId).toBe('dev-user')
  })
})

describe('failed-attempt throttle', () => {
  it(`refuses an IP after ${WS_FAILED_AUTH_LIMIT.max} failures, before any lookup`, async () => {
    const hook = onAuthenticate()
    for (let i = 0; i < WS_FAILED_AUTH_LIMIT.max; i++) {
      await expect(hook(payload({ ip: '198.51.100.1' }))).rejects.toThrow('Invalid credentials')
    }
    sessions.mockClear()
    // Even a valid cookie from that address is now refused without a lookup…
    await expect(hook(payload({ ip: '198.51.100.1', requestHeaders: COOKIE }))).rejects.toThrow(
      WS_TOO_MANY_ATTEMPTS,
    )
    expect(sessions).not.toHaveBeenCalled()
    // …while another address is unaffected.
    const other = payload({ ip: '198.51.100.2', requestHeaders: COOKIE })
    await hook(other)
    expect(other.context.userId).toBe('cookie-user')
  })

  it('counts forbidden share-token guesses, and successes do not reset the count', async () => {
    let t = 0
    const limiter = createFixedWindowLimiter({ max: 3, windowMs: 1000, now: () => t })
    const hook = onAuthenticate({ failedAuthLimiter: limiter })
    deckAccess.mockResolvedValue(null)
    await expect(hook(payload({ params: { share_token: 'guess-1' } }))).rejects.toThrow('Forbidden')
    await expect(hook(payload({ params: { share_token: 'guess-2' } }))).rejects.toThrow('Forbidden')
    deckAccess.mockResolvedValue({ role: 'editor', reason: 'direct' })
    await hook(payload({ requestHeaders: COOKIE }))
    deckAccess.mockResolvedValue(null)
    await expect(hook(payload({ params: { share_token: 'guess-3' } }))).rejects.toThrow('Forbidden')
    await expect(hook(payload({ requestHeaders: COOKIE }))).rejects.toThrow(WS_TOO_MANY_ATTEMPTS)

    // The window resets.
    t = 1000
    deckAccess.mockResolvedValue({ role: 'editor', reason: 'direct' })
    await hook(payload({ requestHeaders: COOKIE }))
  })

  it("does not count a render token's refusals: they must not lock the render worker out", async () => {
    // The worker's every page comes from one address; a page holding a token
    // that just expired is refused, and must not throttle the next renders.
    const limiter = createFixedWindowLimiter({ max: 2, windowMs: 60_000 })
    const hook = onAuthenticate({ failedAuthLimiter: limiter })
    deckAccess.mockResolvedValue(null)
    const expired = `nrr_${'e'.repeat(43)}`
    for (let i = 0; i < 5; i++) {
      await expect(hook(payload({ params: { share_token: expired } }))).rejects.toThrow('Forbidden')
    }
    deckAccess.mockResolvedValue({ role: 'viewer', reason: 'share-link' })
    const fresh = payload({ params: { share_token: `nrr_${'f'.repeat(43)}` } })
    await hook(fresh)
    expect(fresh.connection.readOnly).toBe(true)
    // Something shaped otherwise still counts.
    deckAccess.mockResolvedValue(null)
    await expect(hook(payload({ params: { share_token: 'nrr_short' } }))).rejects.toThrow(
      'Forbidden',
    )
    await expect(hook(payload({ params: { share_token: 'nrr_short2' } }))).rejects.toThrow(
      'Forbidden',
    )
    await expect(hook(payload({ requestHeaders: COOKIE }))).rejects.toThrow(WS_TOO_MANY_ATTEMPTS)
  })

  it('keys on the configured client-IP header when present', async () => {
    const limiter = createFixedWindowLimiter({ max: 1, windowMs: 60_000 })
    const hook = onAuthenticate({ failedAuthLimiter: limiter, clientIpHeader: 'cf-connecting-ip' })
    await expect(
      hook(payload({ ip: '10.0.0.5', requestHeaders: { 'cf-connecting-ip': '192.0.2.44' } })),
    ).rejects.toThrow('Invalid credentials')
    // Same proxy peer, different client → not throttled.
    await expect(
      hook(payload({ ip: '10.0.0.5', requestHeaders: { 'cf-connecting-ip': '192.0.2.45' } })),
    ).rejects.toThrow('Invalid credentials')
    // Same client again → throttled.
    await expect(
      hook(payload({ ip: '10.0.0.5', requestHeaders: { 'cf-connecting-ip': '192.0.2.44' } })),
    ).rejects.toThrow(WS_TOO_MANY_ATTEMPTS)
  })
})
