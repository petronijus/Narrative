/**
 * agent/confirmationSummary.ts — what the user is asked to approve, in plain
 * words, built on the SERVER from the exact call (never from text the model
 * wrote): the command's title and first sentence, the target's title looked
 * up in the database, and one line per relevant input field — recipient and
 * role for sharing, the collaborator, invite or link a change affects, the
 * host a download would contact. Used by the confirmation page
 * (agent/confirmations.ts, routes/agentConfirmations.ts) and by the MCP
 * elicitation message (mcp/confirm.ts), which shows the same lines.
 *
 * Only facts the user may see are looked up: the host has already
 * authorised the user for the target, and every id in the input is resolved
 * WITHIN that target (a collaborator of this deck, an invite or link of this
 * deck, an asset of this deck, master or folder, a component of this folder, a
 * destination folder the user is a member of). Anything else is shown as the raw id,
 * so a model cannot use the page to look up a stranger's email.
 */

import { and, count, eq, gt, isNull, or } from 'drizzle-orm'
import type {
  AnyCommandDef,
  CommandTarget,
  ConditionalConfirmation,
  ConfirmationDetail,
} from '@narrative/commands'
import { sanitizePeerLabel } from '@narrative/shared'
import type { Database } from '../db/client.js'
import {
  components,
  deckInvites,
  deckPermissions,
  decks,
  folderPermissions,
  folders,
  mediaAssets,
  shareLinks,
  users,
} from '../db/schema.js'
import type { ConfirmationReason, ConfirmationSummary } from './confirmations.js'

/** Longest value shown on one line (characters). */
const MAX_VALUE = 200
/** Longest title / label looked up (characters). */
const MAX_LABEL = 120

/** Database lookups, each scoped to the already-authorised target. Null = unknown there. */
export interface ConfirmationLookups {
  deckTitle(deckId: string): Promise<string | null>
  folderName(folderId: string): Promise<string | null>
  componentName(componentId: string): Promise<string | null>
  /** A collaborator of `deckId` ("Jana Nováková (jana@example.com)"). */
  collaborator(deckId: string, userId: string): Promise<string | null>
  /** A pending invite of `deckId` ("jana@example.com as editor"). */
  invite(deckId: string, inviteId: string): Promise<string | null>
  /** A share link of `deckId` ("viewer link, created 27 Sep 2026"). */
  shareLink(deckId: string, linkId: string): Promise<string | null>
  /** A media asset of the deck, the component master or the folder (file name or kind). */
  asset(
    scope: { deckId?: string; componentId?: string; folderId?: string },
    assetId: string,
  ): Promise<string | null>
  /** A component master of `folderId`. */
  componentInFolder(folderId: string, componentId: string): Promise<string | null>
  /** A folder `userId` is a member of (a destination). */
  memberFolder(userId: string, folderId: string): Promise<string | null>
  /** How many decks a folder holds. */
  folderDeckCount(folderId: string): Promise<number>
  /** How many share links of `deckId` are active (not revoked, not expired). */
  activeShareLinks(deckId: string): Promise<number>
}

const ROLE_WORDS: Readonly<Record<string, string>> = {
  viewer: 'viewer — can look and present',
  editor: 'editor — can change the deck',
  owner: 'owner — can also share and delete it',
}

/** Labels for input fields that commonly need confirming. */
const FIELD_LABELS: Readonly<Record<string, string>> = {
  email: 'Recipient',
  role: 'Role',
  userId: 'Collaborator',
  inviteId: 'Invite',
  linkId: 'Share link',
  assetId: 'File',
  componentId: 'Component',
  folderId: 'Destination folder',
  expiresAt: 'Expires',
  title: 'Title',
  name: 'Name',
  fontFamily: 'Font family',
}

function clip(value: string, max = MAX_VALUE): string {
  return sanitizePeerLabel(value, max) ?? '(empty)'
}

