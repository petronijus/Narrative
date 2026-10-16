/**
 * hocuspocus/connections.test.ts
 *
 * CONN-1 — unit tests for the connection-teardown helpers. We don't spin up a
 * real WebSocket server; instead we build a fake Hocuspocus instance whose
 * `documents` map mirrors the real `Map<string, Document>` shape and whose
 * connections expose `context` + a spy `close()`. We then assert that each
 * helper closes EXACTLY the right connections (and no innocent ones).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  closeDeckConnections,
  closeUserConnections,
  closeConnectionsForDocument,
  closeShareTokenConnections,
  closeUserConnectionsOnDocument,
  closeUserFolderConnections,
  hasSignedInEditor,
} from './connections.js'
import { setHocuspocusInstance } from './presence.js'

interface FakeConn {
  context: Record<string, unknown>
  close: ReturnType<typeof vi.fn>
  webSocket: { close: ReturnType<typeof vi.fn> }
}

function conn(context: Record<string, unknown>): FakeConn {
  return { context, close: vi.fn(), webSocket: { close: vi.fn() } }
}

/** Build a fake Hocuspocus whose documents map yields the given connections. */
function fakeServer(docs: Record<string, FakeConn[]>) {
  const documents = new Map<string, { getConnections: () => FakeConn[] }>()
  for (const [name, conns] of Object.entries(docs)) {
    documents.set(name, { getConnections: () => conns })
  }
  return { documents } as never
}

