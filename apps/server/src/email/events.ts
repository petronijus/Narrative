/**
 * email/events.ts
 *
 * The notifications services send when something happens to a deck or a
 * folder people share — who to tell and what — on top of email/notify.ts
 * (the kind switch, fire-and-forget) and the templates.
 */

import { and, eq, ne } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import type { Database } from '../db/client.js'
import { deckPermissions, decks, folderPermissions, folders, users } from '../db/schema.js'
import type { DeckRole } from '../auth/permissions.js'
import { getUserBySub } from '../auth/users.js'
import { appOrigin } from './layout.js'
import { notify } from './notify.js'
import {
  renderAccessRemovedEmail,
  renderAccessTokenCreatedEmail,
  renderAgentConfirmationEmail,
  renderAppConnectedEmail,
  renderDeletedEmail,
  renderInviteAcceptedEmail,
} from './templates/notices.js'
import type { AcceptedInvite } from '../auth/invites.js'

interface Deps {
  db: Database
  log: Pick<FastifyBaseLogger, 'warn'>
}

/** A user as an email's actor: name (or email) and email. */
export function person(u: { name: string | null; email: string }): { name: string; email: string } {
  return { name: u.name ?? u.email, email: u.email }
}

/**
 * The audience reads below select a `notifyAudience` column: the marker
 * test-support/scriptedDb.ts answers on its own (nobody), so a service test
 * need not script who would be emailed. They never throw into the action
 * they announce: a failed read means nobody is emailed.
 */
type Row = { notifyAudience: string; sub: string }

/**
 * Everyone who can see a deck through a grant or its folder, but the actor:
 * read BEFORE the deck goes (the rows cascade away with it).
 */
export async function deckAudience(
  deps: Deps,
  deckId: string,
  actorId: string | undefined,
): Promise<string[]> {
  if (actorId === undefined) return []
  try {
    const { db } = deps
    const grants: Row[] = await db
      .select({ notifyAudience: users.email, sub: users.sub })
      .from(deckPermissions)
      .innerJoin(users, eq(users.sub, deckPermissions.userId))
      .where(eq(deckPermissions.deckId, deckId))
    const members: Row[] = await db
      .select({ notifyAudience: users.email, sub: users.sub })
      .from(decks)
      .innerJoin(folderPermissions, eq(folderPermissions.folderId, decks.folderId))
      .innerJoin(users, eq(users.sub, folderPermissions.userId))
      .where(eq(decks.id, deckId))
    return unique([...grants, ...members], actorId)
  } catch (err) {
    deps.log.warn({ err, deckId }, '[email] could not read who to tell')
    return []
  }
}

/** Everyone who can see a folder or one of its decks, but the actor (read BEFORE it goes). */
export async function folderAudience(
  deps: Deps,
  folderId: string,
  actorId: string | undefined,
): Promise<string[]> {
  if (actorId === undefined) return []
  try {
    const { db } = deps
    const members: Row[] = await db
      .select({ notifyAudience: users.email, sub: users.sub })
      .from(folderPermissions)
      .innerJoin(users, eq(users.sub, folderPermissions.userId))
      .where(eq(folderPermissions.folderId, folderId))
    const guests: Row[] = await db
      .select({ notifyAudience: users.email, sub: users.sub })
      .from(deckPermissions)
      .innerJoin(decks, eq(decks.id, deckPermissions.deckId))
      .innerJoin(users, eq(users.sub, deckPermissions.userId))
      .where(and(eq(decks.folderId, folderId), ne(deckPermissions.userId, actorId)))
    return unique([...members, ...guests], actorId)
  } catch (err) {
    deps.log.warn({ err, folderId }, '[email] could not read who to tell')
    return []
  }
}

/** A user's role on a deck before it changes (`notifyAudience` marker as above); null for none. */
export async function deckRoleBefore(
  deps: Deps,
  deckId: string,
  userId: string,
): Promise<DeckRole | null> {
  try {
    const [row] = await deps.db
      .select({ notifyAudience: deckPermissions.role })
      .from(deckPermissions)
      .where(and(eq(deckPermissions.deckId, deckId), eq(deckPermissions.userId, userId)))
      .limit(1)
    return (row?.notifyAudience as DeckRole | undefined) ?? null
  } catch {
    return null
  }
}

function unique(rows: Row[], actorId: string): string[] {
  return [
    ...new Set(rows.filter((r) => r.sub !== actorId).map((r) => r.notifyAudience.toLowerCase())),
  ]
}

/** Tell everyone who could see it that a deck or folder was deleted. */
export function notifyDeleted(
  deps: Deps,
  args: {
    actorId: string | undefined
    audience: string[]
    kind: 'deck' | 'folder'
    title: string
    deckCount?: number
  },
): void {
  if (args.actorId === undefined || args.audience.length === 0) return
  const actorId = args.actorId
  for (const to of args.audience) {
    void notify({
      ...deps,
      kind: 'deleted',
      to,
      render: async () => {
        const by = await getUserBySub(deps.db, actorId)
        if (by === null) return null
        return {
          ...renderDeletedEmail({
            to,
            origin: appOrigin(),
            by: person(by),
            kind: args.kind,
            title: args.title,
            ...(args.deckCount === undefined ? {} : { deckCount: args.deckCount }),
          }),
          replyTo: by.email,
        }
      },
    })
  }
}

