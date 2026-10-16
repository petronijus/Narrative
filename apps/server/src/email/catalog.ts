/**
 * email/catalog.ts
 *
 * Every kind of email Narrative sends, in one list: its id, what it is for,
 * who gets it, and a preview with sample data. Admins turn each kind on or
 * off for the whole instance (`email_settings`, the admin screen); a kind
 * without a row is on. The send path asks `isEmailEnabled` first
 * (email/notify.ts), so turning a kind off stops it at once.
 */

import type { RenderedEmail } from './layout.js'
import { renderDeckInviteEmail, renderFolderInviteEmail } from './templates/deckInvite.js'
import {
  renderAccessRemovedEmail,
  renderAccessTokenCreatedEmail,
  renderAdminGrantedEmail,
  renderAdminRevokedEmail,
  renderAgentConfirmationEmail,
  renderAppConnectedEmail,
  renderDeletedEmail,
  renderInviteAcceptedEmail,
  renderSignInAllowedEmail,
} from './templates/notices.js'

export const EMAIL_KINDS = [
  'deck-shared',
  'folder-shared',
  'invite-accepted',
  'access-removed',
  'deleted',
  'sign-in-allowed',
  'admin-granted',
  'admin-revoked',
  'access-token-created',
  'app-connected',
  'agent-confirmation',
] as const

export type EmailKind = (typeof EMAIL_KINDS)[number]

export function isEmailKind(value: string): value is EmailKind {
  return (EMAIL_KINDS as readonly string[]).includes(value)
}

export interface EmailKindInfo {
  kind: EmailKind
  /** A short name for the admin screen. */
  label: string
  /** When it is sent, one sentence. */
  description: string
  /** Who gets it. */
  recipient: string
  group: 'Sharing' | 'People' | 'Security' | 'Agents'
  /** The email with sample data, for the admin screen's preview. */
  preview(origin: string): RenderedEmail
}

const PETR = { name: 'Petr Novák', email: 'petr@example.com' }
const JANA = { name: 'Jana Svobodová', email: 'jana@example.com' }
const HOUR = 60 * 60 * 1000

export const EMAIL_CATALOG: readonly EmailKindInfo[] = [
  {
    kind: 'deck-shared',
    group: 'Sharing',
    label: 'Deck shared',
    description:
      'A deck is shared with someone: an invitation for a new address, a notice for someone who already uses Narrative (also on a new role).',
    recipient: 'The person it is shared with',
    preview: (origin) =>
      renderDeckInviteEmail({
        recipientEmail: JANA.email,
        inviterName: PETR.name,
        inviterEmail: PETR.email,
        role: 'editor',
        access: 'granted',
        deckTitle: 'Q4 Brand Strategy',
        signInUrl: `${origin}/deck/sample`,
        appOrigin: origin,
      }),
  },
  {
    kind: 'folder-shared',
    group: 'Sharing',
    label: 'Folder shared',
    description:
      'A folder is shared with someone, with its latest decks: an invitation for a new address, a notice for someone who already uses Narrative.',
    recipient: 'The person it is shared with',
    preview: (origin) =>
      renderFolderInviteEmail({
        recipientEmail: JANA.email,
        inviterName: PETR.name,
        inviterEmail: PETR.email,
        role: 'viewer',
        folderName: 'Client pitches',
        deckCount: 5,
        decks: [
          { title: 'Q4 Brand Strategy', previewUrl: null },
          { title: 'Launch plan', previewUrl: null },
          { title: 'Design Ops 2027', previewUrl: null },
        ],
        signInUrl: `${origin}/folder/sample`,
        appOrigin: origin,
      }),
  },
  {
    kind: 'invite-accepted',
    group: 'Sharing',
    label: 'Invitation accepted',
    description: 'Someone invited to a deck or folder signs in for the first time.',
    recipient: 'The person who invited them',
    preview: (origin) =>
      renderInviteAcceptedEmail({
        to: PETR.email,
        origin,
        who: JANA,
        kind: 'deck',
        title: 'Q4 Brand Strategy',
        path: '/deck/sample',
      }),
  },
  {
    kind: 'access-removed',
    group: 'Sharing',
    label: 'Access removed',
    description: 'An owner removes someone from a deck or a folder.',
    recipient: 'The person removed',
    preview: (origin) =>
      renderAccessRemovedEmail({
        to: JANA.email,
        origin,
        by: PETR,
        kind: 'folder',
        title: 'Client pitches',
        role: 'editor',
      }),
  },
  {
    kind: 'deleted',
    group: 'Sharing',
    label: 'Deck or folder deleted',
    description: 'A shared deck or folder is deleted.',
    recipient: 'Everyone else it was shared with',
    preview: (origin) =>
      renderDeletedEmail({
        to: JANA.email,
        origin,
        by: PETR,
        kind: 'folder',
        title: 'Client pitches',
        deckCount: 5,
      }),
  },
  {
    kind: 'sign-in-allowed',
    group: 'People',
    label: 'Allowed to sign in',
    description: 'An admin allows an email address to sign in to Narrative.',
    recipient: 'The person allowed',
    preview: (origin) => renderSignInAllowedEmail({ to: JANA.email, origin, by: PETR }),
  },
  {
    kind: 'admin-granted',
    group: 'People',
    label: 'Made an admin',
    description: 'An admin makes someone an admin.',
    recipient: 'The new admin',
    preview: (origin) => renderAdminGrantedEmail({ to: JANA.email, origin, by: PETR }),
  },
  {
    kind: 'admin-revoked',
    group: 'People',
    label: 'Admin role removed',
    description: 'An admin takes the admin role away from someone.',
    recipient: 'The former admin',
    preview: (origin) => renderAdminRevokedEmail({ to: JANA.email, origin, by: PETR }),
  },
  {
    kind: 'access-token-created',
    group: 'Security',
    label: 'Access token created',
    description: 'A personal access token is created on an account (for Claude Code or scripts).',
    recipient: 'The account owner',
    preview: (origin) =>
      renderAccessTokenCreatedEmail({
        to: JANA.email,
        origin,
        name: 'MacBook — Claude Code',
        scopes: ['mcp'],
        at: new Date(),
        expiresAt: new Date(Date.now() + 90 * 24 * HOUR),
      }),
  },
  {
    kind: 'app-connected',
    group: 'Security',
    label: 'App connected',
    description: 'An app (such as a claude.ai connector) is connected to an account over OAuth.',
    recipient: 'The account owner',
    preview: (origin) =>
      renderAppConnectedEmail({
        to: JANA.email,
        origin,
        appName: 'Claude',
        redirectHost: 'claude.ai',
        at: new Date(),
      }),
  },
  {
    kind: 'agent-confirmation',
    group: 'Agents',
    label: 'Agent waiting for approval',
    description:
      'An agent (Claude) asked to confirm an action and nobody answered within a few minutes.',
    recipient: 'The person the agent acts for',
    preview: (origin) =>
      renderAgentConfirmationEmail({
        to: JANA.email,
        origin,
        agent: 'Claude',
        action: 'Share a deck with a person',
        target: 'Q4 Brand Strategy',
        confirmPath: '/confirm/sample',
        expiresAt: new Date(Date.now() + 0.25 * HOUR),
      }),
  },
]

export function emailKindInfo(kind: EmailKind): EmailKindInfo {
  return EMAIL_CATALOG.find((k) => k.kind === kind)!
}
