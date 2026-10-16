/**
 * The server-backed commands (deck, folder, share, media, component, pptx,
 * token): what each handler asks its service for, and the document side of
 * component.stamp / deck.insertFrom. Services are the in-memory fakes of
 * testing/fakeDomainServices.ts; the real services are tested in apps/server.
 */

import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  LOCAL_ORIGIN,
  addObjects,
  createSlideDoc,
  getParagraphDeltas,
  getSlideObjectsCtx,
  listSlides,
} from '@narrative/slide-model'
import { stampMaster } from './components.js'
import { createDefaultRegistry } from '../catalog.js'
import { runCommand } from '../run.js'
import { CommandError } from '../errors.js'
import { createFixtureDeck } from '../testing/fixtureDeck.js'
import {
  FIXTURE_DECK_ID,
  FIXTURE_FOLDER_ID,
  createFakeServices,
  type FakeServices,
} from '../testing/fakeServices.js'
import type { CommandContext, Role } from '../types.js'

const registry = createDefaultRegistry()

function ctx(overrides: Partial<CommandContext> = {}): CommandContext & { services: FakeServices } {
  return {
    actor: { userId: 'u1', role: 'owner', kind: 'agent' },
    host: 'server',
    origin: LOCAL_ORIGIN,
    deck: createFixtureDeck(),
    target: { deckId: FIXTURE_DECK_ID, folderId: FIXTURE_FOLDER_ID },
    services: createFakeServices(),
    ...overrides,
  } as CommandContext & { services: FakeServices }
}

async function failure(p: Promise<unknown>): Promise<CommandError> {
  try {
    await p
  } catch (e) {
    if (e instanceof CommandError) return e
    throw e
  }
  throw new Error('expected a CommandError')
}

function callsTo(c: { services: FakeServices }, service: string) {
  return c.services.calls.filter((x) => x.service === service)
}

describe('server command metadata', () => {
  const serverCommands = registry.list().filter((d) => d.effects.includes('server'))

  it('run only on the server host and never in an atomic batch', () => {
    for (const def of serverCommands) {
      expect(def.hosts, def.id).toEqual(['server'])
    }
  })

  it('ask before every irreversible change (share, delete, move)', () => {
    const mustConfirm = [
      'deck.delete',
      'deck.moveToFolder',
      'folder.delete',
      'folder.fonts.delete',
      'media.delete',
      'component.delete',
      'share.permissions.invite',
      'share.permissions.setRole',
      'share.permissions.revoke',
      'share.invites.cancel',
      'share.links.create',
      'share.links.revoke',
      'folder.members.invite',
      'folder.members.setRole',
      'folder.members.remove',
      'folder.invites.cancel',
    ]
    for (const id of mustConfirm) {
      const def = registry.get(id)!
      expect(def.undo, id).toBe('irreversible')
      expect(def.confirm, id).toBe('always')
    }
  })

  it('take the deck / folder from the target, never from the input', () => {
    for (const def of serverCommands) {
      const shape = (def.input as { shape?: Record<string, unknown> }).shape
      if (shape === undefined) continue
      if ((def.scope ?? 'deck') === 'deck')
        expect(Object.keys(shape), def.id).not.toContain('deckId')
      if (def.scope === 'folder') expect(Object.keys(shape), def.id).not.toContain('folderId')
    }
  })
})

describe('deck.*', () => {
  it('deck.create trims the title and returns the first slide to edit', async () => {
    const { target: _target, ...noTarget } = ctx()
    const c = noTarget as ReturnType<typeof ctx>
    const out = (await runCommand(registry, c, 'deck.create', { title: '  Pitch  ' })) as {
      id: string
      firstSlideId: string
    }
    expect(out.firstSlideId).toMatch(/^slide_/)
    expect(callsTo(c, 'decks')[0]?.args).toEqual({
      userId: 'u1',
      title: 'Pitch',
      folderId: undefined,
    })
  })

  it('deck.rename refuses a blank title before calling the service', async () => {
    const c = ctx()
    const err = await failure(runCommand(registry, c, 'deck.rename', { title: '   ' }))
    expect(err.code).toBe('invalid_input')
    expect(callsTo(c, 'decks')).toEqual([])
  })

  it('deck.moveToFolder moves the target deck under the invocation origin and reports the media and the rebinding', async () => {
    const origin = { run: 'r1' }
    const c = ctx({ origin })
    const out = await runCommand(registry, c, 'deck.moveToFolder', { folderId: 'folder_b' })
    expect(out).toEqual({
      moved: true,
      media: { copied: 1, unresolved: 0, copyFailed: 0 },
      tokens: { rebound: 3, literalised: 1, detached: 0, unmatched: 0 },
    })
    expect(callsTo(c, 'decks')[0]).toEqual({
      service: 'decks',
      method: 'moveDeck',
      args: { userId: 'u1', deckId: FIXTURE_DECK_ID, destFolderId: 'folder_b', origin },
    })
  })

  it('deck-scoped commands refuse a component master as the target', async () => {
    const c = ctx({ target: { componentId: 'cmp_headline' } })
    const err = await failure(runCommand(registry, c, 'deck.get', {}))
    expect(err.code).toBe('no_target')
  })

  it('folder-scoped commands need a folder', async () => {
    const c = ctx({ target: { deckId: FIXTURE_DECK_ID } })
    const err = await failure(runCommand(registry, c, 'deck.activeEditors', {}))
    expect(err.code).toBe('no_target')
  })
})

