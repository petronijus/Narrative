/**
 * commands/src/commands/sharing.ts — the `share.*` commands backed by the
 * server's SharingService (apps/server/src/services/sharing.ts), the same
 * service the /decks/:id/{permissions,invites,share-links} routes call.
 * Everything here needs the owner role on the deck, and everything that
 * changes who can see the deck asks the user first.
 */

import { z } from 'zod'
import { defineCommand } from '../registry.js'
import { requireServices } from '../services.js'
import {
  DELETE,
  GET,
  IdSchema,
  POST,
  RoleSchema,
  serverCommand,
  targetDeckId,
} from './serverShared.js'

const share = {
  ...serverCommand,
  domain: 'share',
  role: 'owner',
  scope: 'deck',
  effects: ['server'],
} as const

const read = { ...share, readOnly: true, undo: 'n/a', confirm: 'never' } as const
const change = { ...share, undo: 'irreversible', confirm: 'always' } as const

const UserIdSchema = z.string().min(1).max(255)

const RoleInput = RoleSchema.describe(
  'viewer = can look and present; editor = can change the deck; owner = can also share and delete it',
)

const GrantedUserOutput = z.object({
  userId: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  role: RoleSchema,
})

export const sharePermissionsList = defineCommand({
  ...read,
  id: 'share.permissions.list',
  title: 'List collaborators',
  description:
    'Who has access to the deck: each collaborator with user id, email, name, role and grant time. Invited by ' +
    'email, not signed in yet: share.invites.list; anonymous links: share.links.list.',
  input: z.strictObject({}),
  output: z.object({
    permissions: z.array(
      z.object({
        userId: z.string(),
        role: RoleSchema,
        grantedAt: z.string(),
        grantedBy: z.string().nullable(),
        email: z.string().nullable(),
        name: z.string().nullable(),
      }),
    ),
  }),
  routes: [GET('/decks/:id/permissions')],
  examples: [{ title: 'List collaborators', input: {} }],
  async handler(ctx) {
    return {
      permissions: await requireServices(ctx).sharing.listPermissions({
        deckId: targetDeckId(ctx),
      }),
    }
  },
})

export const sharePermissionsInvite = defineCommand({
  ...change,
  id: 'share.permissions.invite',
  title: 'Share with a person',
  description:
    'Share the deck with someone by email. A Narrative user gets the role at once (`kind: "granted"`); ' +
    'otherwise a pending invite is created and an invitation EMAIL sent (`kind: "pending"`), accepted by ' +
    'signing in. Inviting a collaborator changes their role. Always confirm the address and role with the ' +
    "user first — this reaches a real person. A listed collaborator's role without an email: " +
    'share.permissions.setRole.',
  input: z.strictObject({
    email: z.email().max(320).describe('Their email address'),
    role: RoleInput,
  }),
  output: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('granted'), user: GrantedUserOutput }),
    z.object({
      kind: z.literal('pending'),
      invite: z.object({
        id: z.string(),
        email: z.string(),
        role: RoleSchema,
        expiresAt: z.string(),
        replaced: z.boolean().describe('True when an earlier pending invite was updated'),
      }),
    }),
  ]),
  routes: [POST('/decks/:id/permissions')],
  examples: [
    { title: 'Invite a colleague to edit', input: { email: 'jana@example.com', role: 'editor' } },
  ],
  async handler(ctx, input) {
    return requireServices(ctx).sharing.invite({
      deckId: targetDeckId(ctx),
      inviterUserId: ctx.actor.userId,
      email: input.email,
      role: input.role,
    })
  },
})

export const sharePermissionsSetRole = defineCommand({
  ...change,
  id: 'share.permissions.setRole',
  idempotent: true,
  title: 'Change a collaborator role',
  description:
    "Change an existing collaborator's role (user id from share.permissions.list); their open editors " +
    'reconnect with it at once (viewer = read-only). Not your own role. No email. Confirm with the user ' +
    'first.',
  input: z.strictObject({
    userId: UserIdSchema.describe('The collaborator (share.permissions.list)'),
    role: RoleInput,
  }),
  output: GrantedUserOutput,
  examples: [
    { title: 'Make a collaborator a viewer', input: { userId: 'user_jana', role: 'viewer' } },
  ],
  async handler(ctx, input) {
    return requireServices(ctx).sharing.setRole({
      deckId: targetDeckId(ctx),
      callerUserId: ctx.actor.userId,
      userId: input.userId,
      role: input.role,
    })
  },
})

export const sharePermissionsRevoke = defineCommand({
  ...change,
  id: 'share.permissions.revoke',
  title: 'Remove a collaborator',
  description:
    "Remove a collaborator's access (user id from share.permissions.list); their open editors are " +
    'disconnected. Not yourself, not the last owner. Confirm with the user first.',
  input: z.strictObject({ userId: UserIdSchema.describe('The collaborator to remove') }),
  output: z.object({ revoked: z.literal(true) }),
  routes: [DELETE('/decks/:id/permissions/:userId')],
  examples: [{ title: 'Remove a collaborator', input: { userId: 'user_jana' } }],
  async handler(ctx, input) {
    await requireServices(ctx).sharing.revoke({
      deckId: targetDeckId(ctx),
      callerUserId: ctx.actor.userId,
      userId: input.userId,
    })
    return { revoked: true as const }
  },
})

