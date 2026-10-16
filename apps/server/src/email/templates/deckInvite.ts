/**
 * email/templates/deckInvite.ts
 *
 * The "shared with you" email for a deck, and its twin for a folder. The
 * look is the shared layout's (email/layout.ts). `access: 'invite'` (the
 * default) announces a pending invite, accepted by signing in; `access:
 * 'granted'` tells someone who already uses Narrative that the access is
 * theirs at once. A deck shows its real first-slide thumbnail (a signed
 * imgproxy URL, fetched by the mail client); a folder shows up to three of
 * its decks. Without a thumbnail a deck gets a dark title card instead.
 */

import type { DeckRole } from '../../auth/permissions.js'
import {
  FONT,
  INK_SOFT,
  MUTED,
  html,
  renderEmail,
  slidePreview,
  escapeHtml,
  type RenderedEmail,
} from '../layout.js'

export type { RenderedEmail } from '../layout.js'

/** Whether the email announces a pending invite or access already given. */
export type EmailAccess = 'invite' | 'granted'

interface CommonInput {
  /** Lower-cased recipient email. */
  recipientEmail: string
  /** Display name of the person who shared. Falls back to email at the call site. */
  inviterName: string
  inviterEmail: string
  role: DeckRole
  /**
   * Where the button goes: `${SPA_ORIGIN}/api/auth/start?returnTo=/deck/<id>`
   * (signs in if needed, then lands on the deck or folder).
   */
  signInUrl: string
  /** `invite` (default): a pending invite; `granted`: access given at once. */
  access?: EmailAccess
  /** Public origin of the web app, for the logo (`${origin}/apple-touch-icon.png`). */
  appOrigin?: string
}

export interface DeckInviteEmailInput extends CommonInput {
  deckTitle: string
  /** The deck's first-slide thumbnail, a public URL; null or absent = a title card. */
  previewUrl?: string | null
}

/** One deck of a shared folder, for the folder email's preview row. */
export interface FolderEmailDeck {
  title: string
  previewUrl: string | null
}

export interface FolderInviteEmailInput extends CommonInput {
  folderName: string
  /** Up to three of its decks, most recently changed first. */
  decks?: FolderEmailDeck[]
  /** How many decks the folder holds in all. */
  deckCount?: number
}

export function roleLabel(role: DeckRole): string {
  return role === 'owner' ? 'Co-owner' : role[0]!.toUpperCase() + role.slice(1)
}

/** What the role lets the recipient do, one sentence. */
export function roleMeaning(role: DeckRole, noun: 'deck' | 'folder'): string {
  if (noun === 'deck') {
    if (role === 'viewer') return 'You can view and present it.'
    if (role === 'editor') return 'You can edit its slides, text and animations.'
    return 'You can edit it and share it with others.'
  }
  if (role === 'viewer') return 'You can view and present every deck in it.'
  if (role === 'editor') return 'You can edit its decks, components, fonts and design tokens.'
  return 'You can edit everything in it, and share, rename or delete it.'
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

export function renderDeckInviteEmail(input: DeckInviteEmailInput): RenderedEmail {
  return render(input, {
    noun: 'deck',
    title: input.deckTitle,
    preview: `<tr><td style="padding:0 40px 28px 40px;">${slidePreview(input.deckTitle, input.previewUrl, 520)}</td></tr>`,
    textLines: [],
  })
}

export function renderFolderInviteEmail(input: FolderInviteEmailInput): RenderedEmail {
  const decks = (input.decks ?? []).slice(0, 3)
  const count = input.deckCount ?? decks.length
  const more = count - decks.length
  const cellWidth = 164
  const cells = decks
    .map(
      (
        d,
        i,
      ) => `<td width="${cellWidth}" valign="top" style="width:${cellWidth}px;padding:0 ${i < decks.length - 1 ? 14 : 0}px 0 0;">
        ${slidePreview(d.title, d.previewUrl, cellWidth)}
        <div style="font-family:${FONT};font-size:12px;line-height:1.4;color:${INK_SOFT};padding-top:8px;">${escapeHtml(d.title)}</div>
      </td>`,
    )
    .join('')
  const preview =
    decks.length === 0
      ? ''
      : `<tr><td style="padding:0 40px 8px 40px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${cells}</tr></table>
    </td></tr>
    <tr><td style="padding:4px 40px 28px 40px;font-family:${FONT};font-size:12px;color:${MUTED};">
      ${escapeHtml(plural(count, 'deck', 'decks'))} in this folder${more > 0 ? ` &middot; ${more} more inside` : ''}
    </td></tr>`
  return render(input, {
    noun: 'folder',
    title: input.folderName,
    preview,
    textLines:
      decks.length === 0
        ? []
        : [
            `  Decks: ${plural(count, 'deck', 'decks')} — ${decks.map((d) => d.title).join(', ')}${more > 0 ? ', …' : ''}`,
          ],
  })
}

interface Kind {
  noun: 'deck' | 'folder'
  title: string
  /** Table rows between the headline and the role, or ''. */
  preview: string
  /** Extra plaintext lines under the title. */
  textLines: string[]
}

function render(input: CommonInput, kind: Kind): RenderedEmail {
  const pending = (input.access ?? 'invite') === 'invite'
  const { noun } = kind
  return renderEmail({
    subject: `${input.inviterName} shared "${kind.title}" with you on Narrative`,
    preheader: pending
      ? `${input.inviterName} invited you to the ${noun} "${kind.title}" — sign in with Google to open it.`
      : `${input.inviterName} gave you access to the ${noun} "${kind.title}". It's ready in Narrative.`,
    actor: { name: input.inviterName, email: input.inviterEmail },
    eyebrow: pending ? `Invitation to a ${noun}` : `New ${noun} for you`,
    headline: `${pending ? 'You’re invited to' : 'You now have access to'}\n“${kind.title}”`,
    body: html(kind.preview),
    summary: { text: roleMeaning(input.role, noun), badge: { label: roleLabel(input.role) } },
    cta: { label: `Open the ${noun}`, url: input.signInUrl },
    note: pending
      ? `Sign in with Google as **${input.recipientEmail}** — the invite is bound to that address and expires in 30 days. Not expecting it? You can ignore this email.`
      : `It’s already in your Narrative — signed in as **${input.recipientEmail}**.`,
    reason: `You get this email because ${input.inviterName} shared a ${noun} with ${input.recipientEmail}.`,
    textIntro: `${input.inviterName} (${input.inviterEmail}) shared a Narrative ${noun} with you.`,
    textLines: [
      `  ${noun === 'deck' ? 'Deck' : 'Folder'}:  ${kind.title}`,
      ...kind.textLines,
      `  Role:  ${roleLabel(input.role)} — ${roleMeaning(input.role, noun)}`,
      '',
      pending
        ? `Sign in with ${input.recipientEmail} — your access is bound to that Google account. The invite expires in 30 days.`
        : `It is already in your Narrative, under ${input.recipientEmail}.`,
    ],
    ...(input.appOrigin === undefined ? {} : { logoOrigin: input.appOrigin }),
  })
}
