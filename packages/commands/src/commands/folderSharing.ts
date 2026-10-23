/**
 * commands/src/commands/folderSharing.ts — the `folder.members.*` and
 * `folder.invites.*` commands backed by the server's FolderSharingService
 * (apps/server/src/services/folderSharing.ts), the same service the
 * /folders/:id/{members,invites} routes call. Folder sharing, step 3
 * (docs/plans/folder-sharing.md): a member sees EVERYTHING in the folder —
 * every deck, component, picture, video, font and token — with their folder
 * role. Everything here needs the owner role in the folder, and everything
 * that changes who can see the folder asks the user first.
 */

import { z } from 'zod'
import { defineCommand } from '../registry.js'
import { requireServices } from '../services.js'
import {
  DELETE,
  GET,
  IdSchema,
  PATCH,
  POST,
  RoleSchema,
  serverCommand,
  targetFolderId,
} from './serverShared.js'

const folderShare = {
  ...serverCommand,
  domain: 'folder',
  role: 'owner',
  scope: 'folder',
  effects: ['server'],
} as const

const read = { ...folderShare, readOnly: true, undo: 'n/a', confirm: 'never' } as const
const change = { ...folderShare, undo: 'irreversible', confirm: 'always' } as const

const UserIdSchema = z.string().min(1).max(255)

const RoleInput = RoleSchema.describe(
  'On everything in the folder: viewer = looks at and presents every deck; editor = also changes its decks, ' +
    'components, tokens and fonts; owner = also shares, renames and deletes the folder',
)

const GrantedUserOutput = z.object({
  userId: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  role: RoleSchema,
})

export const folderMembersList = defineCommand({
  ...read,
  id: 'folder.members.list',
  title: 'List folder members',
  description:
    'Who the folder is shared with: each member with user id, email, name, role and grant time; a member sees ' +
    'everything in the folder with that role. Pending invites: folder.invites.list. Someone given a single ' +
    'deck (share.permissions.list) is not a member. Folder owners only.',
  input: z.strictObject({}),
  output: z.object({
    members: z.array(
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
  routes: [GET('/folders/:id/members')],
  examples: [{ title: 'List folder members', input: {} }],
  async handler(ctx) {
    return {
      members: await requireServices(ctx).folderSharing.listMembers({
        userId: ctx.actor.userId,
        folderId: targetFolderId(ctx),
      }),
    }
  },
})

export const folderMembersInvite = defineCommand({
  ...change,
  id: 'folder.members.invite',
  title: 'Share a folder with a person',
  description:
    'Share the whole folder by email: the person sees EVERY deck, component, picture, font and token in it ' +
    'with the role. A Narrative user becomes a member at once (`kind: "granted"`); anyone else gets a pending ' +
    'invite and an invitation EMAIL (`kind: "pending"`), accepted by signing in. Inviting a member changes ' +
    'their role. Drafts cannot be shared. Confirm the address and role with the user first — this reaches a ' +
    'real person. One deck only: share.permissions.invite. Folder owners only.',
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
  routes: [POST('/folders/:id/members')],
  examples: [
    {
      title: 'Let a colleague work on the whole folder',
      input: { email: 'jana@example.com', role: 'editor' },
    },
    {
      title: 'Invite someone new to view the folder',
      input: { email: 'new.client@example.com', role: 'viewer' },
    },
  ],
  async handler(ctx, input) {
    return requireServices(ctx).folderSharing.invite({
      userId: ctx.actor.userId,
      folderId: targetFolderId(ctx),
      email: input.email,
      role: input.role,
    })
  },
})

export const folderMembersSetRole = defineCommand({
  ...change,
  id: 'folder.members.setRole',
  idempotent: true,
  title: 'Change a folder member role',
  description:
    "Change a member's role (user id from folder.members.list) on everything in the folder; their open " +
    'editors reconnect with it at once (viewer = read-only). Not your own; the last owner stays one. No ' +
    'email. Confirm with the user first. Folder owners only.',
  input: z.strictObject({
    userId: UserIdSchema.describe('The member (folder.members.list)'),
    role: RoleInput,
  }),
  output: GrantedUserOutput,
  routes: [PATCH('/folders/:id/members/:userId')],
  examples: [{ title: 'Make a member a viewer', input: { userId: 'user_jana', role: 'viewer' } }],
  async handler(ctx, input) {
    return requireServices(ctx).folderSharing.setRole({
      userId: ctx.actor.userId,
      folderId: targetFolderId(ctx),
      memberId: input.userId,
      role: input.role,
    })
  },
})

export const folderMembersRemove = defineCommand({
  ...change,
  id: 'folder.members.remove',
  title: 'Remove a folder member',
  description:
    'Remove a member (user id from folder.members.list): they lose everything in the folder except a deck ' +
    'shared with them on its own; their open editors are disconnected. Not yourself, not the last owner. ' +
    'Confirm with the user first. Folder owners only.',
  input: z.strictObject({ userId: UserIdSchema.describe('The member to remove') }),
  output: z.object({ removed: z.literal(true) }),
  routes: [DELETE('/folders/:id/members/:userId')],
  examples: [{ title: 'Remove a member', input: { userId: 'user_jana' } }],
  async handler(ctx, input) {
    await requireServices(ctx).folderSharing.removeMember({
      userId: ctx.actor.userId,
      folderId: targetFolderId(ctx),
      memberId: input.userId,
    })
    return { removed: true as const }
  },
})

export const folderInvitesList = defineCommand({
  ...read,
  id: 'folder.invites.list',
  title: 'List pending folder invites',
  description:
    'Email invites to the folder not accepted yet (id, email, role, sent and expiry time); one becomes a ' +
    'member when the person signs in. Folder owners only.',
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
  routes: [GET('/folders/:id/invites')],
  examples: [{ title: 'Pending folder invites', input: {} }],
  async handler(ctx) {
    return {
      invites: await requireServices(ctx).folderSharing.listInvites({
        userId: ctx.actor.userId,
        folderId: targetFolderId(ctx),
      }),
    }
  },
})

export const folderInvitesCancel = defineCommand({
  ...change,
  id: 'folder.invites.cancel',
  title: 'Cancel a folder invite',
  description:
    'Withdraw a pending email invite to the folder (id from folder.invites.list): signing in with that ' +
    'address no longer makes the person a member. Confirm with the user first. Folder owners only.',
  input: z.strictObject({ inviteId: IdSchema.describe('Invite id (folder.invites.list)') }),
  output: z.object({ cancelled: z.literal(true) }),
  routes: [DELETE('/folders/:id/invites/:inviteId')],
  examples: [{ title: 'Cancel a folder invite', input: { inviteId: 'folder_invite_fixture' } }],
  async handler(ctx, input) {
    await requireServices(ctx).folderSharing.cancelInvite({
      userId: ctx.actor.userId,
      folderId: targetFolderId(ctx),
      inviteId: input.inviteId,
    })
    return { cancelled: true as const }
  },
})

export const folderSharingCommands = [
  folderMembersList,
  folderMembersInvite,
  folderMembersSetRole,
  folderMembersRemove,
  folderInvitesList,
  folderInvitesCancel,
]
