// @vitest-environment node
/**
 * state/folderTokenWriter.test.ts — the page's side of a token change: the
 * server (a fake that writes a "server" copy of the folder document and
 * delivers its updates to the page's copy when the test says so, like the
 * sync server's WebSocket) and what the page shows meanwhile.
 */

import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import {
  addFolderToken,
  deleteFolderToken,
  readFolderTokens,
  updateFolderToken,
} from '@narrative/slide-model'
import type { EditableTokenCategory, TokenCategory } from '@narrative/commands'
import {
  FolderTokenWriter,
  InvalidTokenChange,
  TokenSyncTimeout,
  overlayTokens,
  storedFields,
  type TokenApi,
} from './folderTokenWriter.js'

/** A server holding the folder document and a page connected to it. */
function world() {
  const server = new Y.Doc()
  const page = new Y.Doc()
  addFolderToken(server, 'colors', 'brand', { name: 'Brand', value: '#2040c0' })
  addFolderToken(server, 'textStyles', 'title', { name: 'Title', size: 72, builtin: true })
  Y.applyUpdate(page, Y.encodeStateAsUpdate(server))

  // Updates the server made that the page has not received yet.
  const inTransit: Uint8Array[] = []
  server.on('update', (u: Uint8Array) => inTransit.push(u))
  const deliver = () => {
    for (const u of inTransit.splice(0)) Y.applyUpdate(page, u)
  }

  const refuse = new Set<string>()
  let nextId = 1
  const requests: Array<{ kind: string; args: unknown[] }> = []
  /** Resolvers of update requests the test holds back (see `hold`). */
  const held: Array<() => void> = []
  let holding = false

  const api: TokenApi = {
    createToken: vi.fn(async (_folderId: string, category: EditableTokenCategory, fields) => {
      requests.push({ kind: 'create', args: [category, fields] })
      const id = `new${nextId++}`
      addFolderToken(server, category, id, fields)
      return id
    }),
    updateToken: vi.fn(
      async (_folderId: string, category: EditableTokenCategory, id: string, patch) => {
        requests.push({ kind: 'update', args: [category, id, patch] })
        if (holding) await new Promise<void>((r) => held.push(r))
        if (refuse.has(id)) throw new Error('Forbidden')
        updateFolderToken(server, category, id, storedFields(category, id, patch))
        return { decks: 0, components: 0, objects: 0, failed: [] }
      },
    ),
    deleteToken: vi.fn(async (_folderId: string, category: TokenCategory, id: string) => {
      requests.push({ kind: 'delete', args: [category, id] })
      deleteFolderToken(server, category, id)
    }),
  }
  const onPendingChange = vi.fn()
  const writer = new FolderTokenWriter(api, 'folder_1', page, onPendingChange)
  const shown = () => overlayTokens(readFolderTokens(page), writer.pending())
  return {
    server,
    page,
    api,
    writer,
    shown,
    deliver,
    requests,
    refuse,
    onPendingChange,
    hold: () => {
      holding = true
    },
    release: () => {
      holding = false
      held.splice(0).forEach((r) => r())
    },
  }
}

/** Let pending promise callbacks run. */
const settle = () => new Promise((r) => setTimeout(r, 0))

describe('FolderTokenWriter.update', () => {
  it('shows a change at once and keeps showing it until the document has it', async () => {
    const w = world()
    const done = w.writer.update('colors', 'brand', { value: '#FF0000' })
    // Normalised as the server stores it.
    expect(w.shown().colors['brand']?.value).toBe('#ff0000')
    await settle()
    // The server wrote it; the page's document has not received it yet.
    expect(readFolderTokens(w.page).colors['brand']?.value).toBe('#2040c0')
    expect(w.shown().colors['brand']?.value).toBe('#ff0000')
    w.deliver()
    await done
    expect(w.writer.pending()).toEqual([])
    expect(w.shown().colors['brand']?.value).toBe('#ff0000')
  })

  it('sends one request at a time per token and merges what changed meanwhile', async () => {
    const w = world()
    w.hold()
    const first = w.writer.update('colors', 'brand', { value: '#100000' })
    const drag = ['#200000', '#300000', '#400000'].map((value) =>
      w.writer.update('colors', 'brand', { value }),
    )
    const rename = w.writer.update('colors', 'brand', { name: 'Brand red' })
    await settle()
    expect(w.requests).toHaveLength(1)
    expect(w.shown().colors['brand']).toMatchObject({ name: 'Brand red', value: '#400000' })

    w.release()
    await settle()
    w.deliver()
    await first
    // Everything changed during the first request went out as ONE request.
    await settle()
    expect(w.requests).toHaveLength(2)
    expect(w.requests[1]!.args).toEqual([
      'colors',
      'brand',
      { value: '#400000', name: 'Brand red' },
    ])
    w.release()
    await settle()
    w.deliver()
    await Promise.all([...drag, rename])
    expect(readFolderTokens(w.page).colors['brand']).toMatchObject({
      name: 'Brand red',
      value: '#400000',
    })
    expect(w.writer.pending()).toEqual([])
  })

  it('removes a field with null', async () => {
    const w = world()
    const done = w.writer.update('textStyles', 'title', { size: null })
    expect(w.shown().textStyles['title']?.size).toBeUndefined()
    await settle()
    w.deliver()
    await done
    expect(readFolderTokens(w.page).textStyles['title']?.size).toBeUndefined()
  })

  it('refuses an invalid change without sending it', async () => {
    const w = world()
    await expect(w.writer.update('textStyles', 'title', { size: -4 })).rejects.toBeInstanceOf(
      InvalidTokenChange,
    )
    expect(w.requests).toHaveLength(0)
    expect(w.writer.pending()).toEqual([])
  })

  it('drops what the server refused and shows the document again', async () => {
    const w = world()
    w.refuse.add('brand')
    await expect(w.writer.update('colors', 'brand', { value: '#00ff00' })).rejects.toThrow(
      'Forbidden',
    )
    expect(w.shown().colors['brand']?.value).toBe('#2040c0')
    expect(w.writer.pending()).toEqual([])
  })
})

describe('FolderTokenWriter.create / remove', () => {
  it('resolves with the new id once the document has the token', async () => {
    const w = world()
    let id: string | undefined
    const created = w.writer.create('colors', { name: 'Accent', value: '#ff8800' }).then((v) => {
      id = v
    })
    await settle()
    expect(id).toBeUndefined()
    w.deliver()
    await created
    expect(readFolderTokens(w.page).colors[id!]).toMatchObject({ name: 'Accent' })
  })

  it('removes a token', async () => {
    const w = world()
    const removed = w.writer.remove('colors', 'brand')
    await settle()
    w.deliver()
    await removed
    expect(readFolderTokens(w.page).colors['brand']).toBeUndefined()
  })
})

describe('FolderTokenWriter.whenTokens', () => {
  it('times out when the document never gets there', async () => {
    const w = world()
    await expect(
      w.writer.whenTokens((t) => t.colors['nope'] !== undefined, 10),
    ).rejects.toBeInstanceOf(TokenSyncTimeout)
  })
})

describe('storedFields', () => {
  it('normalises as token.update does and keeps removals', () => {
    expect(storedFields('colors', 'c', { value: '#ABC' })).toEqual({ value: '#aabbcc' })
    const fields = storedFields('textStyles', 't', { family: null, size: 20 })
    expect(fields).toEqual({ family: undefined, size: 20 })
    expect('family' in fields).toBe(true)
  })
})
