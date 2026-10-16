/**
 * e2e/share-link-folder-tokens.spec.ts
 *
 * A deck opened through a share link (`/deck/<id>?share_token=<token>`, the
 * anonymous path) renders with its folder's design tokens (folder sharing
 * step 1, docs/plans/folder-sharing.md, ADR 0013). The server's
 * `folder:<id>` document admits a share link to a deck of that folder,
 * read-only (hocuspocus/authenticate.ts, resolveFolderContentAccess); the web
 * passes the page's `share_token` to both documents (SlideDocProvider,
 * FolderDocProvider). Before the fix the folder document refused share
 * tokens, so anything linked to a folder colour rendered with the fallback
 * (transparent black).
 *
 * Two layers, one behaviour each:
 *   1. The WebSocket contract, from Node: a share-token connection to the
 *      folder document is admitted, receives the folder's colours, and its
 *      writes are refused (the server answers SyncStatus "not applied" and
 *      the token keeps its value).
 *   2. The page: a fresh browser context (no cookies) opens the share URL and
 *      the canvas paints the folder colour.
 *
 * With BYPASS_AUTH the REST API treats every caller as `dev-user`, but the
 * WebSocket takes the `share_token` before the bypass (resolvePrincipal), so
 * both documents are opened as the anonymous share-link guest either way.
 *
 * Seeding goes through the command API; the folder (and with it the deck and
 * its share link) is deleted afterwards.
 */

import { test, expect, type APIRequestContext } from './fixtures/test'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { PNG } from 'pngjs'

const API_BASE = process.env['NARRATIVE_API_URL'] ?? 'http://localhost:3001'
const WEB_ORIGIN = process.env['NARRATIVE_WEB_URL'] ?? 'http://localhost:5173'
const WS_URL = process.env['NARRATIVE_WS_URL'] ?? 'ws://localhost:3002'

/** Hot pink: nothing in the editor chrome or the default palette is this colour. */
const TOKEN_HEX = '#ff2bd6'
const TOKEN_RGB = { r: 0xff, g: 0x2b, b: 0xd6 }
/** A large rectangle, so the canvas shows tens of thousands of its pixels. */
const RECT = { x: 360, y: 240, width: 1200, height: 600 }
const RECT_ID = 'share-token-rect'

/** Hocuspocus `MessageType.SyncStatus`: the server's answer to an update. */
const MESSAGE_SYNC_STATUS = 8

async function command<T>(
  request: APIRequestContext,
  target: Record<string, string>,
  commandId: string,
  input: unknown,
): Promise<T> {
  const res = await request.post(`${API_BASE}/commands`, {
    headers: { Origin: WEB_ORIGIN },
    data: { target, command: commandId, input },
  })
  const body = (await res.json()) as { ok: boolean; result: T; error?: { message: string } }
  expect(body.ok, `${commandId}: ${body.error?.message}`).toBe(true)
  return body.result
}

interface SharedDeck {
  folderId: string
  tokenId: string
  deckId: string
  shareToken: string
}

/**
 * A folder with the hot-pink colour token, a deck in it whose rectangle is
 * filled with that token, and a viewer share link to the deck.
 */
async function seedSharedDeck(request: APIRequestContext): Promise<SharedDeck> {
  const { id: folderId } = await command<{ id: string }>(request, {}, 'folder.create', {
    name: `Share-link tokens e2e ${Date.now()}`,
  })
  createdFolders.push(folderId)
  const { tokenId } = await command<{ tokenId: string }>(request, { folderId }, 'token.create', {
    category: 'colors',
    name: 'Share-link pink',
    value: TOKEN_HEX,
  })
  const { id: deckId } = await command<{ id: string }>(request, {}, 'deck.create', {
    title: 'share-link tokens',
    folderId,
  })
  await command(request, { deckId }, 'object.create', {
    slide: { index: 0 },
    id: RECT_ID,
    object: { type: 'rectangle', ...RECT, fill: { $token: `colors.${tokenId}` } },
  })
  // The Share dialog's route: `share.links.create` asks for the user's
  // confirmation over the command API.
  const link = await request.post(`${API_BASE}/decks/${deckId}/share-links`, {
    data: { role: 'viewer' },
  })
  expect(link.status(), 'POST /decks/:id/share-links').toBe(201)
  const { id: shareToken } = (await link.json()) as { id: string }
  return { folderId, tokenId, deckId, shareToken }
}