describe('query.render', () => {
  it('asks the render service for a slide, a region of it, or a sheet', async () => {
    const c = ctx()
    await runCommand(registry, c, 'query.render', { slide: { index: 1 } })
    await runCommand(registry, c, 'query.render', {
      slide: 's1',
      region: { x: 0, y: 900, width: 1920, height: 180 },
    })
    await runCommand(registry, c, 'query.render', { slides: 'all' })
    expect(callsTo(c, 'render').map((x) => (x.args as { view: unknown }).view)).toEqual([
      { slide: { index: 1 } },
      { slide: { id: 's1' }, region: { x: 0, y: 900, width: 1920, height: 180 } },
      { sheet: 'all' },
    ])
  })

  it('compares a slide with how it was before the session’s current run, and says when there is none', async () => {
    const inRun = ctx({ run: { runId: 'run_fixture', surface: 'mcp' } })
    const out = await runCommand(registry, inRun, 'query.render', {
      slide: { index: 0 },
      compare: 'before',
    })
    expect(callsTo(inRun, 'render')[0]?.args).toMatchObject({
      view: { compare: { index: 0 }, runId: 'run_fixture' },
    })
    expect(out).toMatchObject({ mode: 'compare', overflow: [] })
    const noRun = ctx()
    const err = await failure(
      runCommand(registry, noRun, 'query.render', { slide: { index: 0 }, compare: 'before' }),
    )
    expect(err.code).toBe('invalid_input')
    expect(err.message).toMatch(/Nothing to compare/)
  })

  it('refuses slide with slides, region without slide, and nothing at all, before calling the service', async () => {
    const c = ctx()
    for (const input of [
      { slide: 's1', slides: 'all' },
      { slides: 'all', region: { x: 0, y: 0, width: 10, height: 10 } },
      {},
      { slide: 's1', region: { x: 0, y: 0, width: 5000, height: 10 } },
      { slides: 'all', compare: 'before' },
      { slide: 's1', region: { x: 0, y: 0, width: 10, height: 10 }, compare: 'before' },
    ]) {
      expect((await failure(runCommand(registry, c, 'query.render', input))).code).toBe(
        'invalid_input',
      )
    }
    expect(callsTo(c, 'render')).toEqual([])
  })
})

describe('deck.refreshThumbnail', () => {
  it('asks the render service to redraw the target deck’s card and returns its URL', async () => {
    const c = ctx()
    const out = await runCommand(registry, c, 'deck.refreshThumbnail', {})
    expect(callsTo(c, 'render')).toEqual([
      expect.objectContaining({
        method: 'refreshThumbnail',
        args: { userId: 'u1', target: { deckId: FIXTURE_DECK_ID } },
      }),
    ])
    expect(out).toEqual({
      thumbnailUrl: expect.stringContaining('thumb'),
      updatedAt: expect.any(String),
    })
  })

  it('redraws a component master’s card when the target is the master', async () => {
    const c = ctx({ target: { componentId: 'cmp_headline', folderId: FIXTURE_FOLDER_ID } })
    const out = await runCommand(registry, c, 'deck.refreshThumbnail', {})
    expect(callsTo(c, 'render')[0]?.args).toEqual({
      userId: 'u1',
      target: { componentId: 'cmp_headline' },
    })
    expect(out).toMatchObject({ thumbnailUrl: expect.stringContaining('components/cmp_headline/') })
  })

  it('refuses a deck without slides, a viewer and any input', async () => {
    const empty = await failure(
      runCommand(
        registry,
        ctx({ target: { deckId: 'deck_other', folderId: 'folder_b' } }),
        'deck.refreshThumbnail',
        {},
      ),
    )
    expect(empty.code).toBe('invalid_input')
    const viewer = ctx({ actor: { userId: 'u1', role: 'viewer', kind: 'agent' } })
    expect((await failure(runCommand(registry, viewer, 'deck.refreshThumbnail', {}))).code).toBe(
      'forbidden',
    )
    expect(
      (await failure(runCommand(registry, ctx(), 'deck.refreshThumbnail', { slide: 1 }))).code,
    ).toBe('invalid_input')
  })
})

describe('media.* and share.*', () => {
  it('media commands pin the asset to the target deck (no reaching into another deck)', async () => {
    const c = ctx()
    await runCommand(registry, c, 'media.url', { assetId: 'asset-fixture' })
    expect(callsTo(c, 'media')[0]?.args).toEqual({
      userId: 'u1',
      assetId: 'asset-fixture',
      variant: 'display',
      owner: { deckId: FIXTURE_DECK_ID },
    })
  })

  it('opens an upload session for a component master when it is the target', async () => {
    const c = ctx({ target: { componentId: 'cmp_headline' } })
    const out = (await runCommand(registry, c, 'media.uploadSession', {
      filename: 'badge.png',
      sizeBytes: 1800,
    })) as { headers: Record<string, string> }
    expect((callsTo(c, 'media')[0]?.args as { owner: unknown }).owner).toEqual({
      componentId: 'cmp_headline',
    })
    expect(out.headers['Upload-Metadata']).toContain(
      `componentId ${Buffer.from('cmp_headline').toString('base64')}`,
    )
  })

  it("targeting a component master, media commands act on the component's media", async () => {
    const c = ctx({ target: { componentId: 'cmp_headline' } })
    await runCommand(registry, c, 'media.upload', {
      file: { url: 'https://example.com/logo.png' },
    })
    await runCommand(registry, c, 'media.url', { assetId: 'asset-fixture' })
    expect(callsTo(c, 'media').map((x) => (x.args as { owner: unknown }).owner)).toEqual([
      { componentId: 'cmp_headline' },
      { componentId: 'cmp_headline' },
    ])
  })

  it('media.delete says what happened, with the role each target needs', async () => {
    const editor = { userId: 'u1', role: 'editor' as const, kind: 'agent' as const }
    // A deck's own asset: its owner deletes it.
    const onDeck = ctx()
    expect(
      await runCommand(registry, onDeck, 'media.delete', { assetId: 'asset-fixture' }),
    ).toEqual({ outcome: 'deleted' })
    expect((callsTo(onDeck, 'media')[0]?.args as { owner: unknown }).owner).toEqual({
      deckId: FIXTURE_DECK_ID,
    })
    const deckEditor = ctx({ actor: editor })
    expect(
      (
        await failure(
          runCommand(registry, deckEditor, 'media.delete', { assetId: 'asset-fixture' }),
        )
      ).code,
    ).toBe('forbidden')
    // A master's picture: a folder editor hands it to the folder.
    const onMaster = ctx({ actor: editor, target: { componentId: 'cmp_headline' } })
    expect(
      await runCommand(registry, onMaster, 'media.delete', { assetId: 'asset-fixture' }),
    ).toEqual({ outcome: 'handedToFolder' })
    // A folder's own picture: only its owner deletes it.
    const { deck: _deck, ...folderCtx } = ctx({ target: { folderId: FIXTURE_FOLDER_ID } })
    expect(
      await runCommand(registry, folderCtx, 'media.delete', { assetId: 'asset-fixture' }),
    ).toEqual({ outcome: 'deleted' })
    expect((callsTo(folderCtx, 'media')[0]?.args as { owner: unknown }).owner).toEqual({
      folderId: FIXTURE_FOLDER_ID,
    })
    const { deck: _d, ...folderEditor } = ctx({
      actor: editor,
      target: { folderId: FIXTURE_FOLDER_ID },
    })
    expect(
      (
        await failure(
          runCommand(registry, folderEditor, 'media.delete', { assetId: 'asset-fixture' }),
        )
      ).code,
    ).toBe('forbidden')
  })

  it('media.upload turns a URL input into a url source', async () => {
    const c = ctx()
    await runCommand(registry, c, 'media.upload', {
      file: { url: 'https://example.com/a.jpg', filename: 'a.jpg' },
    })
    expect(callsTo(c, 'media')[0]?.args).toEqual({
      userId: 'u1',
      owner: { deckId: FIXTURE_DECK_ID },
      source: { kind: 'url', url: 'https://example.com/a.jpg', filename: 'a.jpg' },
    })
  })

  it('refuses non-http URLs at the schema', async () => {
    const c = ctx()
    const err = await failure(
      runCommand(registry, c, 'media.upload', { file: { url: 'file:///etc/passwd' } }),
    )
    expect(err.code).toBe('invalid_input')
    expect(callsTo(c, 'media')).toEqual([])
  })

  it('share.permissions.invite invites as the calling user', async () => {
    const c = ctx()
    const out = await runCommand(registry, c, 'share.permissions.invite', {
      email: 'new@example.com',
      role: 'viewer',
    })
    expect(out).toMatchObject({ kind: 'pending', invite: { email: 'new@example.com' } })
    expect(callsTo(c, 'sharing')[0]?.args).toEqual({
      deckId: FIXTURE_DECK_ID,
      inviterUserId: 'u1',
      email: 'new@example.com',
      role: 'viewer',
    })
  })

  it('needs the owner role for sharing', async () => {
    const c = ctx({ actor: { userId: 'u1', role: 'editor', kind: 'agent' } })
    const err = await failure(runCommand(registry, c, 'share.links.list', {}))
    expect(err.code).toBe('forbidden')
  })
})

