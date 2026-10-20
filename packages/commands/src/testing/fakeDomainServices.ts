/**
 * commands/src/testing/fakeDomainServices.ts — in-memory fakes of the deck,
 * folder, sharing, media, component, PowerPoint and token services, wired
 * into `createFakeServices()` (./fakeServices.ts). They model a small
 * fixture world so every server command's examples run in the contract
 * suite, and command tests can assert what a handler asked the service for.
 *
 * The world (user `u1` owns everything unless noted):
 *   - folders `folder_fixture` ("Client A"), `folder_b` ("Client B"),
 *     `folder_drafts` ("Drafts");
 *   - decks `deck_fixture` ("Fixture deck", in folder_fixture — the target of
 *     the contract suite) and `deck_other` ("Appendix", 3 slides, folder_b);
 *   - component `cmp_headline` in folder_fixture: a text object named
 *     "title" ("Headline", bold), a text object named "subtitle"
 *     ("Subline") and an unnamed rectangle;
 *   - media: image `asset-fixture` and video `video_fixture` of deck_fixture,
 *     folder font `font_fixture` of folder_fixture;
 *   - collaborators u1 (owner) and `user_jana` (editor), pending invite
 *     `invite_fixture`, share link `link_fixture`.
 *
 * Real behaviour (authorisation, Postgres, storage, Hocuspocus) is tested in
 * apps/server against the real services.
 */

import { MAX_RENDER_SLIDES } from '../commands/render.js'
import { MAX_LIST_PAGE_SIZE } from '../services/common.js'
import type { RenderSlideRef } from '../services/render.js'
import type { AgentRunService } from '../services/runs.js'
import * as Y from 'yjs'
import {
  addObjects,
  addSlide,
  applyFormat,
  addFolderToken,
  createSlideDoc,
  deleteFolderToken,
  getSlideObjectsCtx,
  MAX_COLORS,
  migrateFolderTokens,
  readFolderTokens,
  seedDefaultTokens,
  TOKEN_CATEGORIES,
  updateFolderToken,
  type FolderTokensSnapshot,
  type TokenCategory,
  readStylePack,
  setStylePack,
  patchStylePack,
  deleteStylePack,
  mergeStylePackPatch,
  readMasterOrigin,
  replaceMasterObjects,
} from '@narrative/slide-model'
import { createFixtureFolderTokens } from './fixtureTokens.js'
import { InvalidTokenFields, parseNewTokenFields, parseTokenPatch } from '../commands/tokens.js'
import { textStyleNameTaken } from '../text/textStyle.js'
import type { TextObject, RectangleObject, StylePack } from '@narrative/shared'
import { exampleStylePack } from '@narrative/shared'
import { parseStylePack } from '../stylePack/parse.js'
import { previousOfUpdate } from '../stylePack/change.js'
import { compileStylePack } from '../stylePack/compile.js'
import { storedStylePack } from '../stylePack/parse.js'
import { CommandError } from '../errors.js'
import { applyInsertPlan, planForMaster } from '../insert/plan.js'
import { objectsOf, requireObjects, resolveSlide } from '../refs.js'
import { createFixtureDeck, FIXTURE_SLIDE_IDS } from './fixtureDeck.js'
import type { ServerServices } from '../services.js'
import type {
  ComponentRecord,
  DeckRecord,
  DeckWithRole,
  FolderRecord,
  FontFaceInfo,
  PermissionEntry,
  PendingInvite,
  ShareLinkEntry,
  SlideInsertResult,
} from '../services/types.js'

export type Recorder = (method: string, args: unknown) => void

export interface FakeWorld {
  deckId: string
  folderId: string
  userId: string
}

const T0 = '2026-09-26T10:00:00.000Z'
/** The actor's Drafts folder (`folders.is_drafts` on the server). */
const DRAFTS_ID = 'folder_drafts'

function notFound(what: string, id: string): CommandError {
  return new CommandError('not_found', `${what} '${id}' does not exist`)
}

function fontFace(assetId: string, family: string): FontFaceInfo {
  return {
    assetId,
    family,
    weight: 700,
    style: 'normal',
    postscriptName: `${family.replace(/\s+/g, '')}-Bold`,
    url: `https://storage.test/fonts/${assetId}`,
    sizeBytes: 64_000,
    uploadedAt: T0,
  }
}

/** The master document of `cmp_headline`. */
export function fixtureComponentState(): Uint8Array {
  const master = createSlideDoc()
  const slideId = master.slides.get(0).get('id') as string
  const objects = getSlideObjectsCtx(master, slideId)
  if (objects === null) throw new Error('fixture component: no objects array')
  const text = (id: string, name: string, body: string, y: number, size: number): TextObject => ({
    id,
    type: 'text',
    name,
    x: 120,
    y,
    width: 1200,
    height: size * 1.4,
    text: body,
    fontSize: size,
    fontWeight: 'normal',
    color: 0x111111,
    align: 'left',
    rotation: 0,
    opacity: 1,
  })
  const bar: RectangleObject = {
    id: 'm_bar',
    type: 'rectangle',
    x: 120,
    y: 60,
    width: 80,
    height: 8,
    fill: 0xe0301e,
    rotation: 0,
    opacity: 1,
  }
  addObjects(objects, [
    bar,
    text('m_title', 'title', 'Headline', 90, 64),
    text('m_subtitle', 'subtitle', 'Subline', 190, 32),
  ])
  const title = objects.objects
    .toArray()
    .find((m) => m.get('id') === 'm_title')
    ?.get('text')
  if (title instanceof Y.Text) {
    master.doc.transact(() => applyFormat(title, 0, title.length, { fontWeight: 700 }))
  }
  const state = Y.encodeStateAsUpdate(master.doc)
  master.doc.destroy()
  return state
}

export type DomainFakes = Pick<
  ServerServices,
  | 'decks'
  | 'folders'
  | 'sharing'
  | 'folderSharing'
  | 'media'
  | 'components'
  | 'pptx'
  | 'render'
  | 'tokens'
  | 'stylePacks'
> & {
  /**
   * A deep copy of everything the fakes hold (and the id counter, so a
   * repeated call that mints a new record shows up too) — what the contract
   * suite compares when it checks that a server command is idempotent.
   */
  snapshot(): Record<string, unknown>
}

/**
 * A folder document holding `tokens` (slide-model folderDoc.ts) — the
 * token fakes read and write it with the functions the server uses.
 */
function folderDocWith(tokens: FolderTokensSnapshot): Y.Doc {
  const doc = new Y.Doc()
  for (const category of TOKEN_CATEGORIES) {
    for (const [id, token] of Object.entries(tokens[category])) {
      const { id: _id, ...fields } = token as { id: string } & Record<string, unknown>
      addFolderToken(doc, category, id, fields)
    }
  }
  return doc
}