/** Deletes the folder with its decks (and so their share links). */
async function deleteFolder(request: APIRequestContext, folderId: string): Promise<void> {
  const res = await request.delete(`${API_BASE}/folders/${folderId}`)
  expect(res.ok() || res.status() === 404, `DELETE /folders/${folderId}: ${res.status()}`).toBe(
    true,
  )
}

async function colourOf(
  request: APIRequestContext,
  folderId: string,
  tokenId: string,
): Promise<string | undefined> {
  const { colors } = await command<{ colors: { id: string; value: string }[] }>(
    request,
    { folderId },
    'token.list',
    {},
  )
  return colors.find((c) => c.id === tokenId)?.value.toLowerCase()
}

/** Pixels within a few steps of `TOKEN_RGB` in a PNG screenshot. */
function countTokenPixels(buf: Buffer): number {
  const { data } = PNG.sync.read(buf)
  let count = 0
  for (let i = 0; i < data.length; i += 4) {
    if (
      Math.abs(data[i]! - TOKEN_RGB.r) <= 12 &&
      Math.abs(data[i + 1]! - TOKEN_RGB.g) <= 12 &&
      Math.abs(data[i + 2]! - TOKEN_RGB.b) <= 12
    )
      count++
  }
  return count
}

/** Reads a lib0 varUint at `pos`; returns the value and the next position. */
function readVarUint(bytes: Uint8Array, pos: number): [number, number] {
  let value = 0
  let shift = 0
  for (;;) {
    const byte = bytes[pos++]!
    value += (byte & 0x7f) * 2 ** shift
    if (byte < 0x80) return [value, pos]
    shift += 7
  }
}

const MESSAGE_TYPES = ['sync', 'awareness', 'auth', 'queryAwareness', 'syncReply', 'stateless']
MESSAGE_TYPES[7] = 'close'
MESSAGE_TYPES[MESSAGE_SYNC_STATUS] = 'syncStatus'

/**
 * A Hocuspocus frame's header — `varString documentName`, `varUint type` —
 * and the position of its body.
 */
function readFrame(bytes: Uint8Array): { documentName: string; type: number; body: number } {
  const [nameLength, nameStart] = readVarUint(bytes, 0)
  const documentName = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLength))
  const [type, body] = readVarUint(bytes, nameStart + nameLength)
  return { documentName, type, body }
}

/** Folders this test created, deleted afterwards even when seeding failed halfway. */
const createdFolders: string[] = []

test.afterEach(async ({ request }) => {
  for (const folderId of createdFolders.splice(0)) await deleteFolder(request, folderId)
})