describe('folder-scoped roles (folder sharing, step 4)', () => {
  const as = (role: 'viewer' | 'editor' | 'owner') =>
    ctx({
      target: { folderId: FIXTURE_FOLDER_ID },
      actor: { userId: 'u1', role, kind: 'agent' },
    })

  it("lets every member read the folder's components, tokens and fonts", async () => {
    for (const id of ['component.list', 'token.list', 'folder.fonts.list', 'deck.activeEditors']) {
      await expect(runCommand(registry, as('viewer'), id, {}), id).resolves.toBeDefined()
    }
  })

  it('lets editors change them, and keeps renaming, deleting and sharing the folder for owners', async () => {
    const viewerWrite = await failure(
      runCommand(registry, as('viewer'), 'token.create', {
        category: 'colors',
        name: 'Accent',
        value: '#ff0000',
      }),
    )
    expect(viewerWrite.code).toBe('forbidden')
    await expect(
      runCommand(registry, as('editor'), 'token.create', {
        category: 'colors',
        name: 'Accent',
        value: '#ff0000',
      }),
    ).resolves.toBeDefined()
    for (const [id, input] of [
      ['folder.rename', { name: 'Renamed' }],
      ['folder.delete', {}],
      ['folder.members.list', {}],
    ] as const) {
      const err = await failure(runCommand(registry, as('editor'), id, input))
      expect(err.code, id).toBe('forbidden')
    }
  })
})

describe('every folder-scoped command', () => {
  // Each one's role (and whether a guest of one of the folder's decks may read
  // it, `folderReaders`) is decided here, on purpose: a new folder-scoped
  // command fails this table until someone decides who may run it. Reads are
  // for any member, writes for editors, the folder itself for its owners.
  const ROLES: Record<string, { role: Role; folderReaders?: 'content' }> = {
    'component.list': { role: 'viewer' },
    'component.get': { role: 'viewer' },
    'component.rename': { role: 'editor' },
    'component.create': { role: 'editor' },
    'component.delete': { role: 'editor' },
    'deck.activeEditors': { role: 'viewer' },
    'deck.importPptx': { role: 'editor' },
    'folder.rename': { role: 'owner' },
    'folder.delete': { role: 'owner' },
    'folder.fonts.list': { role: 'viewer', folderReaders: 'content' },
    'folder.fonts.upload': { role: 'editor' },
    'folder.fonts.delete': { role: 'editor' },
    'folder.members.list': { role: 'owner' },
    'folder.members.invite': { role: 'owner' },
    'folder.members.setRole': { role: 'owner' },
    'folder.members.remove': { role: 'owner' },
    'folder.invites.list': { role: 'owner' },
    'folder.invites.cancel': { role: 'owner' },
    'media.fontUrl': { role: 'viewer', folderReaders: 'content' },
    'token.list': { role: 'viewer', folderReaders: 'content' },
    'style.pack.get': { role: 'viewer', folderReaders: 'content' },
    'style.pack.edit': { role: 'editor' },
    'token.usages': { role: 'viewer' },
    'token.create': { role: 'editor' },
    'token.update': { role: 'editor' },
    'token.delete': { role: 'editor' },
    'token.seedDefaults': { role: 'editor' },
  }
  const folderScoped = registry.list().filter((def) => def.scope === 'folder')

  it('has the role decided for it', () => {
    expect(
      Object.fromEntries(
        folderScoped.map((def) => [
          def.id,
          { role: def.role, ...(def.folderReaders ? { folderReaders: def.folderReaders } : {}) },
        ]),
      ),
    ).toEqual(ROLES)
  })

  it('refuses the role below the one it needs, before it runs', async () => {
    const below: Record<Role, Role | null> = { viewer: null, editor: 'viewer', owner: 'editor' }
    for (const def of folderScoped) {
      const lower = below[def.role]
      if (lower === null) continue
      const err = await failure(
        runCommand(
          registry,
          ctx({
            target: { folderId: FIXTURE_FOLDER_ID },
            actor: { userId: 'u1', role: lower, kind: 'agent' },
          }),
          def.id,
          def.examples[0]!.input,
        ),
      )
      expect(err.code, def.id).toBe('forbidden')
    }
  })

  it('says in its description who may run it — and nothing it does not do', () => {
    const says: Record<Role, RegExp> = {
      viewer: /Any member of the folder/,
      editor: /Needs the editor role in the folder/,
      owner: /Only the folder's owners/,
    }
    for (const def of folderScoped) {
      for (const [role, sentence] of Object.entries(says))
        expect(sentence.test(def.description), `${def.id}: ${sentence}`).toBe(role === def.role)
      expect(
        /anyone with access to one of its decks/.test(def.description),
        `${def.id}: deck guests`,
      ).toBe(def.folderReaders === 'content')
    }
  })

  it('pins the folder role of the deck commands that also take a folder', () => {
    // Deck-scoped, but `acceptsFolder` reaches a folder through the same
    // member check: media.delete removes a folder's own picture for its owner.
    expect(
      Object.fromEntries(
        registry
          .list()
          .filter((def) => def.acceptsFolder === true)
          .map((def) => [def.id, def.roleOn?.folder ?? def.role]),
      ),
    ).toEqual({ 'media.delete': 'owner' })
  })
})

