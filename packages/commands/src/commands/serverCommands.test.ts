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
  getParagraphDeltas,
  getSlideObjectsCtx,
  listSlides,
} from '@narrative/slide-model'
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
import type { CommandContext } from '../types.js'

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

  it('deck.moveToFolder moves the target deck under the invocation origin and reports the rebinding', async () => {
    const origin = { run: 'r1' }
    const c = ctx({ origin })
    const out = await runCommand(registry, c, 'deck.moveToFolder', { folderId: 'folder_b' })
    expect(out).toEqual({
      moved: true,
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

describe('media.* and share.*', () => {
  it('media commands pin the asset to the target deck (no reaching into another deck)', async () => {
    const c = ctx()
    await runCommand(registry, c, 'media.url', { assetId: 'asset-fixture' })
    expect(callsTo(c, 'media')[0]?.args).toEqual({
      userId: 'u1',
      assetId: 'asset-fixture',
      variant: 'display',
      deckId: FIXTURE_DECK_ID,
    })
  })

  it('media.upload turns a URL input into a url source', async () => {
    const c = ctx()
    await runCommand(registry, c, 'media.upload', {
      file: { url: 'https://example.com/a.jpg', filename: 'a.jpg' },
    })
    expect(callsTo(c, 'media')[0]?.args).toEqual({
      userId: 'u1',
      deckId: FIXTURE_DECK_ID,
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
    expect(call?.args).toMatchObject({ sourceDeckId: 'deck_other', targetDeckId: FIXTURE_DECK_ID })
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
