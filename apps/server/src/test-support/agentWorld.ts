/**
 * test-support/agentWorld.ts — a real Hocuspocus instance plus the real
 * agent runtime, with Postgres replaced by in-memory stand-ins:
 *   - document persistence: an extension keeping each document's last
 *     snapshot in a Map (so an unloaded document reloads with its content,
 *     as it would from `deck_updates`);
 *   - runs/ops: the in-memory RunStore;
 *   - access: a role table.
 * WebSocket clients (real HocuspocusProviders over Node's WebSocket) can
 * connect as any user: the token they send is their user id, which
 * `onAuthenticate` puts in `connection.context.userId` exactly as the
 * production hook does.
 *
 * Excluded from the build (tsconfig.build.json: src/test-support/**).
 */

import * as Y from 'yjs'
import {
  Hocuspocus,
  type Extension,
  type onLoadDocumentPayload,
  type onStoreDocumentPayload,
} from '@hocuspocus/server'
import { HocuspocusProvider } from '@hocuspocus/provider'
import type { FastifyBaseLogger } from 'fastify'
import type { CommandRegistry, CommandTarget, FontFaceWeight, Role } from '@narrative/commands'
import type { RectangleObject } from '@narrative/shared'
import {
  addObjects,
  addSlide,
  getSlideObjectsCtx,
  setStylePack,
  type DeckMutationContext,
} from '@narrative/slide-model'
import type { Database } from '../db/client.js'
import type { AgentAccess } from '../agent/access.js'
import { createMemoryRunStore, type MemoryRunStore } from '../agent/runStore.js'
import { createFolderFontsReader } from '../agent/folderFonts.js'
import { createFolderTokensReader, type FolderTokensSources } from '../agent/folderTokens.js'
import { createFolderStylePackReader } from '../agent/folderStylePack.js'
import { createAgentRuntime, type AgentRuntime } from '../agent/runtime.js'
import type { ConfirmationLookups } from '../agent/confirmationSummary.js'
import { awarenessOwnershipExtension } from '../hocuspocus/awarenessOwnership.js'
import { awarenessRedactionExtension } from '../hocuspocus/awarenessRedaction.js'
import { agentPrincipalExtension } from '../hocuspocus/agentPrincipal.js'
import { createAgentPrincipalKeys, type AgentPrincipalKeys } from '../agent/presence.js'

/** Deck contents: slides s1, s2; on s1 rectangles r1, r2 and r3. */
export function seedDeck(doc: Y.Doc): void {
  const deck: DeckMutationContext = { doc, slides: doc.getArray('slides') }
  doc.transact(() => {
    addSlide(deck)
    addSlide(deck)
    deck.slides.get(0).set('id', 's1')
    deck.slides.get(1).set('id', 's2')
    const objects = getSlideObjectsCtx(deck, 's1')!
    const rect = (id: string, x: number): RectangleObject => ({
      id,
      type: 'rectangle',
      x,
      y: 100,
      width: 200,
      height: 100,
      fill: 0x4060e0,
      rotation: 0,
      opacity: 1,
    })
    addObjects(objects, [rect('r1', 100), rect('r2', 400), rect('r3', 700)])
  }, 'seed')
}

export const quietLog: FastifyBaseLogger = {
  level: 'silent',
  fatal: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  silent: () => undefined,
  child: () => quietLog,
} as unknown as FastifyBaseLogger

export class MemoryPersistence implements Extension {
  readonly snapshots = new Map<string, Uint8Array>()
  stores = 0
  /** Make the next N stores throw (a database outage). */
  failStores = 0

  async onLoadDocument({ documentName, document }: onLoadDocumentPayload): Promise<void> {
    const snapshot = this.snapshots.get(documentName)
    if (snapshot !== undefined) Y.applyUpdate(document, snapshot)
  }

  async onStoreDocument({ documentName, document }: onStoreDocumentPayload): Promise<void> {
    if (this.failStores > 0) {
      this.failStores--
      throw new Error('simulated store failure')
    }
    this.stores++
    this.snapshots.set(documentName, Y.encodeStateAsUpdate(document))
  }
}