test.describe('share-link folder tokens', () => {
  test("a share link to a deck opens its folder's token document read-only", async ({
    request,
  }) => {
    const { folderId, tokenId, shareToken } = await seedSharedDeck(request)

    // Every SyncStatus the server sends on this connection: true = applied.
    const syncStatuses: boolean[] = []
    const denied: string[] = []
    const doc = new Y.Doc()
    // The share token rides in the upgrade URL, as the web passes it. The
    // auth frame (`token`) is what makes Hocuspocus run onAuthenticate at
    // all; on the share-token path the server ignores its value.
    const url = new URL(WS_URL)
    url.searchParams.set('share_token', shareToken)
    const provider = new HocuspocusProvider({
      url: url.toString(),
      name: `folder:${folderId}`,
      document: doc,
      token: 'share-link',
      onAuthenticationFailed: ({ reason }) => denied.push(reason),
    })
    // The provider's own message event (the configuration's `onMessage`
    // also reaches its socket, which passes the raw MessageEvent).
    provider.on('message', ({ event }: { event: MessageEvent }) => {
      const bytes = new Uint8Array(event.data as ArrayBuffer)
      const frame = readFrame(bytes)
      if (frame.type === MESSAGE_SYNC_STATUS)
        syncStatuses.push(readVarUint(bytes, frame.body)[0] === 1)
    })
    try {
      await expect
        .poll(() => (denied.length > 0 ? `denied: ${denied.join()}` : provider.isSynced), {
          timeout: 10_000,
        })
        .toBe(true)
      expect(provider.authorizedScope).toBe('readonly')

      // The folder's colours arrived: the token the deck links to is there.
      const colours = doc.getMap<unknown>('tokens').get('colors')
      expect(colours, 'tokens.colors of the folder document').toBeInstanceOf(Y.Map)
      const pink = (colours as Y.Map<unknown>).get(tokenId)
      expect(pink, `colour token ${tokenId}`).toBeInstanceOf(Y.Map)
      expect(String((pink as Y.Map<unknown>).get('value')).toLowerCase()).toBe(TOKEN_HEX)

      // The handshake is acknowledged (the client's own sync step, nothing new
      // in it) before anything is written, so every status after it answers
      // the write below.
      await expect.poll(() => provider.hasUnsyncedChanges, { timeout: 10_000 }).toBe(false)
      const acknowledged = syncStatuses.length

      // A write over this connection is refused…
      ;(pink as Y.Map<unknown>).set('value', '#000000')
      await expect
        .poll(() => syncStatuses.slice(acknowledged), { timeout: 10_000 })
        .toEqual([false])
      expect(provider.hasUnsyncedChanges).toBe(true)
    } finally {
      provider.destroy()
      doc.destroy()
    }
    // …and the folder keeps its colour.
    expect(await colourOf(request, folderId, tokenId)).toBe(TOKEN_HEX)
  })

  test("a deck opened through its share link paints its folder's colour", async ({
    browser,
    request,
  }) => {
    const { deckId, folderId, shareToken } = await seedSharedDeck(request)

    // A fresh context: no cookies, no storage — the anonymous visitor.
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } })
    const page = await context.newPage()
    const pageErrors: string[] = []
    const failedRequests: string[] = []
    page.on('pageerror', (e) => pageErrors.push(e.message))
    page.on('response', (res) => {
      if (res.status() >= 400) failedRequests.push(`${res.status()} ${new URL(res.url()).pathname}`)
    })
    // Which Hocuspocus messages the page sent and received, per document —
    // tells a document that was never asked for from one that never
    // authenticated.
    const frames = new Map<string, Set<string>>()
    const record = (direction: 'sent' | 'received', payload: string | Buffer) => {
      if (typeof payload === 'string') return
      const { documentName, type } = readFrame(new Uint8Array(payload))
      const doc =
        documentName === deckId
          ? 'deck'
          : documentName === `folder:${folderId}`
            ? 'folder'
            : documentName
      const key = `${doc} ${direction}`
      if (!frames.has(key)) frames.set(key, new Set())
      frames.get(key)!.add(MESSAGE_TYPES[type] ?? String(type))
    }
    page.on('websocket', (ws) => {
      ws.on('framesent', (f) => record('sent', f.payload))
      ws.on('framereceived', (f) => record('received', f.payload))
    })
    const diagnostics = () =>
      [
        `frames: ${[...frames].map(([k, types]) => `${k} [${[...types].join(', ')}]`).join('; ') || 'none'}`,
        `page errors: ${pageErrors.join(' | ') || 'none'}`,
        `failed requests: ${failedRequests.join(' | ') || 'none'}`,
      ].join('; ')

    try {
      await page.goto(`${WEB_ORIGIN}/deck/${deckId}?share_token=${encodeURIComponent(shareToken)}`)
      await expect(page.locator('.artboard')).toBeVisible({ timeout: 30_000 })

      // The deck document synced over the share link: the rectangle is mounted.
      await expect(async () => {
        const mounted = await page.evaluate(
          (id) => window.__narrative_test_api?.sceneGraphHasMountedNode(id) ?? false,
          RECT_ID,
        )
        expect(mounted, `rectangle never mounted — ${diagnostics()}`).toBe(true)
      }).toPass({ timeout: 15_000 })

      // The folder document synced too: the rectangle paints in the token
      // colour, not the unresolved-token fallback.
      await expect(async () => {
        const pixels = countTokenPixels(await page.screenshot({ fullPage: true }))
        expect(pixels, `folder colour never painted — ${diagnostics()}`).toBeGreaterThan(20_000)
      }).toPass({ timeout: 15_000 })

      expect(pageErrors, diagnostics()).toEqual([])
    } finally {
      await context.close()
    }
  })
})
