/**
 * hocuspocus/auth.component.test.ts
 *
 * The real `onAuthenticate` hook (hocuspocus/authenticate.ts) on a
 * `component:<id>` document — a component master — under folder sharing
 * (docs/plans/folder-sharing.md): the folder's members connect with their
 * folder role, read-only for a viewer; a deck-only guest and a share link
 * never reach a master. resolveComponentAccess and the session lookup are
 * mocked; the hook itself runs unchanged.
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

const componentAccess = vi.mocked(resolveComponentAccess)
const folderAccess = vi.mocked(resolveFolderContentAccess)
const deckAccess = vi.mocked(resolveDeckAccess)

const DB = {} as Database
const COOKIE = { cookie: 'narrative_session=good-session' }

function payload(over: Partial<WsAuthPayload> & { params?: Record<string, string> } = {}) {
  const { params, ...rest } = over
  return {
    documentName: 'component:comp-1',
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

describe('onAuthenticate — component:<id>', () => {
  it('connects a folder editor to the master read-write', async () => {
    componentAccess.mockResolvedValueOnce({ role: 'editor', reason: 'folder' })
    const data = payload()
    await authenticate()(data)

    expect(componentAccess).toHaveBeenCalledWith(DB, { componentId: 'comp-1', userId: 'member' })
    expect(data.context).toMatchObject({ userId: 'member', componentId: 'comp-1', role: 'editor' })
    expect(data.connection.readOnly).toBe(false)
    expect(folderAccess).not.toHaveBeenCalled()
    expect(deckAccess).not.toHaveBeenCalled()
  })

  it('connects a folder owner to the master read-write', async () => {
    componentAccess.mockResolvedValueOnce({ role: 'owner', reason: 'folder' })
    const data = payload()
    await authenticate()(data)
    expect(data.connection.readOnly).toBe(false)
  })

  it('connects a folder viewer to the master read-only', async () => {
    componentAccess.mockResolvedValueOnce({ role: 'viewer', reason: 'folder' })
    const data = payload()
    await authenticate()(data)
    expect(data.context).toMatchObject({ role: 'viewer' })
    expect(data.connection.readOnly).toBe(true)
  })

  it('refuses a user outside the folder, a deck-only guest included, and a missing component', async () => {
    componentAccess.mockResolvedValueOnce(null)
    await expect(authenticate()(payload())).rejects.toThrow('Forbidden')
  })

  it('refuses a share link without looking the component up', async () => {
    await expect(
      authenticate()(payload({ requestHeaders: {}, params: { share_token: 'tok-abc' } })),
    ).rejects.toThrow('Forbidden')
    expect(componentAccess).not.toHaveBeenCalled()
  })

  it('refuses a connection without credentials', async () => {
    await expect(authenticate()(payload({ requestHeaders: {} }))).rejects.toThrow(
      'Invalid credentials',
    )
    expect(componentAccess).not.toHaveBeenCalled()
  })

  it('resolves BYPASS_AUTH as dev-user', async () => {
    componentAccess.mockResolvedValueOnce({ role: 'owner', reason: 'folder' })
    const data = payload({ requestHeaders: {} })
    await authenticate(true)(data)
    expect(componentAccess).toHaveBeenCalledWith(DB, { componentId: 'comp-1', userId: 'dev-user' })
    expect(data.context).toMatchObject({ userId: 'dev-user', componentId: 'comp-1' })
  })

  it('leaves folder:<id> documents to resolveFolderContentAccess', async () => {
    folderAccess.mockResolvedValueOnce({ role: 'owner', via: 'folder' })
    const data = payload({ documentName: 'folder:folder-1' })
    await authenticate()(data)
    expect(data.context).toMatchObject({ folderId: 'folder-1' })
    expect(componentAccess).not.toHaveBeenCalled()
  })
})