function humanise(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** The first sentence of a description, for one line of "what it does". */
export function firstSentence(description: string): string {
  const match = /^(.*?[.!?])(\s|$)/s.exec(description.trim())
  return clip((match?.[1] ?? description).replace(/\s+/g, ' '), 300)
}

function scalar(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

/**
 * The summary of one exact call. `input` is the call's input as sent;
 * `conditional` is `confirmWhen`'s answer (already filtered by the host's
 * URL allowlist), null when only `confirm: 'always'` applies.
 */
export async function buildConfirmationSummary(args: {
  def: AnyCommandDef
  target: CommandTarget
  input: unknown
  userId: string
  reasons: readonly ConfirmationReason[]
  conditional: ConditionalConfirmation | null
  clientName: string | null
  lookups: ConfirmationLookups
}): Promise<ConfirmationSummary> {
  const { def, target, lookups } = args
  const input =
    typeof args.input === 'object' && args.input !== null && !Array.isArray(args.input)
      ? (args.input as Record<string, unknown>)
      : {}

  let kind: ConfirmationSummary['target']['kind'] = 'account'
  let label: string | null = null
  if (target.deckId !== undefined) {
    kind = 'deck'
    label = await lookups.deckTitle(target.deckId)
  } else if (target.componentId !== undefined) {
    kind = 'component'
    label = await lookups.componentName(target.componentId)
  } else if (target.folderId !== undefined) {
    kind = 'folder'
    label = await lookups.folderName(target.folderId)
  }

  const details: ConfirmationDetail[] = []
  for (const [key, raw] of Object.entries(input)) {
    const value = scalar(raw)
    if (value === null) continue
    let shown: string | null = null
    if (key === 'role') shown = ROLE_WORDS[value] ?? value
    else if (key === 'userId' && target.deckId !== undefined)
      shown = await lookups.collaborator(target.deckId, value)
    else if (key === 'inviteId' && target.deckId !== undefined)
      shown = await lookups.invite(target.deckId, value)
    else if (key === 'linkId' && target.deckId !== undefined)
      shown = await lookups.shareLink(target.deckId, value)
    else if (key === 'assetId')
      shown = await lookups.asset(
        target.deckId !== undefined
          ? { deckId: target.deckId }
          : target.componentId !== undefined
            ? { componentId: target.componentId }
            : target.folderId !== undefined
              ? { folderId: target.folderId }
              : {},
        value,
      )
    else if (key === 'componentId' && target.folderId !== undefined)
      shown = await lookups.componentInFolder(target.folderId, value)
    else if (key === 'folderId') shown = await lookups.memberFolder(args.userId, value)
    details.push({
      label: FIELD_LABELS[key] ?? humanise(key),
      value: clip(shown ?? value),
    })
  }
  if (def.id === 'share.links.create' && input['expiresAt'] === undefined)
    details.push({ label: 'Expires', value: 'never' })
  if (def.id === 'folder.delete' && target.folderId !== undefined) {
    const n = await lookups.folderDeckCount(target.folderId)
    details.push({ label: 'Decks deleted with it', value: String(n) })
  }
  if (def.id === 'media.delete') {
    // What removing it does differs by target (services/media.ts remove).
    details.push({
      label: 'What happens',
      value:
        target.componentId !== undefined
          ? 'Detached from the master and handed to its folder: it is not deleted, the slides it was stamped on keep showing it, and the master no longer owns it'
          : target.deckId === undefined && target.folderId !== undefined
            ? "Deleted with its file: the folder's decks that still show it go blank"
            : 'Deleted with its file: objects still showing it go blank',
    })
  }
  if (def.id === 'deck.moveToFolder' && target.deckId !== undefined) {
    // A share link follows the deck (ADR 0013): its holders then read the
    // destination folder's component media too.
    const links = await lookups.activeShareLinks(target.deckId)
    if (links > 0)
      details.push({
        label: 'Share links',
        value: `${links} active: whoever holds one will also see the destination folder's component pictures and videos`,
      })
  }
  for (const d of args.conditional?.details ?? [])
    details.push({ label: clip(d.label, 60), value: clip(d.value) })

  return {
    commandId: def.id,
    title: clip(def.title, MAX_LABEL),
    action: firstSentence(def.description),
    target: { kind, label: label === null ? null : clip(label, MAX_LABEL) },
    details,
    reasons: [...args.reasons],
    hosts: [...(args.conditional?.hosts ?? [])],
    clientName: args.clientName === null ? null : clip(args.clientName, 80),
  }
}

/**
 * The summary as plain text lines — the MCP elicitation message and the
 * `confirmation_required` error use it. Every fact on its own line.
 */
export function summaryLines(summary: ConfirmationSummary): string[] {
  const targetLine =
    summary.target.kind === 'account'
      ? 'Where: your Narrative account'
      : `${
          summary.target.kind === 'deck'
            ? 'Deck'
            : summary.target.kind === 'folder'
              ? 'Folder'
              : 'Component master'
        }: ${summary.target.label ?? '(untitled or not found)'}`
  return [
    `Action: ${summary.title}`,
    targetLine,
    ...summary.details.map((d) => `${d.label}: ${d.value}`),
    ...(summary.reasons.includes('irreversible') ? ['This cannot be undone with Revert.'] : []),
    ...(summary.reasons.includes('url_fetch')
      ? ['The web address is sent to that host; allow it only if you expect this download.']
      : []),
  ]
}

function shortDate(d: Date | null): string {
  if (d === null) return 'never'
  return d.toISOString().slice(0, 10)
}

function person(name: string | null, email: string | null, fallback: string): string {
  const n = sanitizePeerLabel(name, 60)
  if (n !== null && email !== null) return `${n} (${email})`
  return n ?? email ?? fallback
}

/**
 * Lookups that never fail the confirmation: a lookup that throws (database
 * down) is logged and answers "unknown", so the user still sees the ids and
 * can decide — a failed title lookup must not make an approval impossible,
 * nor turn into an unconfirmed run.
 */
export function failSafeLookups(
  lookups: ConfirmationLookups,
  onError: (lookup: string, err: unknown) => void,
): ConfirmationLookups {
  const wrapped = {} as Record<string, unknown>
  for (const [name, fn] of Object.entries(lookups) as Array<
    [string, (...args: unknown[]) => Promise<unknown>]
  >) {
    wrapped[name] = async (...args: unknown[]) => {
      try {
        return await fn(...args)
      } catch (err) {
        onError(name, err)
        return name === 'folderDeckCount' || name === 'activeShareLinks' ? 0 : null
      }
    }
  }
  return wrapped as unknown as ConfirmationLookups
}

/** The production lookups (Drizzle). */
export function createDbConfirmationLookups(db: Database): ConfirmationLookups {
  return {
    async deckTitle(deckId) {
      const [row] = await db
        .select({ title: decks.title })
        .from(decks)
        .where(eq(decks.id, deckId))
        .limit(1)
      return row?.title ?? null
    },
    async folderName(folderId) {
      const [row] = await db
        .select({ name: folders.name })
        .from(folders)
        .where(eq(folders.id, folderId))
        .limit(1)
      return row?.name ?? null
    },
    async componentName(componentId) {
      const [row] = await db
        .select({ name: components.name })
        .from(components)
        .where(eq(components.id, componentId))
        .limit(1)
      return row?.name ?? null
    },
    async collaborator(deckId, userId) {
      const [row] = await db
        .select({ name: users.name, email: users.email })
        .from(deckPermissions)
        .leftJoin(users, eq(users.sub, deckPermissions.userId))
        .where(and(eq(deckPermissions.deckId, deckId), eq(deckPermissions.userId, userId)))
        .limit(1)
      if (row === undefined) return null
      return person(row.name ?? null, row.email ?? null, userId)
    },
    async invite(deckId, inviteId) {
      const [row] = await db
        .select({ email: deckInvites.email, role: deckInvites.role })
        .from(deckInvites)
        .where(and(eq(deckInvites.deckId, deckId), eq(deckInvites.id, inviteId)))
        .limit(1)
      return row === undefined ? null : `${row.email} as ${row.role}`
    },
    async shareLink(deckId, linkId) {
      const [row] = await db
        .select({
          role: shareLinks.role,
          createdAt: shareLinks.createdAt,
          expiresAt: shareLinks.expiresAt,
        })
        .from(shareLinks)
        .where(and(eq(shareLinks.deckId, deckId), eq(shareLinks.id, linkId)))
        .limit(1)
      return row === undefined
        ? null
        : `${row.role} link created ${shortDate(row.createdAt)}, expires ${shortDate(row.expiresAt)}`
    },
    async asset(scope, assetId) {
      const where =
        scope.deckId !== undefined
          ? and(eq(mediaAssets.id, assetId), eq(mediaAssets.deckId, scope.deckId))
          : scope.componentId !== undefined
            ? and(eq(mediaAssets.id, assetId), eq(mediaAssets.componentId, scope.componentId))
            : scope.folderId !== undefined
              ? and(eq(mediaAssets.id, assetId), eq(mediaAssets.folderId, scope.folderId))
              : undefined
      if (where === undefined) return null
      const [row] = await db
        .select({ filename: mediaAssets.originalFilename, kind: mediaAssets.kind })
        .from(mediaAssets)
        .where(where)
        .limit(1)
      if (row === undefined) return null
      return row.filename !== null ? `${row.filename} (${row.kind})` : `a ${row.kind}`
    },
    async componentInFolder(folderId, componentId) {
      const [row] = await db
        .select({ name: components.name })
        .from(components)
        .where(and(eq(components.id, componentId), eq(components.folderId, folderId)))
        .limit(1)
      return row?.name ?? null
    },
    async memberFolder(userId, folderId) {
      const [row] = await db
        .select({ name: folders.name })
        .from(folders)
        .innerJoin(
          folderPermissions,
          and(eq(folderPermissions.folderId, folders.id), eq(folderPermissions.userId, userId)),
        )
        .where(eq(folders.id, folderId))
        .limit(1)
      return row?.name ?? null
    },
    async folderDeckCount(folderId) {
      const [row] = await db.select({ n: count() }).from(decks).where(eq(decks.folderId, folderId))
      return row?.n ?? 0
    },
    async activeShareLinks(deckId) {
      const [row] = await db
        .select({ n: count() })
        .from(shareLinks)
        .where(
          and(
            eq(shareLinks.deckId, deckId),
            eq(shareLinks.revoked, false),
            or(isNull(shareLinks.expiresAt), gt(shareLinks.expiresAt, new Date())),
          ),
        )
      return row?.n ?? 0
    },
  }
}