/**
 * The fixture deck's slides a render asks for, like the real service: in the
 * order asked, a missing one refused before anything renders, at most
 * MAX_RENDER_SLIDES. Only the fixture deck has slides here.
 */
function pickFixtureSlides(
  hasSlides: boolean,
  refs: RenderSlideRef[] | 'all',
): Array<{ id: string; index: number }> {
  const ids: readonly string[] = hasSlides ? FIXTURE_SLIDE_IDS : []
  const chosen =
    refs === 'all'
      ? ids.map((id, index) => ({ id, index }))
      : refs.map((ref) => {
          const index = 'index' in ref ? ref.index : ids.indexOf(ref.id)
          const id = ids[index]
          if (id === undefined || index < 0) {
            throw notFound('slide', 'index' in ref ? `#${ref.index}` : ref.id)
          }
          return { id, index }
        })
  if (chosen.length === 0) {
    throw new CommandError('invalid_input', 'The deck has no slides to render')
  }
  if (chosen.length > MAX_RENDER_SLIDES) {
    throw new CommandError(
      'invalid_input',
      `That is ${chosen.length} slides; one request renders at most ${MAX_RENDER_SLIDES}`,
    )
  }
  return chosen
}

export function createDomainFakes(
  world: FakeWorld,
  recorder: (service: keyof ServerServices) => Recorder,
  /** The fake runs' before-states (query.render's compare reads them, as the real service does). */
  runs: Pick<AgentRunService, 'stateBefore'> = { stateBefore: () => null },
): DomainFakes {
  // The fixture folder's tokens are the ones the contract suite gives
  // commands as `ctx.folderTokens`; the other folders have none yet.
  const folderDocs = new Map<string, Y.Doc>([
    [world.folderId, folderDocWith(createFixtureFolderTokens())],
  ])
  // The fixture folder carries the example style pack (A4.3): style.pack.* examples read and change it.
  setStylePack(
    folderDocs.get(world.folderId)!,
    exampleStylePack() as unknown as Record<string, unknown>,
  )
  /** Masters a pack's compile made, by component id (the fixture's own master is fixtureComponentState). */
  const packMasters = new Map<string, Y.Doc>()
  const folderDoc = (folderId: string): Y.Doc => {
    let doc = folderDocs.get(folderId)
    if (doc === undefined) {
      doc = new Y.Doc()
      folderDocs.set(folderId, doc)
    }
    return doc
  }
  const requireToken = (folderId: string, category: TokenCategory, tokenId: string) => {
    const tokens = readFolderTokens(folderDoc(folderId))[category]
    if (!Object.hasOwn(tokens, tokenId)) throw notFound(`${category} token`, tokenId)
    return tokens[tokenId]!
  }
  /** Invalid fields are `invalid_input`, as the real service answers. */
  const validTokenFields = (parse: () => Record<string, unknown>) => {
    try {
      return parse()
    } catch (err) {
      if (err instanceof InvalidTokenFields) throw new CommandError('invalid_input', err.message)
      throw err
    }
  }
  const u1 = world.userId
  const folders = new Map<string, FolderRecord>([
    [world.folderId, { id: world.folderId, ownerUserId: u1, name: 'Client A', createdAt: T0 }],
    ['folder_b', { id: 'folder_b', ownerUserId: u1, name: 'Client B', createdAt: T0 }],
    ['folder_drafts', { id: 'folder_drafts', ownerUserId: u1, name: 'Drafts', createdAt: T0 }],
    // Shared with the actor by Jana, who created it (folder sharing).
    [
      'folder_shared',
      { id: 'folder_shared', ownerUserId: 'user_jana', name: 'Partner', createdAt: T0 },
    ],
  ])
  const deckRecord = (id: string, title: string, folderId: string): DeckRecord => ({
    id,
    title,
    ownerUserId: u1,
    folderId,
    thumbnailKey: null,
    thumbnailUpdatedAt: null,
    thumbnailUrl: null,
    createdAt: T0,
    updatedAt: T0,
  })
  const decks = new Map<string, DeckWithRole>([
    [
      world.deckId,
      { ...deckRecord(world.deckId, 'Fixture deck', world.folderId), viewerRole: 'owner' },
    ],
    ['deck_other', { ...deckRecord('deck_other', 'Appendix', 'folder_b'), viewerRole: 'owner' }],
  ])
  const components = new Map<string, ComponentRecord>([
    [
      'cmp_headline',
      {
        id: 'cmp_headline',
        folderId: world.folderId,
        name: 'Headline block',
        thumbnailKey: null,
        thumbnailUrl: null,
        createdAt: T0,
        updatedAt: T0,
      },
    ],
  ])
  const folderFonts = new Map<string, FontFaceInfo[]>([
    [world.folderId, [fontFace('font_fixture', 'Brand Sans')]],
  ])
  const permissions: PermissionEntry[] = [
    {
      userId: u1,
      role: 'owner',
      grantedAt: T0,
      grantedBy: u1,
      email: 'u1@example.com',
      name: 'Fixture User',
    },
    {
      userId: 'user_jana',
      role: 'editor',
      grantedAt: T0,
      grantedBy: u1,
      email: 'jana@example.com',
      name: 'Jana',
    },
  ]
  const invites: PendingInvite[] = [
    {
      id: 'invite_fixture',
      email: 'petr@example.com',
      role: 'viewer',
      invitedAt: T0,
      expiresAt: T0,
    },
  ]
  const links: ShareLinkEntry[] = [
    {
      id: 'link_fixture',
      role: 'viewer',
      createdAt: T0,
      expiresAt: null,
      createdBy: u1,
      revoked: false,
    },
  ]
  // Folder sharing: the fixture folder's members and pending invites.
  const folderMembers = new Map<string, PermissionEntry[]>(
    [...folders.keys()].map((id) => [
      id,
      id === 'folder_shared'
        ? [
            { ...permissions[1]!, role: 'owner' as const, grantedBy: null },
            { ...permissions[0]!, role: 'editor' as const, grantedBy: 'user_jana' },
          ]
        : [{ ...permissions[0]! }, ...(id === world.folderId ? [{ ...permissions[1]! }] : [])],
    ]),
  )
  const folderInvites = new Map<string, PendingInvite[]>([
    [
      world.folderId,
      [
        {
          id: 'folder_invite_fixture',
          email: 'eva@example.com',
          role: 'viewer',
          invitedAt: T0,
          expiresAt: T0,
        },
      ],
    ],
  ])
  let nextId = 1
  const fresh = (prefix: string) => `${prefix}_${nextId++}`

  const requireDeck = (id: string) => {
    const d = decks.get(id)
    if (d === undefined) throw notFound('deck', id)
    return d
  }
  const requireFolder = (id: string) => {
    const f = folders.get(id)
    if (f === undefined) throw notFound('folder', id)
    return f
  }
  /** The decks `list` answers, in its order: created first, then id. */
  const listedInOrder = (folderId: string | undefined): DeckWithRole[] =>
    [...decks.values()]
      .filter((d) => folderId === undefined || d.folderId === folderId)
      .sort((a, b) =>
        a.createdAt === b.createdAt
          ? a.id.localeCompare(b.id)
          : a.createdAt.localeCompare(b.createdAt),
      )
  const requireComponent = (id: string, folderId?: string) => {
    const c = components.get(id)
    if (c === undefined || (folderId !== undefined && c.folderId !== folderId)) {
      throw notFound('component', id)
    }
    return c
  }

  /** The folder's members, the caller being one of its owners (the real service's `requireFolderRole`). */
  const requireFolderOwner = (folderId: string, userId: string) => {
    const folder = requireFolder(folderId)
    const members = folderMembers.get(folderId) ?? []
    const me = members.find((m) => m.userId === userId)
    if (me === undefined) throw new CommandError('forbidden', 'Forbidden')
    if (me.role !== 'owner') {
      throw new CommandError('forbidden', "Forbidden: only the folder's owner may do this")
    }
    return { folder, members }
  }
  const requireFolderMember = (members: PermissionEntry[], memberId: string) => {
    const m = members.find((x) => x.userId === memberId)
    if (m === undefined) {
      throw new CommandError(
        'not_found',
        'That user is not a member of this folder; invite them with their email instead.',
      )
    }
    return m
  }
  const requireAnotherOwner = (members: PermissionEntry[], memberId: string) => {
    if (!members.some((m) => m.role === 'owner' && m.userId !== memberId)) {
      throw new CommandError(
        'conflict',
        'A folder keeps at least one owner — make someone else an owner first.',
      )
    }
  }

  /**
   * The actor's role in a folder and who shared it: they own every folder
   * but `folder_shared`, which Jana shared with them as an editor.
   */
  const listedAccess = (f: FolderRecord) =>
    f.id === 'folder_shared'
      ? {
          role: 'editor' as const,
          sharedBy: { name: 'Jana', email: 'jana@example.com' },
          isDrafts: false,
        }
      : { role: 'owner' as const, sharedBy: null, isDrafts: f.id === DRAFTS_ID }

  const rDecks = recorder('decks')
  const rFolders = recorder('folders')
  const rSharing = recorder('sharing')
  const rFolderSharing = recorder('folderSharing')
  const rMedia = recorder('media')
  const rComponents = recorder('components')
  const rPptx = recorder('pptx')
  const rRender = recorder('render')
  const pdfJobs = new Map<string, { deckId: string; pages: number; delivery: 'url' | 'base64' }>()
  const pickRenderSlides = (deckId: string, refs: RenderSlideRef[] | 'all') => {
    requireDeck(deckId)
    return pickFixtureSlides(deckId === world.deckId, refs)
  }
  const rTokens = recorder('tokens')
  const rStyle = recorder('stylePacks')

  return {
    snapshot: () =>
      structuredClone({
        folders: [...folders],
        decks: [...decks],
        components: [...components],
        folderFonts: [...folderFonts],
        folderTokens: [...folderDocs].map(([id, doc]) => [id, readFolderTokens(doc)]),
        permissions,
        invites,
        links,
        folderMembers: [...folderMembers],
        folderInvites: [...folderInvites],
        nextId,
      }),
    decks: {
      async list(args) {
        rDecks('list', args)
        if (args.folderId !== undefined) requireFolder(args.folderId)
        return listedInOrder(args.folderId)
      },
      async listRecordsPage(args) {
        rDecks('listRecordsPage', args)
        if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > MAX_LIST_PAGE_SIZE)
          throw new CommandError(
            'invalid_input',
            `limit must be an integer from 1 to ${MAX_LIST_PAGE_SIZE}`,
          )
        if (args.folderId !== undefined) requireFolder(args.folderId)
        // Keyset: created ascending, then id ascending (as the real service).
        const after = (d: DeckWithRole): boolean =>
          args.after === undefined ||
          d.createdAt > args.after.key ||
          (d.createdAt === args.after.key && d.id > args.after.id)
        const matching = listedInOrder(args.folderId).filter(after)
        const page = matching.slice(0, args.limit)
        const last = page[page.length - 1]
        return {
          decks: page,
          next:
            matching.length > args.limit && last !== undefined
              ? { key: last.createdAt, id: last.id }
              : null,
        }
      },
      async listPage(args) {
        rDecks('listPage', args)
        if (args.folderId !== undefined) requireFolder(args.folderId)
        const q = args.query?.toLowerCase()
        // Keyset: updatedAt descending, then id descending (as the real service).
        const after = (d: DeckWithRole): boolean =>
          args.after === undefined ||
          d.updatedAt < args.after.key ||
          (d.updatedAt === args.after.key && d.id < args.after.id)
        const matching = [...decks.values()]
          .filter((d) => args.folderId === undefined || d.folderId === args.folderId)
          .filter((d) => q === undefined || d.title.toLowerCase().includes(q))
          .sort((a, b) =>
            a.updatedAt === b.updatedAt
              ? b.id.localeCompare(a.id)
              : b.updatedAt.localeCompare(a.updatedAt),
          )
          .filter(after)
        const page = matching.slice(0, args.limit)
        const last = page[page.length - 1]
        return {
          decks: page.map((d) => ({
            id: d.id,
            title: d.title,
            folderId: d.folderId,
            updatedAt: d.updatedAt,
            role: d.viewerRole,
          })),
          next:
            matching.length > args.limit && last !== undefined
              ? { key: last.updatedAt, id: last.id }
              : null,
        }
      },
      async get(args) {
        rDecks('get', args)
        return requireDeck(args.deckId)
      },
      async create(args) {
        rDecks('create', args)
        const folderId = args.folderId ?? 'folder_drafts'
        requireFolder(folderId)
        const id = fresh('deck')
        const deck = deckRecord(id, args.title ?? 'Untitled Deck', folderId)
        decks.set(id, { ...deck, viewerRole: 'owner' })
        return { ...deck, firstSlideId: fresh('slide') }
      },
      async duplicate(args) {
        rDecks('duplicate', args)
        const source = requireDeck(args.deckId)
        const folderId = args.folderId ?? source.folderId ?? 'folder_drafts'
        requireFolder(folderId)
        const id = fresh('deck')
        const deck = deckRecord(id, args.title ?? `${source.title} (copy)`, folderId)
        decks.set(id, { ...deck, viewerRole: 'owner' })
        return { ...deck, slideCount: 3, mediaCopied: 1, skippedImages: 0 }
      },
      async rename(args) {
        rDecks('rename', args)
        const deck = { ...requireDeck(args.deckId), title: args.title }
        decks.set(deck.id, deck)
        return deck
      },
      async delete(args) {
        rDecks('delete', args)
        requireDeck(args.deckId)
        decks.delete(args.deckId)
      },
      async moveDecks(args) {
        rDecks('moveDecks', args)
        requireFolder(args.destFolderId)
        for (const id of args.deckIds) {
          const d = requireDeck(id)
          decks.set(id, { ...d, folderId: args.destFolderId })
        }
        return {
          movedCount: args.deckIds.length,
          tokens: args.deckIds.map((deckId) => ({
            deckId,
            rebound: 3,
            literalised: 1,
            detached: 0,
            unmatched: 0,
          })),
          media: args.deckIds.map((deckId) => ({
            deckId,
            copied: 1,
            unresolved: 0,
            copyFailed: 0,
          })),
        }
      },
      async moveDeck(args) {
        rDecks('moveDeck', args)
        const d = requireDeck(args.deckId)
        requireFolder(args.destFolderId)
        if (d.folderId === args.destFolderId) return { movedCount: 0, tokens: [], media: [] }
        decks.set(d.id, { ...d, folderId: args.destFolderId })
        return {
          movedCount: 1,
          tokens: [{ deckId: d.id, rebound: 3, literalised: 1, detached: 0, unmatched: 0 }],
          media: [{ deckId: d.id, copied: 1, unresolved: 0, copyFailed: 0 }],
        }
      },
      async activeEditors(args) {
        rDecks('activeEditors', args)
        requireFolder(args.folderId)
        return [
          {
            deckId: world.deckId,
            users: [{ userId: 'user_jana', email: 'jana@example.com', name: 'Jana' }],
          },
        ]
      },
      async listFonts(args) {
        rDecks('listFonts', args)
        requireDeck(args.deckId)
        return []
      },
      async prepareObjectInsert(args) {
        rDecks('prepareObjectInsert', { ...args, plan: { objects: args.plan.objects.length } })
        for (const ref of [args.source, args.target]) {
          if ('deckId' in ref) requireDeck(ref.deckId)
          else requireComponent(ref.componentId)
        }
        // The fake copies nothing: the planned objects land as they are,
        // their pictures counted as copied media.
        const media = args.plan.objects.filter((o) => o.type === 'image' || o.type === 'video')
        return {
          apply(objects) {
            return {
              objectIds: applyInsertPlan(
                objects,
                'componentId' in args.target ? planForMaster(args.plan) : args.plan,
              ),
              mediaRegistered: media.length,
              skippedImages: 0,
              droppedLinks: 0,
            }
          },
          async discard() {},
          async settle() {
            rDecks('settleObjectInsert', {})
          },
        }
      },
    },

    folders: {
      async list(args) {
        rFolders('list', args)
        return [...folders.values()].map((f) => ({
          id: f.id,
          name: f.name,
          createdAt: f.createdAt,
          deckCount: [...decks.values()].filter((d) => d.folderId === f.id).length,
          ...listedAccess(f),
        }))
      },
      async listPage(args) {
        rFolders('listPage', args)
        const q = args.query?.toLowerCase()
        const keyOf = (f: FolderRecord) => f.name.toLowerCase()
        // Keyset: lower-cased name ascending, then id ascending (as the real service).
        const after = (f: FolderRecord): boolean =>
          args.after === undefined ||
          keyOf(f) > args.after.key ||
          (keyOf(f) === args.after.key && f.id > args.after.id)
        const matching = [...folders.values()]
          .filter((f) => q === undefined || f.name.toLowerCase().includes(q))
          .sort((a, b) =>
            keyOf(a) === keyOf(b) ? a.id.localeCompare(b.id) : keyOf(a).localeCompare(keyOf(b)),
          )
          .filter(after)
        const page = matching.slice(0, args.limit)
        const last = page[page.length - 1]
        return {
          folders: page.map((f) => ({
            id: f.id,
            name: f.name,
            createdAt: f.createdAt,
            deckCount: [...decks.values()].filter((d) => d.folderId === f.id).length,
            ...listedAccess(f),
          })),
          next:
            matching.length > args.limit && last !== undefined
              ? { key: keyOf(last), id: last.id }
              : null,
        }
      },
      async create(args) {
        rFolders('create', args)
        const folder: FolderRecord = {
          id: fresh('folder'),
          ownerUserId: args.userId,
          name: args.name,
          createdAt: T0,
        }
        folders.set(folder.id, folder)
        // The creator is the folder's first member, as on the server.
        folderMembers.set(folder.id, [
          { ...permissions[0]!, userId: args.userId, grantedAt: T0, grantedBy: null },
        ])
        return {
          ...folder,
          deckCount: 0,
          role: 'owner' as const,
          sharedBy: null,
          isDrafts: false as const,
        }
      },
      async rename(args) {
        rFolders('rename', args)
        const folder = { ...requireFolder(args.folderId), name: args.name }
        folders.set(folder.id, folder)
        return folder
      },
      async delete(args) {
        rFolders('delete', args)
        const folder = requireFolder(args.folderId)
        if (folder.id === DRAFTS_ID) throw new CommandError('conflict', 'cannot_delete_drafts')
        const contained = [...decks.values()].filter((d) => d.folderId === folder.id)
        for (const d of contained) decks.delete(d.id)
        folders.delete(folder.id)
        // Members and pending invites go with the folder (ON DELETE CASCADE).
        folderMembers.delete(folder.id)
        folderInvites.delete(folder.id)
        return { deletedDeckCount: contained.length }
      },
      async listFonts(args) {
        rFolders('listFonts', args)
        requireFolder(args.folderId)
        return folderFonts.get(args.folderId) ?? []
      },
      async uploadFont(args) {
        rFolders('uploadFont', args)
        requireFolder(args.folderId)
        const face = fontFace(fresh('font'), args.familyOverride ?? 'Inter')
        folderFonts.set(args.folderId, [...(folderFonts.get(args.folderId) ?? []), face])
        return face
      },
      async deleteFont(args) {
        rFolders('deleteFont', args)
        const fonts = folderFonts.get(args.folderId) ?? []
        if (!fonts.some((f) => f.assetId === args.assetId)) throw notFound('font', args.assetId)
        folderFonts.set(
          args.folderId,
          fonts.filter((f) => f.assetId !== args.assetId),
        )
        return { promotedToDeckCount: 1 }
      },
    },

    sharing: {
      async listPermissions(args) {
        rSharing('listPermissions', args)
        requireDeck(args.deckId)
        return permissions
      },
      async invite(args) {
        rSharing('invite', args)
        requireDeck(args.deckId)
        const known = permissions.find((p) => p.email === args.email.toLowerCase())
        if (known !== undefined) {
          if (known.userId === args.inviterUserId) {
            throw new CommandError('conflict', 'You cannot change your own role.')
          }
          known.role = args.role
          return {
            kind: 'granted',
            user: { userId: known.userId, email: args.email, name: known.name, role: args.role },
          }
        }
        return {
          kind: 'pending',
          invite: {
            id: fresh('invite'),
            email: args.email.toLowerCase(),
            role: args.role,
            expiresAt: T0,
            replaced: false,
          },
        }
      },
      async setRole(args) {
        rSharing('setRole', args)
        if (args.userId === args.callerUserId) {
          throw new CommandError('conflict', 'You cannot change your own role.')
        }
        const p = permissions.find((x) => x.userId === args.userId)
        if (p === undefined) throw notFound('collaborator', args.userId)
        p.role = args.role
        return { userId: p.userId, email: p.email ?? '', name: p.name, role: args.role }
      },
      async revoke(args) {
        rSharing('revoke', args)
        if (args.userId === args.callerUserId) {
          throw new CommandError('conflict', 'You cannot remove yourself from a deck.')
        }
        const i = permissions.findIndex((x) => x.userId === args.userId)
        if (i === -1) throw notFound('collaborator', args.userId)
        permissions.splice(i, 1)
      },
      async listInvites(args) {
        rSharing('listInvites', args)
        return invites
      },
      async cancelInvite(args) {
        rSharing('cancelInvite', args)
      },
      async listLinks(args) {
        rSharing('listLinks', args)
        return links.filter((l) => !l.revoked)
      },
      async createLink(args) {
        rSharing('createLink', args)
        const id = fresh('link')
        links.push({
          id,
          role: args.role,
          createdAt: T0,
          expiresAt: args.expiresAt ?? null,
          createdBy: args.userId,
          revoked: false,
        })
        return { id, url: `https://narrative.test/deck/${args.deckId}?share_token=${id}` }
      },
      async revokeLink(args) {
        rSharing('revokeLink', args)
        const link = links.find((l) => l.id === args.linkId)
        if (link !== undefined) link.revoked = true
      },
    },

    folderSharing: {
      async listMembers(args) {
        rFolderSharing('listMembers', args)
        return requireFolderOwner(args.folderId, args.userId).members
      },
      async invite(args) {
        rFolderSharing('invite', args)
        const { folder, members } = requireFolderOwner(args.folderId, args.userId)
        if (folder.id === DRAFTS_ID) {
          throw new CommandError(
            'conflict',
            'The Drafts folder is private and cannot be shared. Move the decks to share into another folder.',
          )
        }
        const email = args.email.toLowerCase()
        // Known users: everyone in the fixture's directory (deck collaborators
        // and folder members), as the server looks the address up in `users`.
        const known = [...permissions, ...[...folderMembers.values()].flat()].find(
          (m) => m.email === email,
        )
        if (known !== undefined) {
          if (known.userId === args.userId) {
            throw new CommandError(
              'conflict',
              'You cannot change your own role. Ask another owner to change it for you.',
            )
          }
          const member = members.find((m) => m.userId === known.userId)
          if (member !== undefined) member.role = args.role
          else members.push({ ...known, role: args.role, grantedAt: T0, grantedBy: args.userId })
          return {
            kind: 'granted',
            user: { userId: known.userId, email, name: known.name, role: args.role },
          }
        }
        const pending = folderInvites.get(args.folderId) ?? []
        folderInvites.set(args.folderId, pending)
        const existing = pending.find((i) => i.email === email)
        if (existing !== undefined) existing.role = args.role
        const invite = existing ?? {
          id: fresh('folder_invite'),
          email,
          role: args.role,
          invitedAt: T0,
          expiresAt: T0,
        }
        if (existing === undefined) pending.push(invite)
        return {
          kind: 'pending',
          invite: {
            id: invite.id,
            email,
            role: args.role,
            expiresAt: T0,
            replaced: existing !== undefined,
          },
        }
      },
      async setRole(args) {
        rFolderSharing('setRole', args)
        const { members } = requireFolderOwner(args.folderId, args.userId)
        if (args.memberId === args.userId) {
          throw new CommandError(
            'conflict',
            'You cannot change your own role. Ask another owner to change it for you.',
          )
        }
        const m = requireFolderMember(members, args.memberId)
        if (m.role === 'owner' && args.role !== 'owner') requireAnotherOwner(members, m.userId)
        m.role = args.role
        return { userId: m.userId, email: m.email ?? '', name: m.name, role: args.role }
      },
      async removeMember(args) {
        rFolderSharing('removeMember', args)
        const { members } = requireFolderOwner(args.folderId, args.userId)
        if (args.memberId === args.userId) {
          throw new CommandError(
            'conflict',
            'You cannot remove yourself from a folder. Ask another owner to remove you.',
          )
        }
        const m = requireFolderMember(members, args.memberId)
        if (m.role === 'owner') requireAnotherOwner(members, m.userId)
        members.splice(members.indexOf(m), 1)
      },
      async listInvites(args) {
        rFolderSharing('listInvites', args)
        requireFolderOwner(args.folderId, args.userId)
        return folderInvites.get(args.folderId) ?? []
      },
      async cancelInvite(args) {
        rFolderSharing('cancelInvite', args)
        requireFolderOwner(args.folderId, args.userId)
        const pending = folderInvites.get(args.folderId) ?? []
        const i = pending.findIndex((x) => x.id === args.inviteId)
        if (i === -1) {
          throw new CommandError(
            'not_found',
            'Invite not found (it may have been accepted or cancelled)',
          )
        }
        pending.splice(i, 1)
      },
    },

    media: {
      async upload(args) {
        rMedia('upload', args)
        if ('deckId' in args.owner) requireDeck(args.owner.deckId)
        else requireComponent(args.owner.componentId)
        return {
          assetId: fresh('asset'),
          kind: 'image',
          mimeType: 'image/png',
          sizeBytes: args.source.kind === 'base64' ? 70 : 245_000,
          width: args.source.kind === 'base64' ? 1 : 1600,
          height: args.source.kind === 'base64' ? 1 : 900,
        }
      },
      async openUploadSession(args) {
        rMedia('openUploadSession', args)
        if ('deckId' in args.owner) requireDeck(args.owner.deckId)
        else requireComponent(args.owner.componentId)
        const mimeType =
          args.mimeType ??
          (args.filename.toLowerCase().endsWith('.mp4') ? 'video/mp4' : 'image/png')
        const kind = mimeType.startsWith('video/') ? ('video' as const) : ('image' as const)
        const b64 = (v: string) => Buffer.from(v).toString('base64')
        return {
          url: 'https://narrative.example/api/api/uploads',
          token: `nus_${'x'.repeat(43)}`,
          expiresAt: '2026-01-01T00:15:00.000Z',
          uploadMetadata: `${'deckId' in args.owner ? `deckId ${b64(args.owner.deckId)}` : `componentId ${b64(args.owner.componentId)}`},filename ${b64(args.filename)},content-type ${b64(mimeType)}`,
          kind,
          mimeType,
          sizeBytes: args.sizeBytes,
        }
      },
      async videoInfo(args) {
        rMedia('videoInfo', args)
        if (args.assetId !== 'video_fixture') throw notFound('video', args.assetId)
        return {
          assetId: args.assetId,
          transcodeStatus: 'done',
          durationSec: 12,
          width: 1920,
          height: 1080,
          posterUrl: 'https://img.test/poster.jpg',
          thumbnailUrl: 'https://img.test/thumb.jpg',
          playbackUrl: 'https://storage.test/playback.mp4',
          presentPlayback: null,
          transcodeError: null,
        }
      },
      async url(args) {
        rMedia('url', args)
        if (args.assetId !== 'asset-fixture') throw notFound('asset', args.assetId)
        return { url: `https://img.test/${args.variant}/${args.assetId}.jpg` }
      },
      async fontUrl(args) {
        rMedia('fontUrl', args)
        const face = [...folderFonts.values()].flat().find((f) => f.assetId === args.assetId)
        if (face === undefined) throw notFound('font', args.assetId)
        return {
          assetId: face.assetId,
          url: face.url,
          family: face.family,
          weight: face.weight,
          style: face.style,
          postscriptName: face.postscriptName,
          mimeType: 'font/ttf',
        }
      },
      async delete(args) {
        rMedia('delete', args)
        if (args.assetId !== 'asset-fixture' && args.assetId !== 'video_fixture') {
          throw notFound('asset', args.assetId)
        }
        // A master's picture is handed to its folder; a deck's or a folder's own is deleted (the real service).
        return {
          outcome:
            args.owner !== undefined && 'componentId' in args.owner
              ? ('handedToFolder' as const)
              : ('deleted' as const),
        }
      },
    },

    components: {
      async list(args) {
        rComponents('list', args)
        requireFolder(args.folderId)
        return [...components.values()].filter((c) => c.folderId === args.folderId)
      },
      async create(args) {
        rComponents('create', args)
        requireFolder(args.folderId)
        // The real service's rules (services/componentStaging.ts createEmptyComponent).
        const name = args.name.trim()
        if (name.length > 200) {
          throw new CommandError('invalid_input', 'name too long (max 200)')
        }
        const c: ComponentRecord = {
          id: fresh('cmp'),
          folderId: args.folderId,
          name: name.length > 0 ? name : 'Untitled component',
          thumbnailKey: null,
          thumbnailUrl: null,
          createdAt: T0,
          updatedAt: T0,
        }
        components.set(c.id, c)
        return c
      },
      async rename(args) {
        rComponents('rename', args)
        const c = { ...requireComponent(args.componentId, args.folderId), name: args.name }
        components.set(c.id, c)
        return c
      },
      async delete(args) {
        rComponents('delete', args)
        requireComponent(args.componentId, args.folderId)
        components.delete(args.componentId)
      },
      async readMaster(args) {
        rComponents('readMaster', args)
        const folderId =
          args.deckId !== undefined
            ? (requireDeck(args.deckId).folderId ?? undefined)
            : args.folderId
        return {
          component: requireComponent(args.componentId, folderId),
          state: fixtureComponentState(),
        }
      },
      async promote(args) {
        rComponents('promote', args)
        const folderId = requireDeck(args.deckId).folderId
        if (folderId === null) {
          throw new CommandError(
            'conflict',
            'the deck is in no folder, which is where components live',
          )
        }
        // The fake reads the fixture deck (the one the contract examples
        // target) to refuse a slide or object it does not have, like the
        // real service; the objects become the master with no media to copy.
        const fixture = createFixtureDeck()
        const slide = resolveSlide(fixture, args.slide)
        requireObjects(objectsOf(fixture, slide), args.objects, slide.id)
        const c: ComponentRecord = {
          id: fresh('cmp'),
          folderId,
          name: args.name,
          thumbnailKey: null,
          thumbnailUrl: null,
          createdAt: T0,
          updatedAt: T0,
        }
        components.set(c.id, c)
        return {
          component: c,
          objectCount: args.objects.length,
          mediaCopied: 0,
          skippedImages: 0,
          droppedLinks: 0,
        }
      },
      async prepareStamp(args) {
        rComponents('prepareStamp', args)
        const folderId = requireDeck(args.deckId).folderId ?? undefined
        // The real service's restamp rule (services/components.ts): stamps of
        // a component of another folder are refused as such.
        const own = components.get(args.componentId)
        if (args.purpose === 'restamp' && own !== undefined && own.folderId !== folderId) {
          throw new CommandError(
            'conflict',
            "These stamps come from a component of another folder (the deck moved, or they were copied from a deck there); a deck restamps only its own folder's components",
          )
        }
        // The fixture master shows no pictures: nothing to copy or catch up.
        return {
          master: {
            component: requireComponent(args.componentId, folderId),
            state: fixtureComponentState(),
          },
          mediaRegistered: 0,
          skippedImages: 0,
          async discard() {},
          async settle() {},
        }
      },
      async access(args) {
        rComponents('access', args)
        const c = requireComponent(args.componentId)
        return {
          componentId: c.id,
          folderId: c.folderId,
          role: 'owner',
          documentName: `component:${c.id}`,
        }
      },
    },

    pptx: {
      async importPptx(args) {
        rPptx('importPptx', args)
        requireFolder(args.folderId)
        const id = fresh('deck')
        decks.set(id, {
          ...deckRecord(id, args.title ?? 'Imported deck', args.folderId),
          viewerRole: 'owner',
        })
        return {
          deckId: id,
          slideCount: 3,
          objectsCreated: 17,
          skipped: { images: 0, unknownShapes: 1, fonts: 0 },
          ignoredElements: ['p:custDataLst'],
          slideWidth: 1280,
          slideHeight: 720,
          embeddedFontCount: 0,
          referencedFontFamilies: ['Arial'],
        }
      },
      async prepareInsert(args) {
        rPptx('prepareInsert', args)
        requireDeck(args.deckId)
        let count = 2
        if (args.source.kind === 'deck') {
          requireDeck(args.source.deckId)
          const available = 3
          const chosen = args.source.slideIds
          if (chosen !== undefined) {
            // The fake source deck holds slides s1..s3, like the fixture deck.
            const missing = chosen.find((id) => !['s1', 's2', 's3'].includes(id))
            if (missing !== undefined) {
              throw new CommandError('not_found', `slide '${missing}' is not in the source deck`)
            }
            count = new Set(chosen).size
          } else {
            const from = args.source.range?.from ?? 0
            const to = args.source.range?.to ?? available - 1
            if (from > to || to >= available) {
              throw new CommandError(
                'invalid_input',
                `range ${from}..${to} is outside the source deck`,
              )
            }
            count = to - from + 1
          }
        }
        return {
          slideCount: count,
          apply(deck, at): SlideInsertResult {
            const insertedAt = Math.max(0, Math.min(at ?? deck.slides.length, deck.slides.length))
            const slideIds: string[] = []
            for (let i = 0; i < count; i++) slideIds.push(addSlide(deck, insertedAt + i).id)
            return {
              slideIds,
              insertedAt,
              objectsCreated: 0,
              mediaRegistered: 0,
              skipped: { images: 0, unknownShapes: 0 },
              ignoredElements: [],
            }
          },
          async discard() {
            rPptx('discard', {})
          },
          async settle() {
            rPptx('settle', {})
          },
        }
      },
      async exportPptx(args) {
        rPptx('exportPptx', args)
        requireDeck(args.deckId)
        const base = { filename: 'Fixture deck.pptx', sizeBytes: 4, slideCount: 3 }
        return args.delivery === 'base64'
          ? { delivery: 'base64', ...base, base64: 'UEsDBA==' }
          : {
              delivery: 'url',
              ...base,
              url: 'https://storage.test/exports/deck.pptx?X-Amz-Signature=fixture',
              expiresAt: T0,
            }
      },
    },

    render: {
      async exportPng(args) {
        rRender('exportPng', args)
        const chosen = pickRenderSlides(args.deckId, args.slides)
        const info = chosen.map(({ id, index }) => ({
          slideId: id,
          index,
          width: 1920,
          height: 1080,
          sizeBytes: 68,
          failedLoads: 0,
        }))
        return args.delivery === 'base64'
          ? {
              delivery: 'base64',
              slides: info.map((slide) => ({
                ...slide,
                base64:
                  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
              })),
              failedFonts: [],
            }
          : {
              delivery: 'url',
              slides: info.map((slide) => ({
                ...slide,
                url: `https://storage.test/exports/slide-${slide.index + 1}.png?X-Amz-Signature=fixture`,
              })),
              expiresAt: T0,
              failedFonts: [],
            }
      },
      async startPdfExport(args) {
        rRender('startPdfExport', args)
        // The fixture deck skips none of its slides; a PDF is a page per slide asked for.
        const chosen = pickRenderSlides(args.deckId, args.slides)
        const jobId = `pdf_fixture_${pdfJobs.size + 1}`
        pdfJobs.set(jobId, { deckId: args.deckId, pages: chosen.length, delivery: args.delivery })
        return { jobId, status: 'queued', done: 0, total: chosen.length }
      },
      async pdfExportStatus(args) {
        rRender('pdfExportStatus', args)
        // `pdf_8f2k1c`: a finished job of the world's deck (the command's example).
        const job =
          pdfJobs.get(args.jobId) ??
          (args.jobId === 'pdf_8f2k1c'
            ? {
                deckId: world.deckId,
                pages: pickRenderSlides(world.deckId, 'all').length,
                delivery: 'url' as const,
              }
            : undefined)
        if (job === undefined || job.deckId !== args.deckId)
          throw new CommandError('not_found', `No such PDF export '${args.jobId}'`)
        const base = {
          filename: 'Fixture deck.pdf',
          pages: job.pages,
          leftOut: 0,
          sizeBytes: 2048 * job.pages,
          failedLoads: 0,
          failedFonts: [],
        }
        return {
          jobId: args.jobId,
          status: 'done',
          done: job.pages,
          total: job.pages,
          result:
            job.delivery === 'base64'
              ? { ...base, delivery: 'base64', base64: 'JVBERi0xLjQK' }
              : {
                  ...base,
                  delivery: 'url',
                  url: 'https://storage.test/exports/deck.pdf?X-Amz-Signature=fixture',
                  expiresAt: T0,
                },
        }
      },
      async refreshThumbnail(args) {
        rRender('refreshThumbnail', args)
        if ('componentId' in args.target) {
          if (!components.has(args.target.componentId)) {
            throw notFound('component', args.target.componentId)
          }
          return {
            thumbnailUrl: `https://img.test/insecure/components/${args.target.componentId}/thumb-x.png`,
            updatedAt: T0,
          }
        }
        requireDeck(args.target.deckId)
        if (args.target.deckId !== world.deckId) {
          throw new CommandError('invalid_input', 'The deck has no slides to draw its card from')
        }
        return {
          thumbnailUrl: `https://img.test/insecure/decks/${args.target.deckId}/thumb-x.png?v=1`,
          updatedAt: T0,
        }
      },
      async look(args) {
        rRender('look', args)
        const { view } = args
        // The real service's refusals (services/render.ts stateBeforeRun).
        if ('compare' in view) {
          const before = view.runId === null ? null : runs.stateBefore(view.runId)
          if (before === null) {
            throw new CommandError(
              'invalid_input',
              'Nothing to compare yet: your current run has not changed this deck (or its history is gone)',
            )
          }
          if (before.document.kind !== 'deck' || before.document.deckId !== args.deckId) {
            throw new CommandError(
              'invalid_input',
              'Your current run changed another document, not this deck',
            )
          }
        }
        const chosen = pickRenderSlides(
          args.deckId,
          'sheet' in view ? view.sheet : 'compare' in view ? [view.compare] : [view.slide],
        )
        const mode =
          'sheet' in view
            ? 'sheet'
            : 'compare' in view
              ? 'compare'
              : view.region !== undefined
                ? 'region'
                : 'slide'
        return {
          mode,
          width: mode === 'compare' ? 1568 : 1430,
          height: mode === 'compare' ? 450 : 804,
          slides: chosen.map(({ id, index }) => ({ slideId: id, index, failedLoads: 0 })),
          overflow: [],
          failedFonts: [],
          image: {
            mimeType: 'image/png',
            base64:
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
          },
        }
      },
      async measure(args) {
        rRender('measure', args)
        // As the real service: in sheets, so its limit is the measure's, not one sheet's.
        const ids: readonly string[] = args.deckId === world.deckId ? FIXTURE_SLIDE_IDS : []
        const chosen = (args.slides === 'all' ? ids.map((id) => ({ id })) : args.slides).flatMap(
          (ref) => pickRenderSlides(args.deckId, [ref]),
        )
        if (chosen.length === 0)
          throw new CommandError('invalid_input', 'The deck has no slides to check')
        // The fixture's text fits its boxes; growing boxes are drawn at their stored height.
        return {
          slides: chosen.map(({ id, index }) => ({ slideId: id, index })),
          overflow: [],
          grown: [],
          failedFonts: [],
        }
      },
    },

    stylePacks: {
      async get(args) {
        rStyle('get', args)
        requireFolder(args.folderId)
        return readStylePack(folderDoc(args.folderId)) as StylePack | null
      },
      async set(args) {
        rStyle('set', args)
        requireFolder(args.folderId)
        const pack = parseStylePack(args.pack)
        const doc = folderDoc(args.folderId)
        const previous = readStylePack(doc)
        setStylePack(doc, pack as unknown as Record<string, unknown>)
        return { previous }
      },
      async update(args) {
        rStyle('update', args)
        requireFolder(args.folderId)
        const doc = folderDoc(args.folderId)
        const current = readStylePack(doc)
        if (current === null)
          throw new CommandError('not_found', 'The folder has no style pack; set one first')
        parseStylePack(mergeStylePackPatch(current, args.patch))
        patchStylePack(doc, args.patch)
        return { previous: previousOfUpdate(current, args.patch) }
      },
      async delete(args) {
        rStyle('delete', args)
        requireFolder(args.folderId)
        const doc = folderDoc(args.folderId)
        const previous = readStylePack(doc)
        if (previous !== null) deleteStylePack(doc)
        return { previous }
      },
      async compile(args) {
        rStyle('compile', args)
        requireFolder(args.folderId)
        const doc = folderDoc(args.folderId)
        const pack = readStylePack(doc) as StylePack | null
        if (pack === null)
          throw new CommandError('not_found', 'The folder has no style pack to compile')
        const fonts = (folderFonts.get(args.folderId) ?? []).map((f) => ({
          family: f.family ?? '',
          weight: f.weight ?? 400,
        }))
        const plan = compileStylePack(storedStylePack(pack), {
          tokens: readFolderTokens(doc),
          fonts,
        })
        const counts = {
          colors: { created: 0, updated: 0 },
          textStyles: { created: 0, updated: 0 },
          components: { created: 0, updated: 0 },
        }
        for (const category of ['colors', 'textStyles'] as const) {
          for (const t of plan[category]) {
            const fields = parseNewTokenFields(category, t.fields)
            if (category === 'textStyles') fields['builtin'] = false
            fields['origin'] = t.origin
            if (t.exists) updateFolderToken(doc, category, t.id, fields, { replace: true })
            else addFolderToken(doc, category, t.id, fields)
            counts[category][t.exists ? 'updated' : 'created']++
          }
        }
        for (const c of plan.components) {
          let id = [...packMasters].find(
            ([cid, d]) =>
              components.get(cid)?.folderId === args.folderId &&
              readMasterOrigin(d)?.key === c.origin.key &&
              readMasterOrigin(d)?.pack === c.origin.pack,
          )?.[0]
          if (id === undefined) {
            id = fresh('cmp')
            components.set(id, {
              id,
              folderId: args.folderId,
              name: c.name,
              thumbnailKey: null,
              thumbnailUrl: null,
              createdAt: T0,
              updatedAt: T0,
            })
            packMasters.set(id, new Y.Doc())
            counts.components.created++
          } else counts.components.updated++
          replaceMasterObjects(packMasters.get(id)!, c.objects, c.origin)
        }
        return { ...counts, missingFonts: plan.missingFonts }
      },
    },

    tokens: {
      async usages(args) {
        rTokens('usages', args)
        requireFolder(args.folderId)
        return {
          usages: [
            {
              kind: 'deck',
              deckId: world.deckId,
              deckTitle: 'Fixture deck',
              slideIndex: 0,
              objectId: 'r1',
              field: 'fill',
            },
          ],
        }
      },
      async list(args) {
        rTokens('list', args)
        requireFolder(args.folderId)
        return readFolderTokens(folderDoc(args.folderId))
      },
      async create(args) {
        rTokens('create', args)
        requireFolder(args.folderId)
        const fields = validTokenFields(() => parseNewTokenFields(args.category, args.fields))
        if (args.category === 'textStyles') fields['builtin'] = false
        const doc = folderDoc(args.folderId)
        if (
          args.category === 'colors' &&
          Object.keys(readFolderTokens(doc).colors).length >= MAX_COLORS
        )
          throw new CommandError('conflict', `a folder holds at most ${MAX_COLORS} colours`)
        if (
          args.category === 'textStyles' &&
          textStyleNameTaken(readFolderTokens(doc), String(fields['name']))
        )
          throw new CommandError(
            'conflict',
            `a text style named "${String(fields['name'])}" exists`,
          )
        const tokenId = fresh('tok')
        addFolderToken(doc, args.category, tokenId, fields)
        return { tokenId }
      },
      async update(args) {
        rTokens('update', args)
        requireFolder(args.folderId)
        const patch = validTokenFields(() => parseTokenPatch(args.category, args.patch))
        if (Object.keys(patch).length === 0)
          throw new CommandError('invalid_input', 'Pass at least one field to change')
        const token = requireToken(args.folderId, args.category, args.tokenId) as unknown as Record<
          string,
          unknown
        >
        if (
          args.category === 'textStyles' &&
          typeof patch['name'] === 'string' &&
          textStyleNameTaken(
            readFolderTokens(folderDoc(args.folderId)),
            patch['name'],
            args.tokenId,
          )
        )
          throw new CommandError('conflict', `a text style named "${patch['name']}" exists`)
        const previous = Object.fromEntries(Object.keys(patch).map((k) => [k, token[k] ?? null]))
        updateFolderToken(folderDoc(args.folderId), args.category, args.tokenId, patch)
        // Propagation into the decks is the server's (apps/server services/tokens.ts).
        return { previous, propagated: { decks: 1, components: 0, objects: 1, failed: [] } }
      },
      async delete(args) {
        rTokens('delete', args)
        requireFolder(args.folderId)
        const token = requireToken(args.folderId, args.category, args.tokenId)
        if (args.category === 'textStyles' && (token as { builtin?: boolean }).builtin === true)
          throw new CommandError(
            'conflict',
            `"${token.name}" is one of the folder's built-in text styles and cannot be deleted`,
          )
        deleteFolderToken(folderDoc(args.folderId), args.category, args.tokenId)
        return { deleted: true as const, token: { ...token } }
      },
      async seedDefaults(args) {
        rTokens('seedDefaults', args)
        requireFolder(args.folderId)
        const doc = folderDoc(args.folderId)
        const seeded = seedDefaultTokens(doc, () => fresh('tok'))
        const migrated = migrateFolderTokens(doc)
        return { seeded, migrated }
      },
    },
  }
}