describe('folder.members.* / folder.invites.*', () => {
  const inFolder = (over: Partial<CommandContext> = {}) =>
    ctx({ target: { folderId: FIXTURE_FOLDER_ID }, ...over })

  it('invites as the calling user, into the target folder', async () => {
    const c = inFolder()
    const out = await runCommand(registry, c, 'folder.members.invite', {
      email: 'New.Client@example.com',
      role: 'viewer',
    })
    expect(out).toMatchObject({
      kind: 'pending',
      invite: { email: 'new.client@example.com', role: 'viewer', replaced: false },
    })
    expect(callsTo(c, 'folderSharing')[0]?.args).toEqual({
      userId: 'u1',
      folderId: FIXTURE_FOLDER_ID,
      email: 'New.Client@example.com',
      role: 'viewer',
    })
  })

  it('refuses the Drafts folder, your own role and the last owner', async () => {
    const drafts = await failure(
      runCommand(
        registry,
        ctx({ target: { folderId: 'folder_drafts' } }),
        'folder.members.invite',
        {
          email: 'jana@example.com',
          role: 'viewer',
        },
      ),
    )
    expect(drafts.code).toBe('conflict')
    expect(drafts.message).toMatch(/Drafts/)

    const self = await failure(
      runCommand(registry, inFolder(), 'folder.members.setRole', { userId: 'u1', role: 'viewer' }),
    )
    expect(self.code).toBe('conflict')

    const removeSelf = await failure(
      runCommand(registry, inFolder(), 'folder.members.remove', { userId: 'u1' }),
    )
    expect(removeSelf.code).toBe('conflict')
  })

  it('changes and removes another member', async () => {
    const c = inFolder()
    await expect(
      runCommand(registry, c, 'folder.members.setRole', { userId: 'user_jana', role: 'viewer' }),
    ).resolves.toMatchObject({ userId: 'user_jana', role: 'viewer' })
    await expect(
      runCommand(registry, c, 'folder.members.remove', { userId: 'user_jana' }),
    ).resolves.toEqual({ removed: true })
    const err = await failure(
      runCommand(registry, c, 'folder.members.remove', { userId: 'user_jana' }),
    )
    expect(err.code).toBe('not_found')
  })

  it('cancels a pending invite once', async () => {
    const c = inFolder()
    await expect(
      runCommand(registry, c, 'folder.invites.cancel', { inviteId: 'folder_invite_fixture' }),
    ).resolves.toEqual({ cancelled: true })
    const err = await failure(
      runCommand(registry, c, 'folder.invites.cancel', { inviteId: 'folder_invite_fixture' }),
    )
    expect(err.code).toBe('not_found')
  })

  it('needs the owner role in the folder', async () => {
    const c = inFolder({ actor: { userId: 'u1', role: 'editor', kind: 'agent' } })
    const err = await failure(runCommand(registry, c, 'folder.members.list', {}))
    expect(err.code).toBe('forbidden')
  })
})

describe('component.get', () => {
  it('returns the master with its slot map and bounds', async () => {
    const out = (await runCommand(registry, ctx(), 'component.get', {
      componentId: 'cmp_headline',
    })) as {
      slots: Array<{ name: string; type: string; text?: string }>
      bounds: { x: number; y: number }
      objects: unknown[]
    }
    expect(out.slots).toEqual([
      { name: 'title', objectId: 'm_title', type: 'text', text: 'Headline' },
      { name: 'subtitle', objectId: 'm_subtitle', type: 'text', text: 'Subline' },
    ])
    expect(out.bounds).toMatchObject({ x: 120, y: 60 })
    expect(out.objects).toHaveLength(3)
  })
})

describe('component.stamp', () => {
  function objectsOn(c: CommandContext, slideId: string) {
    return getSlideObjectsCtx(c.deck!, slideId)!.objects.toArray()
  }

  it('stamps the master where it was drawn and fills text slots, keeping their formatting', async () => {
    const c = ctx({ actor: { userId: 'u1', role: 'editor', kind: 'agent' } })
    const before = objectsOn(c, 's2').length
    const out = (await runCommand(registry, c, 'component.stamp', {
      componentId: 'cmp_headline',
      slide: 's2',
      slots: { title: 'Q3 results', subtitle: 'Revenue up\n\nCosts flat' },
    })) as { objectIds: string[]; filledSlots: string[]; at: { x: number; y: number } }

    expect(out.objectIds).toHaveLength(3)
    expect(out.filledSlots.sort()).toEqual(['subtitle', 'title'])
    expect(out.at).toEqual({ x: 120, y: 60 })
    const objects = objectsOn(c, 's2')
    expect(objects).toHaveLength(before + 3)

    const byId = new Map(objects.map((m) => [m.get('id') as string, m]))
    const title = byId.get(out.objectIds[1]!)!
    expect(title.get('name')).toBe('title')
    const titleText = title.get('text') as Y.Text
    expect(titleText.toString()).toBe('Q3 results')
    // The master's bold survives the fill.
    expect(getParagraphDeltas(titleText)[0]!.ops).toEqual([
      { insert: 'Q3 results', attributes: { fontWeight: 700 } },
    ])
    const subtitle = byId.get(out.objectIds[2]!)!.get('text') as Y.Text
    expect(getParagraphDeltas(subtitle).map((p) => p.ops.map((o) => o.insert).join(''))).toEqual([
      'Revenue up',
      'Costs flat',
    ])
    // Fresh ids, never the master's.
    expect(out.objectIds).not.toContain('m_title')
  })

  it('moves the stamp to `at`', async () => {
    const c = ctx()
    const out = (await runCommand(registry, c, 'component.stamp', {
      componentId: 'cmp_headline',
      slide: { index: 2 },
      at: { x: 500, y: 400 },
    })) as { objectIds: string[] }
    const bar = objectsOn(c, 's3').find((m) => m.get('id') === out.objectIds[0])!
    expect([bar.get('x'), bar.get('y')]).toEqual([500, 400])
  })

  it('refuses an unknown slot without touching the document', async () => {
    const c = ctx()
    const before = Y.encodeStateVector(c.deck!.doc)
    const err = await failure(
      runCommand(registry, c, 'component.stamp', {
        componentId: 'cmp_headline',
        slide: 's1',
        slots: { heading: 'x' },
      }),
    )
    expect(err.code).toBe('invalid_input')
    expect(err.message).toContain("'title'")
    expect(Y.encodeStateVector(c.deck!.doc)).toEqual(before)
  })

  it('cannot run inside an atomic batch (it loads the master first)', async () => {
    const c = ctx()
    const err = await failure(
      runCommand(registry, c, 'ops.apply', {
        ops: [{ command: 'component.stamp', input: { componentId: 'cmp_headline', slide: 's1' } }],
      }),
    )
    expect(err.code).toBe('not_batchable')
  })
})