/** The agent principal key secret of test worlds (never a production value). */
export const TEST_AGENT_PRINCIPAL_KEY_SECRET = 'test-only-agent-principal-key-secret-0123456789'

export interface AgentWorld {
  hocuspocus: Hocuspocus
  runtime: AgentRuntime
  /** The keys the world's presence and WebSocket server use. */
  principalKeys: AgentPrincipalKeys
  store: MemoryRunStore
  persistence: MemoryPersistence
  roles: Map<string, Role>
  /**
   * Titles the confirmation summaries show, by deck / folder / component id
   * (the fake of the database lookups, agent/confirmationSummary.ts).
   */
  titles: Map<string, string>
  /**
   * Give `userId` a role on a deck / component / folder id (`component:<id>`,
   * `folder:<id>` — a member; `folderContent:<id>` — a guest of one of the
   * folder's decks, a reader of its tokens and fonts).
   */
  grant(id: string, userId: string, role: Role): void
  /** Store a seeded deck so it loads with content. */
  createDeck(deckId: string, build?: (doc: Y.Doc) => void): void
  /**
   * Put a deck or component master (by id) in a folder whose document holds
   * `tokens` (the folder document's `tokens` map) and, given one, a style
   * pack, stored like any document.
   */
  setFolder(
    targetId: string,
    folderId: string,
    tokens?: Record<string, Record<string, Record<string, unknown>>>,
    stylePack?: Record<string, unknown>,
  ): void
  /** The font faces uploaded to `folderId` (the fake of its font assets). */
  setFolderFonts(folderId: string, faces: ReadonlyArray<FontFaceWeight>): void
  /** A WebSocket client of `userId` on a document (resolves once synced). */
  connect(documentName: string, userId: string): Promise<TestClient>
  destroy(): Promise<void>
}

export interface TestClient {
  provider: HocuspocusProvider
  doc: Y.Doc
  /** Updates the client received from the server, in order. */
  remoteUpdates: Uint8Array[]
  /** Stateless messages the client received. */
  stateless: string[]
  disconnect(): void
}

export interface AgentWorldOptions {
  documentLingerMs?: number
  runIdleMs?: number
  maxOpenRunsPerUser?: number
  beforeStatesBudgetBytes?: number
  presenceIdleMs?: number
  /** Hocuspocus store debounce (production: 2000). */
  debounce?: number
  now?: () => Date
  /** Replace the default command registry (e.g. to add a fake irreversible command). */
  registry?: CommandRegistry
  /** Capture what the runtime logs (default: silent). */
  log?: FastifyBaseLogger
  /** Hostnames URL downloads may reach without a confirmation (AGENT_URL_FETCH_ALLOWED_HOSTS). */
  urlFetchAllowedHosts?: readonly string[]
  /**
   * After a revert changed a deck (the runtime's default copies old folder
   * media back into it against Postgres; the world has no database, so by
   * default nothing happens).
   */
  afterDeckRevert?: (deckId: string) => Promise<void>
}

