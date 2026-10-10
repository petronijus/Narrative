/**
 * hocuspocus/auth.folder.test.ts
 *
 * The real `onAuthenticate` hook (hocuspocus/authenticate.ts) on a
 * `folder:<id>` document — the folder's token document — under folder
 * sharing (docs/plans/folder-sharing.md): its members connect with their
 * folder role, a guest of one of its decks (a deck grant or a share link to
 * one of them) connects so a shared deck renders with its folder's tokens.
 * Every connection is read-only, the owner's included: tokens change only
 * through the server (services/tokens.ts), which writes over its own direct
 * connection. resolveFolderContentAccess and the session lookup are mocked;
 * the hook itself runs unchanged.
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
        ? { userSub: 'member', userEmail: 'm@example.com', userName: null }
        : null,
    ),
  }
})

import {
  resolveComponentAccess,
  resolveDeckAccess,
  resolveFolderContentAccess,
} from '../auth/permissions.js'
import { createOnAuthenticate, type WsAuthPayload } from './authenticate.js'
import type { Database } from '../db/client.js'

const folderAccess = vi.mocked(resolveFolderContentAccess)
const deckAccess = vi.mocked(resolveDeckAccess)
const componentAccess = vi.mocked(resolveComponentAccess)

const DB = {} as Database
const COOKIE = { cookie: 'narrative_session=good-session' }

function payload(over: Partial<WsAuthPayload> & { params?: Record<string, string> } = {}) {
  const { params, ...rest } = over
  return {
    documentName: 'folder:folder-1',
    token: 'cookie',
    requestParameters: new URLSearchParams(params ?? {}),
    requestHeaders: COOKIE,
    connection: { readOnly: false },
    context: {} as Record<string, unknown>,
    ...rest,
  } satisfies WsAuthPayload
}

const authenticate = (bypass = false) => createOnAuthenticate({ db: DB, bypass })

beforeEach(() => {
  vi.clearAllMocks()
})

describe('onAuthenticate — folder:<id>', () => {
  it('connects a folder editor read-only, with their role in the context', async () => {
    folderAccess.mockResolvedValueOnce({ role: 'editor', via: 'folder' })
    const data = payload()
    await authenticate()(data)

    expect(folderAccess).toHaveBeenCalledWith(DB, {
      folderId: 'folder-1',
      userId: 'member',
      shareToken: null,
    })
    expect(data.context).toMatchObject({ userId: 'member', folderId: 'folder-1', role: 'editor' })
    expect(data.context).not.toHaveProperty('shareToken')
    expect(data.connection.readOnly).toBe(true)
    expect(deckAccess).not.toHaveBeenCalled()
    expect(componentAccess).not.toHaveBeenCalled()
  })

  it('connects a folder owner read-only: the server writes the token document', async () => {
    folderAccess.mockResolvedValueOnce({ role: 'owner', via: 'folder' })
    const data = payload()
    await authenticate()(data)
    expect(data.context).toMatchObject({ role: 'owner' })
    expect(data.connection.readOnly).toBe(true)
  })

  it('connects a folder viewer read-only', async () => {
    folderAccess.mockResolvedValueOnce({ role: 'viewer', via: 'folder' })
    const data = payload()
    await authenticate()(data)
    expect(data.context).toMatchObject({ role: 'viewer' })
    expect(data.connection.readOnly).toBe(true)
  })

  it('connects a guest of one of its decks read-only, so the deck renders with its tokens', async () => {
    folderAccess.mockResolvedValueOnce({ role: 'viewer', via: 'deck' })
    const data = payload()
    await authenticate()(data)
    expect(data.context).toMatchObject({ userId: 'member', folderId: 'folder-1', role: 'viewer' })
    expect(data.connection.readOnly).toBe(true)
  })

  it('connects a share link to one of its decks read-only, carrying the token for revocation', async () => {
    folderAccess.mockResolvedValueOnce({ role: 'viewer', via: 'deck' })
    const data = payload({ requestHeaders: {}, params: { share_token: 'tok-abcdefgh-rest' } })
    await authenticate()(data)

    expect(folderAccess).toHaveBeenCalledWith(DB, {
      folderId: 'folder-1',
      userId: null,
      shareToken: 'tok-abcdefgh-rest',
    })
    expect(data.context).toMatchObject({
      userId: expect.stringMatching(/^share:[0-9a-f]{8}$/),
      folderId: 'folder-1',
      role: 'viewer',
      shareToken: 'tok-abcdefgh-rest',
    })
    expect(data.connection.readOnly).toBe(true)
  })

  it('refuses a user with no access to the folder or any of its decks', async () => {
    folderAccess.mockResolvedValueOnce(null)
    const data = payload()
    await expect(authenticate()(data)).rejects.toThrow('Forbidden')
    expect(data.context).toEqual({})
  })

  it('refuses a share link that leads to no deck of this folder', async () => {
    folderAccess.mockResolvedValueOnce(null)
    await expect(
      authenticate()(payload({ requestHeaders: {}, params: { share_token: 'elsewhere' } })),
    ).rejects.toThrow('Forbidden')
  })

  it('refuses a connection without credentials before any lookup', async () => {
    await expect(authenticate()(payload({ requestHeaders: {} }))).rejects.toThrow(
      'Invalid credentials',
    )
    expect(folderAccess).not.toHaveBeenCalled()
  })

  it('resolves BYPASS_AUTH as dev-user', async () => {
    folderAccess.mockResolvedValueOnce({ role: 'owner', via: 'folder' })
    const data = payload({ requestHeaders: {} })
    await authenticate(true)(data)
    expect(folderAccess).toHaveBeenCalledWith(DB, {
      folderId: 'folder-1',
      userId: 'dev-user',
      shareToken: null,
    })
    expect(data.context).toMatchObject({ userId: 'dev-user' })
  })

  it('leaves deck:<id> documents to resolveDeckAccess', async () => {
    deckAccess.mockResolvedValueOnce({ role: 'owner', reason: 'direct' })
    const data = payload({ documentName: 'deck:deck-1' })
    await authenticate()(data)
    expect(data.context).toMatchObject({ deckIdResolved: 'deck-1' })
    expect(folderAccess).not.toHaveBeenCalled()
  })
})