describe('component provenance and slots (A4.1)', () => {
  it('stamp records the component on every copy and fills slots by `slot` before `name`', () => {
    const master = createSlideDoc()
    const masterSlide = master.slides.get(0).get('id') as string
    addObjects(getSlideObjectsCtx(master, masterSlide)!, [
      {
        id: 'm_head',
        type: 'text',
        name: 'Big headline',
        slot: 'title',
        role: 'title',
        x: 100,
        y: 100,
        width: 800,
        height: 80,
        text: 'Headline',
        fontSize: 48,
        fontWeight: 'normal',
        color: 0x111111,
        align: 'left',
        rotation: 0,
        opacity: 1,
      },
    ])
    const deck = createFixtureDeck()
    const out = stampMaster(
      deck,
      {
        component: {
          id: 'cmp_x',
          folderId: FIXTURE_FOLDER_ID,
          name: 'X',
          thumbnailKey: null,
          thumbnailUrl: null,
          createdAt: '',
          updatedAt: '',
        },
        state: Y.encodeStateAsUpdate(master.doc),
      },
      { componentId: 'cmp_x', slide: 's3', slots: { title: 'Filled' } },
    )
    expect(out.filledSlots).toEqual(['title'])
    const copy = getSlideObjectsCtx(deck, 's3')!.objects.get(0)
    expect((copy.get('text') as Y.Text).toString()).toBe('Filled')
    expect(copy.get('slot')).toBe('title')
    expect(copy.get('role')).toBe('title')
    expect(copy.get('component')).toMatchObject({
      id: 'cmp_x',
      objectId: 'm_head',
      origin: { x: 100, y: 100 },
    })
  })

  it('object.update sets and clears slot, role and component', async () => {
    const c = ctx()
    await runCommand(registry, c, 'object.update', {
      slide: 's1',
      object: 't1',
      patch: { slot: 'title', role: 'title' },
    })
    const t1 = () => getSlideObjectsCtx(c.deck!, 's1')!.objects.toArray()[2]!
    expect([t1().get('slot'), t1().get('role')]).toEqual(['title', 'title'])
    await runCommand(registry, c, 'object.update', {
      slide: 's1',
      object: 't1',
      patch: { slot: null, role: null },
    })
    expect([t1().get('slot'), t1().get('role')]).toEqual([undefined, undefined])
    const err = await failure(
      runCommand(registry, c, 'object.update', {
        slide: 's1',
        object: 't1',
        patch: { role: 'headline' },
      }),
    )
    expect(err.code).toBe('invalid_input')
  })

  it("refuses a stamp link on a component master's objects", async () => {
    const c = ctx({ target: { componentId: 'cmp_headline', folderId: FIXTURE_FOLDER_ID } })
    const err = await failure(
      runCommand(registry, c, 'object.update', {
        slide: 's1',
        object: 'r1',
        patch: {
          component: { id: 'cmp_x', objectId: 'm1', instance: 'i1', origin: { x: 0, y: 0 } },
        },
      }),
    )
    expect(err.code).toBe('invalid_input')
  })

  it('object.insert keeps a pasted stamp linked with a fresh instance; on a master it drops the link', async () => {
    const read = (await runCommand(registry, ctx(), 'query.slide', { slide: 's2' })) as {
      objects: Array<Record<string, unknown>>
    }
    const stamp = read.objects.filter((o) => o['component'] !== undefined)
    expect(stamp).toHaveLength(3)

    const c = ctx()
    const { objectIds } = (await runCommand(registry, c, 'object.insert', {
      slide: 's3',
      objects: stamp,
    })) as { objectIds: string[] }
    const pasted = getSlideObjectsCtx(c.deck!, 's3')!
      .objects.toArray()
      .filter((m) => objectIds.includes(m.get('id') as string))
      .map((m) => m.get('component') as { instance: string; objectId: string })
    expect(pasted.map((p) => p.objectId)).toEqual(['m_bar', 'm_title', 'm_old'])
    expect(new Set(pasted.map((p) => p.instance)).size).toBe(1)
    expect(pasted[0]!.instance).not.toBe('stamp_headline')

    const onMaster = ctx({ target: { componentId: 'cmp_headline', folderId: FIXTURE_FOLDER_ID } })
    const second = (await runCommand(registry, onMaster, 'object.insert', {
      slide: 's3',
      objects: stamp,
    })) as { objectIds: string[] }
    const onMasterObjects = getSlideObjectsCtx(onMaster.deck!, 's3')!.objects.toArray()
    for (const m of onMasterObjects.filter((x) => second.objectIds.includes(x.get('id') as string)))
      expect(m.get('component')).toBeUndefined()
  })
})

describe('component.create', () => {
  const inFolder = () => ctx({ target: { folderId: FIXTURE_FOLDER_ID } })

  it('makes an empty component in the target folder', async () => {
    const c = inFolder()
    const out = (await runCommand(registry, c, 'component.create', { name: '  Pagination ' })) as {
      id: string
      folderId: string
      name: string
    }
    expect(out).toMatchObject({ folderId: FIXTURE_FOLDER_ID, name: 'Pagination' })
    const listed = (await runCommand(registry, c, 'component.list', {})) as {
      components: Array<{ id: string }>
    }
    expect(listed.components.map((x) => x.id)).toContain(out.id)
  })

  it('names a blank one "Untitled component", refuses a name too long and a viewer', async () => {
    const blank = (await runCommand(registry, inFolder(), 'component.create', { name: ' ' })) as {
      name: string
    }
    expect(blank.name).toBe('Untitled component')
    const long = await failure(
      runCommand(registry, inFolder(), 'component.create', { name: ` ${'x'.repeat(201)} ` }),
    )
    expect(long.code).toBe('invalid_input')
    const viewer = ctx({
      target: { folderId: FIXTURE_FOLDER_ID },
      actor: { userId: 'u1', role: 'viewer', kind: 'agent' },
    })
    const refused = await failure(runCommand(registry, viewer, 'component.create', { name: 'X' }))
    expect(refused.code).toBe('forbidden')
  })
})