describe('CONN-1 connection teardown helpers', () => {
  beforeEach(() => {
    setHocuspocusInstance(null as never)
  })

  it('is a no-op (returns 0) when no Hocuspocus instance is wired', () => {
    expect(closeDeckConnections('deck-1', { userId: 'u1' })).toBe(0)
    expect(closeUserConnections('u1')).toBe(0)
    expect(closeConnectionsForDocument('deck:deck-1')).toBe(0)
  })

  it('closeDeckConnections({ userId }) closes only that user on that deck', () => {
    const target = conn({ userId: 'u1', deckIdResolved: 'deck-1' })
    const other = conn({ userId: 'u2', deckIdResolved: 'deck-1' })
    const elsewhere = conn({ userId: 'u1', deckIdResolved: 'deck-2' })
    setHocuspocusInstance(
      fakeServer({
        'deck:deck-1': [target, other],
        'deck:deck-2': [elsewhere],
      }),
    )

    const closed = closeDeckConnections('deck-1', { userId: 'u1' })

    expect(closed).toBe(1)
    expect(target.close).toHaveBeenCalledOnce()
    expect(other.close).not.toHaveBeenCalled()
    expect(elsewhere.close).not.toHaveBeenCalled()
  })

  it('closeDeckConnections({ shareToken }) targets the exact token, not the user', () => {
    const shareConn = conn({
      userId: 'share:abcd1234',
      shareToken: 'full-token-xyz',
      deckIdResolved: 'd1',
    })
    const otherShare = conn({
      userId: 'share:zzzz0000',
      shareToken: 'other-token',
      deckIdResolved: 'd1',
    })
    const authed = conn({ userId: 'u1', deckIdResolved: 'd1' })
    setHocuspocusInstance(fakeServer({ 'deck:d1': [shareConn, otherShare, authed] }))

    const closed = closeDeckConnections('d1', { shareToken: 'full-token-xyz' })

    expect(closed).toBe(1)
    expect(shareConn.close).toHaveBeenCalledOnce()
    expect(otherShare.close).not.toHaveBeenCalled()
    expect(authed.close).not.toHaveBeenCalled()
  })

  it('closeDeckConnections() with no selector closes every connection on the deck', () => {
    const a = conn({ userId: 'u1', deckIdResolved: 'd1' })
    const b = conn({ userId: 'u2', deckIdResolved: 'd1' })
    const elsewhere = conn({ userId: 'u3', deckIdResolved: 'd2' })
    setHocuspocusInstance(fakeServer({ 'deck:d1': [a, b], 'deck:d2': [elsewhere] }))

    const closed = closeDeckConnections('d1')

    expect(closed).toBe(2)
    expect(a.close).toHaveBeenCalledOnce()
    expect(b.close).toHaveBeenCalledOnce()
    expect(elsewhere.close).not.toHaveBeenCalled()
  })

  it('matches legacy bare deck doc names (no deck: prefix)', () => {
    const legacy = conn({ userId: 'u1' })
    setHocuspocusInstance(fakeServer({ 'legacy-deck-id': [legacy] }))

    expect(closeDeckConnections('legacy-deck-id', { userId: 'u1' })).toBe(1)
    expect(legacy.close).toHaveBeenCalledOnce()
  })

  it('closeDeckConnections never matches folder/component docs', () => {
    const folderConn = conn({ userId: 'u1' })
    setHocuspocusInstance(fakeServer({ 'folder:u1': [folderConn] }))

    // deckId 'u1' must not match a folder doc named folder:u1.
    expect(closeDeckConnections('u1', { userId: 'u1' })).toBe(0)
    expect(folderConn.close).not.toHaveBeenCalled()
  })

  it('closeUserConnections closes the user across ALL docs (deck/folder/component)', () => {
    const onDeck = conn({ userId: 'u1', deckIdResolved: 'd1' })
    const onFolder = conn({ userId: 'u1', folderId: 'f1' })
    const onComponent = conn({ userId: 'u1', componentId: 'c1' })
    const otherUser = conn({ userId: 'u2', deckIdResolved: 'd1' })
    const shareViewer = conn({ userId: 'share:abcd1234', shareToken: 't' })
    setHocuspocusInstance(
      fakeServer({
        'deck:d1': [onDeck, otherUser],
        'folder:f1': [onFolder],
        'component:c1': [onComponent],
        'deck:d2': [shareViewer],
      }),
    )

    const closed = closeUserConnections('u1')

    expect(closed).toBe(3)
    expect(onDeck.close).toHaveBeenCalledOnce()
    expect(onFolder.close).toHaveBeenCalledOnce()
    expect(onComponent.close).toHaveBeenCalledOnce()
    // A revoked user's sessions must NOT kick anonymous share-link viewers.
    expect(shareViewer.close).not.toHaveBeenCalled()
    expect(otherUser.close).not.toHaveBeenCalled()
  })

  it('closeShareTokenConnections closes the token on its deck and its folder document, nobody else', () => {
    const onDeck = conn({
      userId: 'share:tok-abcd',
      shareToken: 'tok-abcdefgh',
      deckIdResolved: 'd1',
    })
    const onFolder = conn({ userId: 'share:tok-abcd', shareToken: 'tok-abcdefgh', folderId: 'f1' })
    const otherToken = conn({ userId: 'share:zzzz0000', shareToken: 'other', folderId: 'f1' })
    const member = conn({ userId: 'u1', folderId: 'f1' })
    setHocuspocusInstance(
      fakeServer({ 'deck:d1': [onDeck], 'folder:f1': [onFolder, otherToken, member] }),
    )

    expect(closeShareTokenConnections('tok-abcdefgh')).toBe(2)
    expect(onDeck.close).toHaveBeenCalledOnce()
    expect(onFolder.close).toHaveBeenCalledOnce()
    expect(otherToken.close).not.toHaveBeenCalled()
    expect(member.close).not.toHaveBeenCalled()
  })

  it('closeUserConnectionsOnDocument closes one user on exactly that document', () => {
    const target = conn({ userId: 'u1', folderId: 'f1' })
    const otherUser = conn({ userId: 'u2', folderId: 'f1' })
    const sameUserElsewhere = conn({ userId: 'u1', deckIdResolved: 'd1' })
    setHocuspocusInstance(
      fakeServer({ 'folder:f1': [target, otherUser], 'deck:d1': [sameUserElsewhere] }),
    )

    expect(closeUserConnectionsOnDocument('folder:f1', 'u1')).toBe(1)
    expect(target.close).toHaveBeenCalledOnce()
    expect(otherUser.close).not.toHaveBeenCalled()
    expect(sameUserElsewhere.close).not.toHaveBeenCalled()
  })

  it('closeConnectionsForDocument closes every connection on exactly that doc', () => {
    const a = conn({ userId: 'u1' })
    const b = conn({ userId: 'u2' })
    const elsewhere = conn({ userId: 'u3' })
    setHocuspocusInstance(fakeServer({ 'deck:flooded': [a, b], 'deck:other': [elsewhere] }))

    const closed = closeConnectionsForDocument('deck:flooded')

    expect(closed).toBe(2)
    expect(a.close).toHaveBeenCalledOnce()
    expect(b.close).toHaveBeenCalledOnce()
    expect(elsewhere.close).not.toHaveBeenCalled()
  })

  it('uses a stable close event and survives a connection that throws on close', () => {
    const ok = conn({ userId: 'u1' })
    const throwing: FakeConn = {
      context: { userId: 'u1' },
      close: vi.fn(() => {
        throw new Error('socket already gone')
      }),
      webSocket: { close: vi.fn() },
    }
    setHocuspocusInstance(fakeServer({ 'deck:d1': [throwing, ok] }))

    // One throws, the other still closes; helper counts only successful closes.
    const closed = closeUserConnections('u1')
    expect(closed).toBe(1)
    expect(ok.close).toHaveBeenCalledOnce()
    // The close event passed is the 4403 "Access revoked" frame …
    expect(ok.close).toHaveBeenCalledWith({ code: 4403, reason: 'Access revoked' })
    // … and the socket itself closes with it (Hocuspocus 4's Connection.close
    // only takes the connection off the document).
    expect(ok.webSocket.close).toHaveBeenCalledWith(4403, 'Access revoked')
  })

  it("closeUserFolderConnections closes one user's connections on the folder, its components and decks", () => {
    const onFolder = conn({ userId: 'u1' })
    const onMaster = conn({ userId: 'u1' })
    const onDeck = conn({ userId: 'u1' })
    const onLegacyDeck = conn({ userId: 'u1' })
    const coMember = conn({ userId: 'u2' })
    const otherFolder = conn({ userId: 'u1' })
    const otherDeck = conn({ userId: 'u1' })
    setHocuspocusInstance(
      fakeServer({
        'folder:f1': [onFolder, coMember],
        'component:c1': [onMaster],
        'deck:d1': [onDeck],
        // Bare deck ids are legacy document names of decks too.
        d2: [onLegacyDeck],
        'folder:f2': [otherFolder],
        'deck:d9': [otherDeck],
      }),
    )

    const closed = closeUserFolderConnections('u1', {
      folderId: 'f1',
      deckIds: ['d1', 'd2'],
      componentIds: ['c1'],
    })

    expect(closed).toBe(4)
    for (const c of [onFolder, onMaster, onDeck, onLegacyDeck])
      expect(c.close).toHaveBeenCalledOnce()
    for (const c of [coMember, otherFolder, otherDeck]) expect(c.close).not.toHaveBeenCalled()
  })
})

