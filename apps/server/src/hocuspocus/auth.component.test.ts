/**
 * hocuspocus/auth.component.test.ts
 *
 * The real `onAuthenticate` hook (hocuspocus/authenticate.ts) on a
 * `component:<id>` document — a component master — under folder sharing
 * (docs/plans/folder-sharing.md): the folder's members connect with their
 * folder role, read-only for a viewer; a deck-only guest and a share link
 * never reach a master; the render page of the master's card does, with a
 * render token, read-only (agentic A3.5). resolveComponentAccess and the session lookup are
 * mocked; the hook itself runs unchanged.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// The document epoch (ADR 0017) is read after the access check: every
// document is at epoch 1 here.
vi.mock('./documentEpoch.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./documentEpoch.js')>()
  return {
    ...original,
    readDocumentEpoch: vi.fn(async () => ({ docEpoch: 1, generation: 100, floor: 50 })),
  }
})

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

function payload(
  over: Omit<Partial<WsAuthPayload>, 'requestHeaders'> & {
    params?: Record<string, string>
    requestHeaders?: Record<string, string>
  } = {},
) {
  const { params, requestHeaders, ...rest } = over
  return {
    documentName: 'component:comp-1',
    token: 'cookie',
    requestParameters: new URLSearchParams(params ?? {}),
    requestHeaders: new Headers(requestHeaders ?? COOKIE),
    connectionConfig: { readOnly: false },
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

    expect(componentAccess).toHaveBeenCalledWith(DB, {
      componentId: 'comp-1',
      userId: 'member',
      shareToken: null,
    })
    expect(data.context).toMatchObject({ userId: 'member', componentId: 'comp-1', role: 'editor' })
    expect(data.connectionConfig.readOnly).toBe(false)
    expect(folderAccess).not.toHaveBeenCalled()
    expect(deckAccess).not.toHaveBeenCalled()
  })

  it('connects a folder owner to the master read-write', async () => {
    componentAccess.mockResolvedValueOnce({ role: 'owner', reason: 'folder' })
    const data = payload()
    await authenticate()(data)
    expect(data.connectionConfig.readOnly).toBe(false)
  })

  it('connects a folder viewer to the master read-only', async () => {
    componentAccess.mockResolvedValueOnce({ role: 'viewer', reason: 'folder' })
    const data = payload()
    await authenticate()(data)
    expect(data.context).toMatchObject({ role: 'viewer' })
    expect(data.connectionConfig.readOnly).toBe(true)
  })

  it('refuses a user outside the folder, a deck-only guest included, and a missing component', async () => {
    componentAccess.mockResolvedValueOnce(null)
    await expect(authenticate()(payload())).rejects.toThrow('Forbidden')
  })

  it('refuses a share link (resolveComponentAccess admits none)', async () => {
    componentAccess.mockResolvedValueOnce(null)
    await expect(
      authenticate()(payload({ requestHeaders: {}, params: { share_token: 'tok-abc' } })),
    ).rejects.toThrow('Forbidden')
    expect(componentAccess).toHaveBeenCalledWith(DB, {
      componentId: 'comp-1',
      userId: null,
      shareToken: 'tok-abc',
    })
  })

  it('connects the render page of the master’s card read-only, ending with its token', async () => {
    componentAccess.mockResolvedValueOnce({ role: 'viewer', reason: 'render' })
    const token = `nrr_${'r'.repeat(43)}`
    const data = payload({ requestHeaders: {}, params: { share_token: token } })
    await authenticate()(data)
    expect(data.connectionConfig.readOnly).toBe(true)
    expect(data.context).toMatchObject({ componentId: 'comp-1', role: 'viewer', shareToken: token })
    expect(data.context['userId']).not.toContain(token)
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
    expect(componentAccess).toHaveBeenCalledWith(DB, {
      componentId: 'comp-1',
      userId: 'dev-user',
      shareToken: null,
    })
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
