/**
 * The registry refuses commands whose metadata the agent surface would
 * misreport (MCP annotations are derived from `readOnly` / `idempotent`).
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { FileSourceSchema, urlFetchConfirmation } from './commands/serverShared.js'
import { createDefaultRegistry } from './catalog.js'
import { isBatchable } from './run.js'
import {
  CommandRegistry,
  commandConfirmationProblems,
  commandMetadataProblems,
  commandTargetProblems,
  defineCommand,
} from './registry.js'
import { requiredRole, type CommandDef } from './types.js'

function def(overrides: Partial<CommandDef>): CommandDef {
  return defineCommand({
    id: 'deck.probe',
    domain: 'deck',
    title: 'Probe',
    description: 'A probe command used to test the registry metadata rules.',
    input: z.object({}),
    output: z.object({}),
    role: 'viewer',
    scope: 'user',
    effects: ['server'],
    undo: 'n/a',
    confirm: 'never',
    hosts: ['server'],
    implementedWith: [],
    examples: [{ title: 'Probe', input: {} }],
    handler: () => ({}),
    ...overrides,
  } as CommandDef)
}

describe('commandMetadataProblems', () => {
  it('accepts a server read and a set-to-value write', () => {
    expect(commandMetadataProblems(def({ readOnly: true }))).toEqual([])
    expect(
      commandMetadataProblems(def({ undo: 'undoable', idempotent: true, effects: ['doc'] })),
    ).toEqual([])
  })

  it('refuses a read-only command that writes the document, can be undone or asks first', () => {
    expect(commandMetadataProblems(def({ readOnly: true, effects: ['doc'] }))).toHaveLength(1)
    expect(commandMetadataProblems(def({ readOnly: true, undo: 'undoable' }))).toContain(
      "read-only, but undo is 'undoable' (must be 'n/a')",
    )
    expect(commandMetadataProblems(def({ readOnly: true, confirm: 'always' }))).toHaveLength(1)
    expect(commandMetadataProblems(def({ readOnly: true, idempotent: true }))).toHaveLength(1)
  })

  it('requires readOnly for effect-free and query commands', () => {
    expect(commandMetadataProblems(def({ effects: [] }))).toEqual([
      'has no effects, so it must declare readOnly: true',
    ])
    expect(commandMetadataProblems(def({ id: 'query.probe', domain: 'query' }))).toContain(
      'query commands must declare readOnly: true',
    )
  })

  it('allows readsFolderTokens only on a command that uses the document', () => {
    expect(
      commandMetadataProblems(def({ undo: 'undoable', effects: ['doc'], readsFolderTokens: true })),
    ).toEqual([])
    expect(commandMetadataProblems(def({ readOnly: true, readsFolderTokens: true }))).toEqual([
      '`readsFolderTokens` is for commands that use the target document',
    ])
  })

  it("refuses idempotent on a command that is not a write (undo 'n/a')", () => {
    expect(commandMetadataProblems(def({ idempotent: true }))).toHaveLength(1)
  })

  it('requires a server-side undoable command to name its counter-command, and only it', () => {
    expect(commandMetadataProblems(def({ undo: 'undoable' }))).toEqual([
      'undoable without a document effect, so it must name its counter-command in `undoneBy` (agent.revert only undoes documents)',
    ])
    expect(commandMetadataProblems(def({ undo: 'undoable', undoneBy: 'deck.delete' }))).toEqual([])
    // Document edits are undone by the editor's undo and agent.revert.
    expect(
      commandMetadataProblems(def({ undo: 'undoable', effects: ['doc'], undoneBy: 'deck.delete' })),
    ).toHaveLength(1)
    expect(commandMetadataProblems(def({ undo: 'irreversible', undoneBy: 'x.y' }))).toHaveLength(1)
  })

  it('names counter-commands that exist in the default registry', () => {
    const registry = createDefaultRegistry()
    const named = registry.list().filter((c) => c.undoneBy !== undefined)
    expect(named.length).toBeGreaterThan(0)
    for (const c of named) expect(registry.has(c.undoneBy!), `${c.id} → ${c.undoneBy}`).toBe(true)
  })

  it('is enforced by register()', () => {
    expect(() => new CommandRegistry().register(def({ effects: [] }))).toThrow(
      /inconsistent metadata/,
    )
  })
})

describe('commandTargetProblems', () => {
  it('lets only deck-scoped commands accept a component master', () => {
    expect(commandTargetProblems(def({ scope: 'deck', acceptsComponent: true }))).toEqual([])
    expect(commandTargetProblems(def({ scope: 'folder', acceptsComponent: true }))).toHaveLength(1)
    expect(commandTargetProblems(def({ scope: 'user', acceptsComponent: true }))).toHaveLength(1)
  })

  it("lets a deck's guest in only on a read-only viewer command of folder scope", () => {
    const reader = {
      scope: 'folder',
      readOnly: true,
      role: 'viewer',
      folderReaders: 'content',
    } as const
    expect(commandTargetProblems(def(reader))).toEqual([])
    expect(commandTargetProblems(def({ ...reader, scope: 'deck' }))).toEqual([
      "folderReaders is for folder-scoped commands, but its scope is 'deck'",
    ])
    expect(commandTargetProblems(def({ ...reader, role: 'editor' }))).toEqual([
      "folderReaders lets a deck's guest in, so only a read-only command with the viewer role may set it",
    ])
    expect(
      commandTargetProblems(def({ scope: 'folder', role: 'viewer', folderReaders: 'content' })),
    ).toHaveLength(1)
  })

  it('lets only deck-scoped server commands without a document accept a folder', () => {
    expect(commandTargetProblems(def({ scope: 'deck', acceptsFolder: true }))).toEqual([])
    expect(commandTargetProblems(def({ scope: 'folder', acceptsFolder: true }))).toHaveLength(1)
    expect(
      commandTargetProblems(
        def({
          scope: 'deck',
          acceptsFolder: true,
          acceptsComponent: true,
          effects: ['doc', 'server'],
        }),
      ),
    ).toEqual([
      'acceptsFolder is for server commands that do not use a document (a folder has none)',
    ])
    expect(
      commandTargetProblems(def({ scope: 'deck', acceptsFolder: true, readsDocument: true })),
    ).toHaveLength(1)
  })

  it('takes a per-target role only for a target the command accepts', () => {
    expect(
      commandTargetProblems(
        def({ scope: 'deck', acceptsComponent: true, roleOn: { component: 'editor' } }),
      ),
    ).toEqual([])
    expect(commandTargetProblems(def({ scope: 'deck', roleOn: { component: 'editor' } }))).toEqual([
      'roleOn.component needs acceptsComponent',
    ])
    expect(commandTargetProblems(def({ scope: 'deck', roleOn: { folder: 'owner' } }))).toEqual([
      'roleOn.folder needs acceptsFolder',
    ])
    expect(commandTargetProblems(def({ scope: 'folder', roleOn: {} }))).toHaveLength(1)
  })

  it('needs the per-target role on that target, else the command role', () => {
    const media = def({
      scope: 'deck',
      role: 'owner',
      acceptsComponent: true,
      acceptsFolder: true,
      roleOn: { component: 'editor' },
    })
    expect(requiredRole(media, { deckId: 'd' })).toBe('owner')
    expect(requiredRole(media, { componentId: 'c' })).toBe('editor')
    expect(requiredRole(media, { folderId: 'f' })).toBe('owner')
    expect(requiredRole(def({ scope: 'folder', role: 'editor' }), { folderId: 'f' })).toBe('editor')
  })

  it('requires every pure document edit to accept one', () => {
    expect(commandTargetProblems(def({ scope: 'deck', effects: ['doc'] }))).toEqual([
      'a document edit must accept a component master too (acceptsComponent: true)',
    ])
    // A command that also needs the server decides for itself (deck.insertFrom does not).
    expect(commandTargetProblems(def({ scope: 'deck', effects: ['doc', 'server'] }))).toEqual([])
  })

  it('matches the deck commands that really work on a master', () => {
    const refusing = createDefaultRegistry()
      .list()
      .filter((c) => (c.scope ?? 'deck') === 'deck' && c.acceptsComponent !== true)
      .map((c) => c.id)
    // Everything that needs an actual deck; pinned so a change is deliberate.
    expect(refusing).toEqual([
      'component.promote',
      'component.stamp',
      'deck.delete',
      'deck.duplicate',
      'deck.exportPng',
      'deck.exportPptx',
      'deck.fonts.list',
      'deck.get',
      'deck.insertFrom',
      'deck.moveToFolder',
      'deck.rename',
      'editor.context',
      'editor.present.link',
      'editor.show',
      'query.render',
      'share.invites.cancel',
      'share.invites.list',
      'share.links.create',
      'share.links.list',
      'share.links.revoke',
      'share.permissions.invite',
      'share.permissions.list',
      'share.permissions.revoke',
      'share.permissions.setRole',
    ])
  })
})

describe('commandConfirmationProblems', () => {
  const fetching = { input: z.strictObject({ file: FileSourceSchema }) }

  it('requires confirmWhen on every command whose input can fetch a URL', () => {
    expect(commandConfirmationProblems(def({ ...fetching, undo: 'undoable' }))).toEqual([
      expect.stringContaining('must declare `confirmWhen`'),
    ])
    expect(
      commandConfirmationProblems(
        def({
          ...fetching,
          undo: 'undoable',
          confirmWhen: urlFetchConfirmation((i: { file: never }) => [i.file]),
        }),
      ),
    ).toEqual([])
  })

  it('refuses confirmWhen on a read-only command', () => {
    expect(
      commandConfirmationProblems(def({ readOnly: true, confirmWhen: () => null })),
    ).toHaveLength(1)
  })

  it("forces confirm: 'always' on an irreversible document-only edit", () => {
    expect(commandConfirmationProblems(def({ effects: ['doc'], undo: 'irreversible' }))).toEqual([
      expect.stringContaining("must be confirm: 'always'"),
    ])
    expect(
      commandConfirmationProblems(
        def({ effects: ['doc'], undo: 'irreversible', confirm: 'always' }),
      ),
    ).toEqual([])
  })

  it('is enforced by register()', () => {
    expect(() => new CommandRegistry().register(def({ ...fetching, undo: 'undoable' }))).toThrow(
      /inconsistent metadata/,
    )
  })

  it('holds for the default registry', () => {
    const problems = createDefaultRegistry()
      .list()
      .flatMap((c) => commandConfirmationProblems(c).map((p) => `${c.id}: ${p}`))
    expect(problems).toEqual([])
  })
})

describe('urlFetchConfirmation', () => {
  const confirm = urlFetchConfirmation(
    (i: { files: Array<{ url: string } | { base64: string }> }) => i.files,
  )

  it('names every distinct host a { url } source would contact', () => {
    const c = confirm({
      files: [
        { url: 'https://Example.com/a.png?token=secret' },
        { url: 'https://example.com/b.png' },
        { url: 'http://cdn.example.org/c.png' },
      ],
    })
    expect(c).not.toBeNull()
    expect(c!.kind).toBe('url_fetch')
    expect(c!.hosts).toEqual(['example.com', 'cdn.example.org'])
    expect(c!.details).toEqual([
      { label: 'Downloads from', value: 'example.com' },
      { label: 'Downloads from', value: 'cdn.example.org' },
    ])
    // The query never reaches the question: only the host is shown.
    expect(JSON.stringify(c)).not.toContain('secret')
  })

  it('asks nothing for inline bytes', () => {
    expect(confirm({ files: [{ base64: 'AAAA' }] })).toBeNull()
  })
})

describe('isBatchable', () => {
  it('keeps every command that may ask the user out of ops.apply', () => {
    for (const c of createDefaultRegistry().list()) {
      if (
        c.confirm === 'always' ||
        typeof c.confirmWhen === 'function' ||
        c.undo === 'irreversible'
      )
        expect(isBatchable(c), c.id).toBe(false)
    }
  })

  it('still batches plain document edits', () => {
    expect(isBatchable(createDefaultRegistry().get('object.move')!)).toBe(true)
  })
})