/** Tell someone an owner removed their access to a deck or folder. */
export function notifyAccessRemoved(
  deps: Deps,
  args: {
    actorId: string
    memberId: string
    kind: 'deck' | 'folder'
    /** The deck title or folder name, or how to read it (in the background). */
    title: string | (() => Promise<string | null>)
    role: DeckRole
  },
): void {
  void (async () => {
    const [member, by, title] = await Promise.all([
      getUserBySub(deps.db, args.memberId),
      getUserBySub(deps.db, args.actorId),
      typeof args.title === 'string' ? args.title : args.title(),
    ])
    if (member === null || by === null || title === null) return
    await notify({
      ...deps,
      kind: 'access-removed',
      to: member.email,
      render: () => ({
        ...renderAccessRemovedEmail({
          to: member.email,
          origin: appOrigin(),
          by: person(by),
          kind: args.kind,
          title,
          role: args.role,
        }),
        replyTo: by.email,
      }),
    })
  })().catch((err: unknown) => deps.log.warn({ err }, '[email] access-removed failed'))
}

/** Tell each inviter that the person they invited signed in and joined. */
export function notifyInvitesAccepted(
  deps: Deps,
  args: { whoSub: string; accepted: AcceptedInvite[] },
): void {
  for (const invite of args.accepted) {
    void (async () => {
      const [who, inviter] = await Promise.all([
        getUserBySub(deps.db, args.whoSub),
        getUserBySub(deps.db, invite.invitedBySub),
      ])
      if (who === null || inviter === null || inviter.sub === who.sub) return
      await notify({
        ...deps,
        kind: 'invite-accepted',
        to: inviter.email,
        render: async () => {
          const title =
            invite.kind === 'deck'
              ? (
                  await deps.db
                    .select({ t: decks.title })
                    .from(decks)
                    .where(eq(decks.id, invite.id))
                    .limit(1)
                )[0]?.t
              : (
                  await deps.db
                    .select({ t: folders.name })
                    .from(folders)
                    .where(eq(folders.id, invite.id))
                    .limit(1)
                )[0]?.t
          if (title === undefined) return null
          return {
            ...renderInviteAcceptedEmail({
              to: inviter.email,
              origin: appOrigin(),
              who: person(who),
              kind: invite.kind,
              title,
              path: `/${invite.kind}/${invite.id}`,
            }),
            replyTo: who.email,
          }
        },
      })
    })().catch((err: unknown) => deps.log.warn({ err }, '[email] invite-accepted failed'))
  }
}

/** Security notice: a personal access token was created on the account. */
export function notifyAccessTokenCreated(
  deps: Deps,
  args: { userSub: string; name: string; scopes: string[]; expiresAt: Date },
): void {
  void (async () => {
    const owner = await getUserBySub(deps.db, args.userSub)
    if (owner === null) return
    await notify({
      ...deps,
      kind: 'access-token-created',
      to: owner.email,
      render: () =>
        renderAccessTokenCreatedEmail({
          to: owner.email,
          origin: appOrigin(),
          name: args.name,
          scopes: args.scopes,
          expiresAt: args.expiresAt,
          at: new Date(),
        }),
    })
  })().catch((err: unknown) => deps.log.warn({ err }, '[email] access-token-created failed'))
}

/** Security notice: an app was connected to the account over OAuth. */
export function notifyAppConnected(
  deps: Deps,
  args: { userSub: string; appName: string; redirectUri: string },
): void {
  void (async () => {
    const owner = await getUserBySub(deps.db, args.userSub)
    if (owner === null) return
    let host = args.redirectUri
    try {
      const url = new URL(args.redirectUri)
      host = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        ? 'this computer (a local app such as Claude Code)'
        : url.host
    } catch {
      // keep the raw value
    }
    await notify({
      ...deps,
      kind: 'app-connected',
      to: owner.email,
      render: () =>
        renderAppConnectedEmail({
          to: owner.email,
          origin: appOrigin(),
          appName: args.appName,
          redirectHost: host,
          at: new Date(),
        }),
    })
  })().catch((err: unknown) => deps.log.warn({ err }, '[email] app-connected failed'))
}

/** An agent's confirmation waits unanswered: email its person the link. */
export function notifyAgentConfirmation(
  deps: Deps,
  args: {
    userSub: string
    confirmationId: string
    agent: string | null
    action: string
    target: string | null
    expiresAt: Date
  },
): void {
  void (async () => {
    const owner = await getUserBySub(deps.db, args.userSub)
    if (owner === null) return
    await notify({
      ...deps,
      kind: 'agent-confirmation',
      to: owner.email,
      render: () =>
        renderAgentConfirmationEmail({
          to: owner.email,
          origin: appOrigin(),
          agent: args.agent ?? 'Your agent',
          action: args.action,
          target: args.target ?? 'your account',
          confirmPath: `/confirm/${args.confirmationId}`,
          expiresAt: args.expiresAt,
        }),
    })
  })().catch((err: unknown) => deps.log.warn({ err }, '[email] agent-confirmation failed'))
}