export const shareInvitesList = defineCommand({
  ...read,
  id: 'share.invites.list',
  title: 'List pending invites',
  description:
    'Email invites to the deck not accepted yet (id, email, role, sent and expiry time); one becomes a ' +
    'collaborator when the person signs in.',
  input: z.strictObject({}),
  output: z.object({
    invites: z.array(
      z.object({
        id: z.string(),
        email: z.string(),
        role: RoleSchema,
        invitedAt: z.string(),
        expiresAt: z.string(),
      }),
    ),
  }),
  routes: [GET('/decks/:id/invites')],
  examples: [{ title: 'Pending invites', input: {} }],
  async handler(ctx) {
    return {
      invites: await requireServices(ctx).sharing.listInvites({ deckId: targetDeckId(ctx) }),
    }
  },
})

export const shareInvitesCancel = defineCommand({
  ...change,
  id: 'share.invites.cancel',
  title: 'Cancel an invite',
  description:
    'Withdraw a pending email invite (id from share.invites.list): the link in the email stops working. ' +
    'Confirm with the user first.',
  input: z.strictObject({ inviteId: IdSchema.describe('Invite id (share.invites.list)') }),
  output: z.object({ cancelled: z.literal(true) }),
  routes: [DELETE('/decks/:id/invites/:inviteId')],
  examples: [{ title: 'Cancel an invite', input: { inviteId: 'invite_fixture' } }],
  async handler(ctx, input) {
    await requireServices(ctx).sharing.cancelInvite({
      deckId: targetDeckId(ctx),
      inviteId: input.inviteId,
    })
    return { cancelled: true as const }
  },
})

export const shareLinksList = defineCommand({
  ...read,
  id: 'share.links.list',
  title: 'List share links',
  description:
    "The deck's active share links: anyone holding one opens the deck with its role, without signing in. Id, " +
    'role, creation and expiry time; the URL is only returned when a link is created.',
  input: z.strictObject({}),
  output: z.object({
    links: z.array(
      z.object({
        id: z.string(),
        role: RoleSchema,
        createdAt: z.string(),
        expiresAt: z.string().nullable(),
        createdBy: z.string(),
      }),
    ),
  }),
  routes: [GET('/decks/:id/share-links')],
  examples: [{ title: 'Active share links', input: {} }],
  async handler(ctx) {
    return { links: await requireServices(ctx).sharing.listLinks({ deckId: targetDeckId(ctx) }) }
  },
})

export const shareLinksCreate = defineCommand({
  ...change,
  id: 'share.links.create',
  title: 'Create a share link',
  description:
    'Create a link that opens the deck for ANYONE who has it, without an account, with the given role ' +
    '(usually viewer; an editor link lets strangers change the deck), optionally expiring. Returns the URL to ' +
    'hand out. Confirm with the user first; revoke with share.links.revoke.',
  input: z.strictObject({
    role: RoleInput,
    expiresAt: z.iso.datetime({ offset: true }).optional().describe('When the link stops working'),
  }),
  output: z.object({ id: z.string(), url: z.string() }),
  routes: [POST('/decks/:id/share-links')],
  examples: [
    { title: 'A view-only link', input: { role: 'viewer' } },
    { title: 'A link that expires', input: { role: 'viewer', expiresAt: '2026-12-31T23:59:59Z' } },
  ],
  async handler(ctx, input) {
    return requireServices(ctx).sharing.createLink({
      deckId: targetDeckId(ctx),
      userId: ctx.actor.userId,
      role: input.role,
      expiresAt: input.expiresAt ?? null,
    })
  },
})

export const shareLinksRevoke = defineCommand({
  ...change,
  id: 'share.links.revoke',
  title: 'Revoke a share link',
  description:
    'Revoke a share link (id from share.links.list): it stops working at once and people who opened the deck ' +
    'with it are disconnected. Confirm with the user first.',
  input: z.strictObject({ linkId: IdSchema.describe('Share link id (share.links.list)') }),
  output: z.object({ revoked: z.literal(true) }),
  routes: [DELETE('/decks/:id/share-links/:linkId')],
  examples: [{ title: 'Revoke a link', input: { linkId: 'link_fixture' } }],
  async handler(ctx, input) {
    await requireServices(ctx).sharing.revokeLink({
      deckId: targetDeckId(ctx),
      linkId: input.linkId,
    })
    return { revoked: true as const }
  },
})

export const shareCommands = [
  sharePermissionsList,
  sharePermissionsInvite,
  sharePermissionsSetRole,
  sharePermissionsRevoke,
  shareInvitesList,
  shareInvitesCancel,
  shareLinksList,
  shareLinksCreate,
  shareLinksRevoke,
]