describe('component.restamp', () => {
  function objectsOn(c: CommandContext, slideId: string) {
    return getSlideObjectsCtx(c.deck!, slideId)!.objects.toArray()
  }

  it('updates the stamp in place, adds what the master gained and removes what it lost', async () => {
    const c = ctx({ actor: { userId: 'u1', role: 'editor', kind: 'agent' } })
    const out = (await runCommand(registry, c, 'component.restamp', {
      componentId: 'cmp_headline',
    })) as {
      slides: Array<{
        slide: string
        stamps: number
        updated: string[]
        added: string[]
        removed: string[]
      }>
    }
    expect(out.slides).toHaveLength(1)
    const [s2] = out.slides
    expect(s2).toMatchObject({
      slide: 's2',
      stamps: 1,
      updated: ['st_bar', 'st_title'],
      removed: ['st_old'],
    })
    expect(s2!.added).toHaveLength(1)

    const objects = objectsOn(c, 's2')
    const ids = objects.map((m) => m.get('id'))
    // The subtitle lands right above the title, as in the master.
    expect(ids.slice(-3)).toEqual(['st_bar', 'st_title', s2!.added[0]])
    const title = objects.find((m) => m.get('id') === 'st_title')!
    // The slot keeps its text and takes the master's formatting (bold), at the stamp's offset.
    expect(getParagraphDeltas(title.get('text') as Y.Text)[0]!.ops).toEqual([
      { insert: 'Q3 revenue', attributes: { fontWeight: 700 } },
    ])
    expect([title.get('x'), title.get('y')]).toEqual([720, 610])
    const subtitle = objects.find((m) => m.get('id') === s2!.added[0])!
    expect((subtitle.get('text') as Y.Text).toString()).toBe('Subline')
    expect([subtitle.get('x'), subtitle.get('y')]).toEqual([720, 710])
    expect(subtitle.get('component')).toMatchObject({
      id: 'cmp_headline',
      objectId: 'm_subtitle',
      instance: 'stamp_headline',
    })
    const [load] = callsTo(c, 'components').filter((x) => x.method === 'prepareStamp')
    expect(load?.args).toMatchObject({ componentId: 'cmp_headline', deckId: FIXTURE_DECK_ID })
  })

  it('restamps one slide only, and a slide without stamps is a no-op', async () => {
    const c = ctx()
    const before = listSlides(c.deck!)
    const out = (await runCommand(registry, c, 'component.restamp', {
      componentId: 'cmp_headline',
      slide: 's1',
    })) as { slides: unknown[] }
    expect(out.slides).toEqual([])
    expect(listSlides(c.deck!)).toEqual(before)
  })

  it("refuses stamps of another folder's component as such", async () => {
    const c = ctx({ target: { deckId: 'deck_other', folderId: 'folder_b' } })
    const before = Y.encodeStateVector(c.deck!.doc)
    const err = await failure(
      runCommand(registry, c, 'component.restamp', { componentId: 'cmp_headline' }),
    )
    expect(err.code).toBe('conflict')
    expect(err.message).toContain('another folder')
    expect(Y.encodeStateVector(c.deck!.doc)).toEqual(before)
  })

  it('refuses an unknown slide without touching the document', async () => {
    const c = ctx()
    const before = Y.encodeStateVector(c.deck!.doc)
    const err = await failure(
      runCommand(registry, c, 'component.restamp', { componentId: 'cmp_headline', slide: 'nope' }),
    )
    expect(err.code).toBe('not_found')
    expect(Y.encodeStateVector(c.deck!.doc)).toEqual(before)
  })
})