export async function createAgentWorld(opts: AgentWorldOptions = {}): Promise<AgentWorld> {
  const persistence = new MemoryPersistence()
  const roles = new Map<string, Role>()
  const principalKeys = createAgentPrincipalKeys(TEST_AGENT_PRINCIPAL_KEY_SECRET)
  const hocuspocus = new Hocuspocus({
    quiet: true,
    stopOnSignals: false,
    // The production lifecycle settings (hocuspocus/index.ts), with a short debounce.
    unloadImmediately: false,
    debounce: opts.debounce ?? 20,
    maxDebounce: 200,
    // Production extensions besides persistence (hocuspocus/index.ts).
    extensions: [
      persistence,
      awarenessOwnershipExtension(),
      awarenessRedactionExtension(),
      agentPrincipalExtension({ principalKeys }),
    ],
    // Production-shaped hooks (hocuspocus/index.ts + authenticate.ts): an
    // async onConnect, and an onAuthenticate that awaits a lookup and
    // RETURNS the context it establishes — Hocuspocus merges returned
    // context; writes to `data.context` can be lost when onConnect's merge
    // lands during the await (see authenticate.context.test.ts).
    async onConnect() {
      await new Promise((r) => setTimeout(r, 2))
    },
    async onAuthenticate(data) {
      await new Promise((r) => setTimeout(r, 5))
      const userId = data.token
      const role = roles.get(`${data.documentName}|${userId}`)
      if (role === undefined) throw new Error('Forbidden')
      data.connection.readOnly = role === 'viewer'
      return { userId, role }
    },
  })
  const access: AgentAccess = {
    deckRole: async (deckId, userId) => roles.get(`${deckId}|${userId}`) ?? null,
    componentRole: async (componentId, userId) =>
      roles.get(`component:${componentId}|${userId}`) ?? null,
    folderRole: async (folderId, userId) => roles.get(`folder:${folderId}|${userId}`) ?? null,
    // A member's role, else a guest of one of the folder's decks:
    // grant('folderContent:<id>', user, 'viewer').
    folderContentRole: async (folderId, userId) =>
      roles.get(`folder:${folderId}|${userId}`) ??
      roles.get(`folderContent:${folderId}|${userId}`) ??
      null,
  }
  const store = createMemoryRunStore()
  const titles = new Map<string, string>()
  const byTitle = async (id: string): Promise<string | null> => titles.get(id) ?? null
  const confirmationLookups: ConfirmationLookups = {
    deckTitle: byTitle,
    folderName: byTitle,
    componentName: byTitle,
    collaborator: async () => null,
    invite: async () => null,
    folderMember: async () => null,
    folderInvite: async () => null,
    shareLink: async () => null,
    asset: async () => null,
    componentInFolder: async () => null,
    memberFolder: async () => null,
    folderDeckCount: async () => 0,
    activeShareLinks: async () => 0,
  }
  // The database's decks.folder_id / components.folder_id, in memory; the
  // folder document itself is read like the production reader reads it
  // (live when loaded, else stored — here: the persistence snapshots).
  const folderOfTarget = new Map<string, string>()
  const folderOfFixture = async (target: CommandTarget): Promise<string | null> => {
    if (target.folderId !== undefined) return target.folderId
    const id = target.deckId ?? target.componentId
    return id === undefined ? null : (folderOfTarget.get(id) ?? null)
  }
  const folderSources: FolderTokensSources = {
    folderOf: folderOfFixture,
    async readFolder(folderId) {
      const doc = new Y.Doc()
      const live = hocuspocus.documents.get(`folder:${folderId}`)
      const state =
        live !== undefined
          ? Y.encodeStateAsUpdate(live)
          : persistence.snapshots.get(`folder:${folderId}`)
      if (state !== undefined) Y.applyUpdate(doc, state)
      return doc
    },
  }
  const folderTokens = createFolderTokensReader(folderSources)
  const folderStylePack = createFolderStylePackReader(folderSources)
  const fontsOfFolder = new Map<string, ReadonlyArray<FontFaceWeight>>()
  const folderFonts = createFolderFontsReader({
    folderOf: (target) => folderOfFixture(target),
    listFonts: async (folderId) => fontsOfFolder.get(folderId) ?? [],
  })
  const runtime = await createAgentRuntime({
    db: {} as Database,
    folderTokens,
    folderFonts,
    folderStylePack,
    log: opts.log ?? quietLog,
    hocuspocus,
    ...(opts.registry === undefined ? {} : { registry: opts.registry }),
    appOrigin: 'https://narrative.test',
    principalKeys,
    store,
    access,
    // No bucket in unit tests (services/exportSweep.test.ts covers the sweep).
    exportSweep: null,
    afterDeckRevert: opts.afterDeckRevert ?? (async () => undefined),
    confirmationLookups,
    ...(opts.urlFetchAllowedHosts === undefined
      ? {}
      : { urlFetchAllowedHosts: opts.urlFetchAllowedHosts }),
    documentLingerMs: opts.documentLingerMs ?? 0,
    ...(opts.runIdleMs === undefined ? {} : { runIdleMs: opts.runIdleMs }),
    ...(opts.beforeStatesBudgetBytes === undefined
      ? {}
      : { beforeStatesBudgetBytes: opts.beforeStatesBudgetBytes }),
    ...(opts.maxOpenRunsPerUser === undefined
      ? {}
      : { maxOpenRunsPerUser: opts.maxOpenRunsPerUser }),
    ...(opts.presenceIdleMs === undefined ? {} : { presenceIdleMs: opts.presenceIdleMs }),
    ...(opts.now === undefined ? {} : { now: opts.now }),
  })
  let listening = false
  const clients: TestClient[] = []

  return {
    hocuspocus,
    runtime,
    principalKeys,
    store,
    persistence,
    roles,
    titles,
    grant(id, userId, role) {
      roles.set(`${id}|${userId}`, role)
    },
    setFolder(targetId, folderId, tokens = {}, stylePack) {
      folderOfTarget.set(targetId, folderId)
      const doc = new Y.Doc()
      const root = doc.getMap<unknown>('tokens')
      for (const [category, entries] of Object.entries(tokens)) {
        const cat = new Y.Map<unknown>()
        root.set(category, cat)
        for (const [id, fields] of Object.entries(entries)) {
          const token = new Y.Map<unknown>()
          cat.set(id, token)
          for (const [k, v] of Object.entries(fields)) token.set(k, v)
        }
      }
      if (stylePack !== undefined) setStylePack(doc, stylePack)
      persistence.snapshots.set(`folder:${folderId}`, Y.encodeStateAsUpdate(doc))
      doc.destroy()
    },
    setFolderFonts(folderId, faces) {
      fontsOfFolder.set(folderId, faces)
    },
    createDeck(deckId, build = seedDeck) {
      const doc = new Y.Doc()
      build(doc)
      persistence.snapshots.set(deckId, Y.encodeStateAsUpdate(doc))
      doc.destroy()
    },
    async connect(documentName, userId) {
      if (!listening) {
        await hocuspocus.listen(0)
        listening = true
      }
      const doc = new Y.Doc()
      const remoteUpdates: Uint8Array[] = []
      const stateless: string[] = []
      let synced!: () => void
      const whenSynced = new Promise<void>((resolve) => (synced = resolve))
      const provider = new HocuspocusProvider({
        url: `ws://127.0.0.1:${hocuspocus.address.port}`,
        name: documentName,
        document: doc,
        token: userId,
        // Every provider in this one Node process shares a BroadcastChannel,
        // so without this each client would relay the others' awareness to
        // the server over its own socket — something browsers of DIFFERENT
        // users never do (same-browser tabs of one user do, and
        // hocuspocus/awarenessOwnership.ts allows that).
        broadcast: false,
        onSynced: () => synced(),
        onStateless: ({ payload }) => stateless.push(payload),
      })
      await whenSynced
      doc.on('update', (update: Uint8Array, origin: unknown) => {
        if (origin === provider) remoteUpdates.push(update)
      })
      const client: TestClient = {
        provider,
        doc,
        remoteUpdates,
        stateless,
        disconnect() {
          provider.destroy()
          doc.destroy()
        },
      }
      clients.push(client)
      return client
    },
    async destroy() {
      for (const c of clients) c.disconnect()
      await runtime.shutdown()
      await hocuspocus.destroy()
    },
  }
}

/**
 * Resolve once `predicate` holds, polling (WebSocket delivery is asynchronous).
 * The limit ends a hang, it does not measure speed (vitest.timeouts.ts): the
 * wait returns the moment the condition holds, and 2 s was crossed on a busy
 * machine (editor.test.ts at a load of 30–40, 2026-09-28 and 2026-10-14).
 * 15 s stays inside the 30 s test limit.
 */
export async function eventually(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** Let pending timers and socket messages run. */
export function settle(ms = 30): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
