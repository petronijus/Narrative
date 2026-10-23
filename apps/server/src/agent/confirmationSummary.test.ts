/**
 * agent/confirmationSummary.test.ts — what the user is asked to approve for
 * `media.delete`: the file looked up within the target (a deck, the
 * component master or the folder an agent names), and what removing it does
 * there — a deck's asset is deleted, a master's picture is handed to its
 * folder, a folder's own is deleted; and for `deck.moveToFolder`, that the
 * deck's active share links will show the destination folder's media; and
 * for the folder sharing commands, the member or invite looked up within the
 * folder and a role that names the whole folder.
 */

import { describe, expect, it, vi } from 'vitest'
import { createDefaultRegistry } from '@narrative/commands'
import {
  buildConfirmationSummary,
  summaryLines,
  type ConfirmationLookups,
} from './confirmationSummary.js'

const registry = createDefaultRegistry()

function lookups(): ConfirmationLookups & { asset: ReturnType<typeof vi.fn> } {
  return {
    deckTitle: async () => 'Q3 review',
    folderName: async () => 'Client',
    componentName: async () => 'Logo block',
    collaborator: async () => null,
    invite: async () => null,
    folderMember: async (folderId, userId) =>
      folderId === 'f1' && userId === 'user_jana' ? 'Jana (jana@example.com)' : null,
    folderInvite: async (folderId, inviteId) =>
      folderId === 'f1' && inviteId === 'inv1' ? 'eva@example.com as viewer' : null,
    shareLink: async () => null,
    asset: vi.fn(async () => 'logo.png (image)'),
    componentInFolder: async () => null,
    memberFolder: async () => null,
    folderDeckCount: async () => 0,
    activeShareLinks: async () => 0,
  }
}

async function summaryFor(target: { deckId?: string; componentId?: string; folderId?: string }) {
  const l = lookups()
  const summary = await buildConfirmationSummary({
    def: registry.get('media.delete')!,
    target,
    input: { assetId: 'a1' },
    userId: 'u1',
    reasons: ['irreversible'],
    conditional: null,
    clientName: null,
    lookups: l,
  })
  return { summary, lookups: l }
}

describe('media.delete confirmation', () => {
  it('on a deck: names the file within the deck and says it is deleted', async () => {
    const { summary, lookups: l } = await summaryFor({ deckId: 'd1' })
    expect(l.asset).toHaveBeenCalledWith({ deckId: 'd1' }, 'a1')
    // The action says only what every target shares; what happens is per target.
    expect(summary.action).toBe('Remove an asset.')
    expect(summary.details).toEqual([
      { label: 'File', value: 'logo.png (image)' },
      { label: 'What happens', value: 'Deleted with its file: objects still showing it go blank' },
    ])
  })

  it('on a component master: names the file within the master and says it goes to the folder', async () => {
    const { summary, lookups: l } = await summaryFor({ componentId: 'cmp1' })
    expect(l.asset).toHaveBeenCalledWith({ componentId: 'cmp1' }, 'a1')
    expect(summary.target).toEqual({ kind: 'component', label: 'Logo block' })
    expect(summary.action).toBe('Remove an asset.')
    const lines = summaryLines(summary)
    expect(lines).toContain('File: logo.png (image)')
    expect(lines.find((l) => l.startsWith('What happens:'))).toMatch(
      /handed to its folder: it is not deleted, the slides it was stamped on keep showing it/,
    )
  })

  it("on a folder: names the file within the folder and says the folder's decks lose it", async () => {
    const { summary, lookups: l } = await summaryFor({ folderId: 'f1' })
    expect(l.asset).toHaveBeenCalledWith({ folderId: 'f1' }, 'a1')
    expect(summary.target).toEqual({ kind: 'folder', label: 'Client' })
    expect(summary.action).toBe('Remove an asset.')
    expect(summary.details.at(-1)).toEqual({
      label: 'What happens',
      value: "Deleted with its file: the folder's decks that still show it go blank",
    })
  })
})

describe('deck.moveToFolder confirmation', () => {
  async function moveSummary(activeLinks: number) {
    const l = { ...lookups(), activeShareLinks: vi.fn(async () => activeLinks) }
    const summary = await buildConfirmationSummary({
      def: registry.get('deck.moveToFolder')!,
      target: { deckId: 'd1' },
      input: { folderId: 'f2' },
      userId: 'u1',
      reasons: ['irreversible'],
      conditional: null,
      clientName: null,
      lookups: l,
    })
    return { summary, lookups: l }
  }

  it('says that active share links will show the destination folder’s component media', async () => {
    const { summary, lookups: l } = await moveSummary(2)
    expect(l.activeShareLinks).toHaveBeenCalledWith('d1')
    expect(summary.details).toContainEqual({
      label: 'Share links',
      value:
        "2 active: whoever holds one will also see the destination folder's component pictures and videos",
    })
  })

  it('says nothing about links when the deck has no active one', async () => {
    const { summary } = await moveSummary(0)
    expect(summary.details.map((d) => d.label)).not.toContain('Share links')
  })
})

describe('folder sharing confirmations', () => {
  async function folderSummary(commandId: string, input: Record<string, unknown>) {
    return buildConfirmationSummary({
      def: registry.get(commandId)!,
      target: { folderId: 'f1' },
      input,
      userId: 'u1',
      reasons: ['irreversible'],
      conditional: null,
      clientName: null,
      lookups: lookups(),
    })
  }

  it('an invitation names the recipient and a role over the whole folder', async () => {
    const summary = await folderSummary('folder.members.invite', {
      email: 'jana@example.com',
      role: 'editor',
    })
    expect(summary.target).toEqual({ kind: 'folder', label: 'Client' })
    expect(summary.details).toEqual([
      { label: 'Recipient', value: 'jana@example.com' },
      {
        label: 'Role',
        value: "editor — can change the folder's decks, components, tokens and fonts",
      },
    ])
  })

  it('a role change and a removal name the member within the folder', async () => {
    expect(
      (await folderSummary('folder.members.setRole', { userId: 'user_jana', role: 'viewer' }))
        .details,
    ).toEqual([
      { label: 'Member', value: 'Jana (jana@example.com)' },
      { label: 'Role', value: 'viewer — can look at and present every deck in the folder' },
    ])
    // Someone who is not a member of this folder is shown by id only.
    expect((await folderSummary('folder.members.remove', { userId: 'stranger' })).details).toEqual([
      { label: 'Member', value: 'stranger' },
    ])
  })

  it('a cancelled invite is looked up within the folder', async () => {
    expect((await folderSummary('folder.invites.cancel', { inviteId: 'inv1' })).details).toEqual([
      { label: 'Invite', value: 'eva@example.com as viewer' },
    ])
  })
})