describe('hasSignedInEditor', () => {
  beforeEach(() => {
    setHocuspocusInstance(null as never)
  })

  it('counts a signed-in editor or owner, never a viewer, a share link or a render page', () => {
    setHocuspocusInstance(
      fakeServer({
        'deck:viewed': [
          conn({ userId: 'u1', role: 'viewer' }),
          // A share link with editor rights, and a render page (render token).
          conn({ userId: 'share:ab', role: 'editor', shareToken: 'tok' }),
          conn({ userId: 'share:cd', role: 'viewer', shareToken: 'nrr_x' }),
        ],
        'deck:edited': [conn({ userId: 'u2', role: 'editor' })],
        // A legacy bare deck id.
        owned: [conn({ userId: 'u3', role: 'owner' })],
        'folder:edited': [conn({ userId: 'u4', role: 'owner' })],
        'component:master': [conn({ userId: 'u5', role: 'editor' })],
        'component:watched': [conn({ userId: 'cmp-render', role: 'viewer', shareToken: 'nrr_y' })],
      }),
    )
    expect(hasSignedInEditor({ kind: 'component', id: 'master' })).toBe(true)
    expect(hasSignedInEditor({ kind: 'component', id: 'watched' })).toBe(false)
    // A deck and a master of the same id are different documents.
    expect(hasSignedInEditor({ kind: 'deck', id: 'master' })).toBe(false)
    expect(hasSignedInEditor({ kind: 'deck', id: 'viewed' })).toBe(false)
    expect(hasSignedInEditor({ kind: 'deck', id: 'edited' })).toBe(true)
    expect(hasSignedInEditor({ kind: 'deck', id: 'owned' })).toBe(true)
    expect(hasSignedInEditor({ kind: 'deck', id: 'closed' })).toBe(false)
  })

  it('is false when no Hocuspocus instance is wired', () => {
    expect(hasSignedInEditor({ kind: 'deck', id: 'd1' })).toBe(false)
  })
})