describe('media.uploadSession', () => {
  it('hands back a one-request curl upload for the named file', async () => {
    const c = ctx()
    const out = (await runCommand(registry, c, 'media.uploadSession', {
      filename: "team photo's.png",
      sizeBytes: 48213,
    })) as { curl: string; headers: Record<string, string>; url: string; kind: string }
    expect(out.kind).toBe('image')
    expect(out.headers['Authorization']).toMatch(/^Bearer nus_/)
    expect(out.headers['Tus-Resumable']).toBe('1.0.0')
    expect(out.headers['Content-Type']).toBe('application/offset+octet-stream')
    // One curl command; the file name is quoted for the shell, apostrophe included.
    const file = `'./team photo'\\''s.png'`
    expect(out.curl.startsWith(`curl -sS --fail-with-body -X POST '${out.url}'`)).toBe(true)
    expect(out.headers['Upload-Length']).toBe('48213')
    expect(out.curl).toContain(`-H 'Upload-Length: 48213'`)
    // Nothing for the shell to expand: a restricted runner refuses `$(…)`.
    expect(out.curl).not.toMatch(/\$\(|`/)
    expect(out.curl).toContain(`--data-binary @${file}`)
    // The token reaches curl on stdin, not in its arguments.
    expect(out.curl).toContain('-H @-')
    expect(out.curl.endsWith(`<<< '${'Authorization: ' + out.headers['Authorization']}'`)).toBe(
      true,
    )
    expect(out.curl.split('<<<')[0]).not.toContain('nus_')
    const [call] = callsTo(c, 'media').filter((x) => x.method === 'openUploadSession')
    expect(call?.args).toMatchObject({
      owner: { deckId: FIXTURE_DECK_ID },
      filename: "team photo's.png",
      sizeBytes: 48213,
    })
  })

  it('takes a plain file name only — no path, no dot file, no option-like name', async () => {
    for (const filename of [
      '../../.ssh/id_ed25519',
      'a/b.png',
      'c:\\x.png',
      '.env',
      '-rf.png',
      'x\ny.png',
    ]) {
      const err = await failure(
        runCommand(registry, ctx(), 'media.uploadSession', { filename, sizeBytes: 10 }),
      )
      expect(err.code, filename).toBe('invalid_input')
    }
  })

  it('needs the file size, a whole number of bytes', async () => {
    for (const sizeBytes of [undefined, 0, -1, 1.5]) {
      const err = await failure(
        runCommand(registry, ctx(), 'media.uploadSession', { filename: 'a.png', sizeBytes }),
      )
      expect(err.code, String(sizeBytes)).toBe('invalid_input')
    }
  })
})

describe('object.insertFromDeck', () => {
  it('stages the objects with their source deck, then lands them on the slide', async () => {
    const c = ctx()
    const objects = [
      { id: 'x1', type: 'rectangle', x: 10, y: 20, width: 100, height: 50, fill: '#ff0000' },
      { id: 'x2', type: 'image', assetId: 'asset-other', x: 0, y: 0, width: 40, height: 30 },
    ]
    const out = (await runCommand(registry, c, 'object.insertFromDeck', {
      slide: 's3',
      fromDeck: 'deck_other',
      objects,
    })) as { objectIds: string[]; mediaRegistered: number }
    expect(out.mediaRegistered).toBe(1)
    const s3 = getSlideObjectsCtx(c.deck!, 's3')!
    expect(s3.objects.toArray().map((m) => m.get('id'))).toEqual(out.objectIds)
    const [call] = callsTo(c, 'decks').filter((x) => x.method === 'prepareObjectInsert')
    expect(call?.args).toMatchObject({
      source: { deckId: 'deck_other' },
      target: { deckId: FIXTURE_DECK_ID },
    })
    // Settled once the write committed: linked media follows a deck that moved meanwhile.
    expect(callsTo(c, 'decks').map((x) => x.method)).toEqual([
      'prepareObjectInsert',
      'settleObjectInsert',
    ])
  })

  it("brings a deck's objects into a component master, and a master's into a deck", async () => {
    const objects = [{ id: 'x1', type: 'rectangle', x: 10, y: 20, width: 100, height: 50 }]
    const intoMaster = ctx({ target: { componentId: 'cmp_headline' } })
    await runCommand(registry, intoMaster, 'object.insertFromDeck', {
      slide: 's3',
      fromDeck: FIXTURE_DECK_ID,
      objects,
    })
    const fromMaster = ctx()
    await runCommand(registry, fromMaster, 'object.insertFromDeck', {
      slide: 's3',
      fromComponent: 'cmp_headline',
      objects,
    })
    const argsOf = (c: ReturnType<typeof ctx>) =>
      callsTo(c, 'decks').find((x) => x.method === 'prepareObjectInsert')?.args
    expect(argsOf(intoMaster)).toMatchObject({
      source: { deckId: FIXTURE_DECK_ID },
      target: { componentId: 'cmp_headline' },
    })
    expect(argsOf(fromMaster)).toMatchObject({
      source: { componentId: 'cmp_headline' },
      target: { deckId: FIXTURE_DECK_ID },
    })
  })

  it('needs exactly one source', async () => {
    for (const input of [
      { slide: 's3', objects: [{ type: 'rectangle' }] },
      { slide: 's3', fromDeck: 'deck_other', fromComponent: 'cmp_headline', objects: [] },
    ]) {
      const err = await failure(runCommand(registry, ctx(), 'object.insertFromDeck', input))
      expect(err.code).toBe('invalid_input')
    }
  })

  it('refuses its own deck as the source (object.insert is the way there)', async () => {
    const c = ctx()
    const err = await failure(
      runCommand(registry, c, 'object.insertFromDeck', {
        slide: 's3',
        fromDeck: FIXTURE_DECK_ID,
        objects: [{ type: 'rectangle' }],
      }),
    )
    expect(err.code).toBe('invalid_input')
    expect(callsTo(c, 'decks').some((x) => x.method === 'prepareObjectInsert')).toBe(false)
  })

  it('validates the objects before staging anything', async () => {
    const c = ctx()
    const err = await failure(
      runCommand(registry, c, 'object.insertFromDeck', {
        slide: 's3',
        fromDeck: 'deck_other',
        objects: [{ type: 'rectangle', width: -1 }],
      }),
    )
    expect(err.code).toBe('invalid_input')
    expect(callsTo(c, 'decks').some((x) => x.method === 'prepareObjectInsert')).toBe(false)
  })
})

describe('deck.insertFrom', () => {
  it('inserts the staged slides at the index in one write and returns their ids', async () => {
    const c = ctx()
    const out = (await runCommand(registry, c, 'deck.insertFrom', {
      source: { pptx: { url: 'https://example.com/a.pptx' } },
      at: 1,
    })) as { slideIds: string[]; insertedAt: number }
    const ids = listSlides(c.deck!).map((s) => s.id)
    expect(out.insertedAt).toBe(1)
    expect(ids).toEqual(['s1', ...out.slideIds, 's2', 's3'])
    // Settled after the write, never discarded.
    expect(callsTo(c, 'pptx').map((x) => x.method)).toEqual(['prepareInsert', 'settle'])
  })

  it('passes a deck source and its range to the service', async () => {
    const c = ctx()
    await runCommand(registry, c, 'deck.insertFrom', {
      source: { deckId: 'deck_other', from: 1 },
    })
    expect(callsTo(c, 'pptx')[0]?.args).toEqual({
      userId: 'u1',
      deckId: FIXTURE_DECK_ID,
      source: {
        kind: 'deck',
        deckId: 'deck_other',
        range: { from: 1, to: undefined },
        slideIds: undefined,
      },
    })
  })

  it('passes chosen source slides, and refuses them mixed with a range', async () => {
    const c = ctx()
    const out = (await runCommand(registry, c, 'deck.insertFrom', {
      source: { deckId: 'deck_other', slides: ['s3', 's1'] },
      at: 0,
    })) as { slideIds: string[] }
    expect(out.slideIds).toHaveLength(2)
    expect(callsTo(c, 'pptx')[0]?.args).toMatchObject({
      source: { kind: 'deck', deckId: 'deck_other', slideIds: ['s3', 's1'] },
    })
    await expect(
      runCommand(registry, ctx(), 'deck.insertFrom', {
        source: { deckId: 'deck_other', slides: ['s1'], from: 0 },
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })
})

describe('deck.duplicate', () => {
  it('copies the target deck for the caller, with the title and folder it was given', async () => {
    const c = ctx()
    const out = (await runCommand(registry, c, 'deck.duplicate', {
      title: '  Pitch v2 ',
    })) as { id: string; title: string; slideCount: number }
    expect(out).toMatchObject({ title: 'Pitch v2', slideCount: 3 })
    expect(callsTo(c, 'decks').at(-1)?.args).toEqual({
      userId: 'u1',
      deckId: FIXTURE_DECK_ID,
      title: 'Pitch v2',
      folderId: undefined,
    })
  })
})

describe('deck.exportPptx', () => {
  it('defaults to a download URL', async () => {
    const out = await runCommand(registry, ctx(), 'deck.exportPptx', {})
    expect(out).toMatchObject({ delivery: 'url', filename: 'Fixture deck.pptx' })
  })
})

describe('token.*', () => {
  const folderCtx = () => ctx({ target: { folderId: FIXTURE_FOLDER_ID } })
  type Listed = {
    colors: Array<{ id: string; name: string; value: string }>
    textStyles: Array<Record<string, unknown> & { id: string; name: string }>
  }
  const list = (c: ReturnType<typeof ctx>) =>
    runCommand(registry, c, 'token.list', {}) as Promise<Listed>

  it("lists the folder's tokens with their ids", async () => {
    const out = await list(folderCtx())
    // The fixture's own colours, then those the example pack's compile made (A4.4).
    expect(out.colors.map((t) => t.id).slice(0, 3)).toEqual(['brandBlue', 'ink', 'retired'])
    expect(out.colors.find((t) => t.id === 'p-example-role-text')).toMatchObject({
      name: 'Text',
      byVariant: { axis: 'background', values: { light: '#001e50', dark: '#ffffff' } },
      origin: { pack: 'example', key: 'role:text' },
    })
    expect(out.textStyles.find((t) => t.id === 'title')).toMatchObject({
      name: 'Title',
      builtin: true,
    })
  })

  it('creates a token stored normalised, a text style marked as made by a person', async () => {
    const c = folderCtx()
    const { tokenId } = (await runCommand(registry, c, 'token.create', {
      category: 'colors',
      name: 'Accent',
      value: '#F80',
    })) as { tokenId: string }
    expect((await list(c)).colors.find((t) => t.id === tokenId)?.value).toBe('#ff8800')
    expect(callsTo(c, 'tokens').at(-2)?.args).toMatchObject({
      folderId: FIXTURE_FOLDER_ID,
      category: 'colors',
      fields: { name: 'Accent', value: '#ff8800' },
    })
  })

  it('changes a token, clears a field with null and returns the previous values', async () => {
    const c = folderCtx()
    const out = (await runCommand(registry, c, 'token.update', {
      category: 'textStyles',
      tokenId: 'title',
      size: 80,
      family: null,
    })) as { previous: Record<string, unknown> }
    expect(out.previous).toEqual({ size: 72, family: 'Inter' })
    const title = (await list(c)).textStyles.find((t) => t.id === 'title')!
    expect(title['size']).toBe(80)
    expect(title).not.toHaveProperty('family')
  })

  it('refuses a family that could break out of CSS, and effect styles', async () => {
    const c = folderCtx()
    const bad = await failure(
      runCommand(registry, c, 'token.update', {
        category: 'textStyles',
        tokenId: 'title',
        family: 'Inter; } * { color: red',
      }),
    )
    expect(bad.code).toBe('invalid_input')
    const effect = await failure(
      runCommand(registry, c, 'token.create', {
        category: 'effectStyles',
        name: 'Glow',
        kind: 'blur',
        params: { radius: 4 },
      }),
    )
    expect(effect.code).toBe('invalid_input')
  })

  it('deletes a token (returning it) but never a built-in text style', async () => {
    const c = folderCtx()
    const out = await runCommand(registry, c, 'token.delete', {
      category: 'colors',
      tokenId: 'retired',
    })
    expect(out).toMatchObject({ deleted: true, token: { id: 'retired', name: 'Retired red' } })
    const builtin = await failure(
      runCommand(registry, c, 'token.delete', { category: 'textStyles', tokenId: 'title' }),
    )
    expect(builtin.code).toBe('conflict')
  })
})

describe('text.style.createFromObject / updateFromObject', () => {
  const objectOf = (c: ReturnType<typeof ctx>, slide: number, id: string) =>
    getSlideObjectsCtx(c.deck!, listSlides(c.deck!)[slide]!.id)!
      .objects.toArray()
      .find((m) => m.get('id') === id)!
      .toJSON()

  it("makes a style of a box's typography and links the box to it exactly", async () => {
    const c = ctx()
    const out = (await runCommand(registry, c, 'text.style.createFromObject', {
      slide: 's1',
      object: 't1',
      name: 'Quote',
    })) as { styleId: string }
    const tokens = await c.services.tokens.list({ userId: 'u1', folderId: FIXTURE_FOLDER_ID })
    expect(tokens.textStyles[out.styleId]).toMatchObject({
      name: 'Quote',
      size: 40,
      weight: 400,
      color: '#111111',
      textTransform: 'none',
    })
    expect(objectOf(c, 0, 't1')).toMatchObject({
      textStyleId: out.styleId,
      textStyleOverrides: [],
    })
  })

  it("pushes a linked box's look into its style and clears the box's overrides", async () => {
    const c = ctx()
    const out = (await runCommand(registry, c, 'text.style.updateFromObject', {
      slide: 's2',
      object: 'hd1',
    })) as { style: string; previous: Record<string, unknown> }
    expect(out.style).toBe('Title')
    expect(out.previous).toMatchObject({ size: 72 })
    const tokens = await c.services.tokens.list({ userId: 'u1', folderId: FIXTURE_FOLDER_ID })
    expect(tokens.textStyles['title']).toMatchObject({ size: 64, weight: 700 })
    expect(objectOf(c, 1, 'hd1')['textStyleOverrides']).toEqual([])
  })

  it('refuses an unlinked box, a shape, and a box whose typography no style may hold', async () => {
    const unlinked = await failure(
      runCommand(registry, ctx(), 'text.style.updateFromObject', { slide: 's1', object: 't1' }),
    )
    expect(unlinked.code).toBe('conflict')
    const shape = await failure(
      runCommand(registry, ctx(), 'text.style.createFromObject', {
        slide: 's1',
        object: 'r1',
        name: 'Nope',
      }),
    )
    expect(shape.code).toBe('invalid_input')
    // A collaborator can write any value into a box; the style refuses it.
    const c = ctx()
    getSlideObjectsCtx(c.deck!, 's1')!
      .objects.toArray()
      .find((m) => m.get('id') === 't1')!
      .set('fontFamily', 'x"; } * { color: red')
    const invalid = await failure(
      runCommand(registry, c, 'text.style.createFromObject', {
        slide: 's1',
        object: 't1',
        name: 'Hostile',
      }),
    )
    expect(invalid.code).toBe('invalid_input')
    const tokens = await c.services.tokens.list({ userId: 'u1', folderId: FIXTURE_FOLDER_ID })
    expect(Object.values(tokens.textStyles).map((t) => t.name)).not.toContain('Hostile')
  })
})
