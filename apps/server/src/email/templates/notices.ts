/**
 * email/templates/notices.ts
 *
 * The emails besides sharing (deckInvite.ts), all in the shared layout
 * (email/layout.ts): the admin role given or taken, an address allowed to
 * sign in, security notices (an access token created, an app connected), a
 * deck or folder deleted, an invitation accepted, access removed, and an
 * agent waiting for approval. Each takes plain values; the layout escapes.
 */

import { detailsTable, renderEmail, signInLink, type RenderedEmail } from '../layout.js'
import type { DeckRole } from '../../auth/permissions.js'
import { roleLabel } from './deckInvite.js'

/** Someone who acted: name (or email) and email. */
export interface Person {
  name: string
  email: string
}

interface Base {
  /** The recipient's address. */
  to: string
  /** The web app's public origin: links and the logo. */
  origin: string
}

const logo = (b: Base) => ({ logoOrigin: b.origin })

function when(at: Date): string {
  return at.toLocaleString('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/Prague',
  })
}

// ---------------------------------------------------------------------------
// Instance administration
// ---------------------------------------------------------------------------

export function renderAdminGrantedEmail(b: Base & { by: Person }): RenderedEmail {
  return renderEmail({
    subject: `${b.by.name} made you an admin of Narrative`,
    preheader: 'You now own every folder and deck, and decide who may sign in.',
    actor: b.by,
    eyebrow: 'Administration',
    headline: 'You’re now an admin\nof Narrative',
    body: detailsTable([
      ['Folders & decks', 'Owner of every one — except other people’s private Drafts'],
      ['People', 'Allow addresses to sign in, make or remove admins'],
      ['Emails', 'Turn each kind of Narrative email on or off'],
    ]),
    summary: {
      text: 'It’s a powerful role: keep it to the people who run Narrative.',
      badge: { label: 'Admin' },
    },
    cta: { label: 'Open Administration', url: signInLink('/admin', b.origin) },
    note: 'Administration is in your account menu, top right.',
    reason: `You get this email because ${b.by.name} changed your role on Narrative.`,
    textIntro: `${b.by.name} (${b.by.email}) made you an admin of Narrative.`,
    textLines: [
      '  You own every folder and deck, except other people’s private Drafts.',
      '  You allow people to sign in and make or remove admins.',
    ],
    ...logo(b),
  })
}

export function renderAdminRevokedEmail(b: Base & { by: Person }): RenderedEmail {
  return renderEmail({
    subject: `You’re no longer an admin of Narrative`,
    preheader: `${b.by.name} removed your admin role. You keep what is shared with you.`,
    actor: b.by,
    eyebrow: 'Administration',
    headline: 'You’re no longer an admin\nof Narrative',
    summary: {
      text: 'You keep your own folders and everything shared with you; the rest is no longer visible to you.',
      badge: { label: 'Member' },
    },
    cta: { label: 'Open Narrative', url: signInLink('/', b.origin) },
    note: `Not expected? Ask **${b.by.email}** or another admin.`,
    reason: `You get this email because ${b.by.name} changed your role on Narrative.`,
    textIntro: `${b.by.name} (${b.by.email}) removed your admin role on Narrative.`,
    textLines: ['  You keep your own folders and everything shared with you.'],
    ...logo(b),
  })
}

export function renderSignInAllowedEmail(b: Base & { by: Person }): RenderedEmail {
  return renderEmail({
    subject: `${b.by.name} invited you to Narrative`,
    preheader: 'You can now sign in to Narrative with your Google account.',
    actor: b.by,
    eyebrow: 'Welcome',
    headline: 'You can now sign in\nto Narrative',
    summary: {
      text: 'Keynote-grade presentations, built with your team — and with Claude.',
    },
    cta: { label: 'Sign in with Google', url: signInLink('/', b.origin) },
    note: `Use your Google account **${b.to}** — that is the address ${b.by.name} allowed. Decks and folders appear as soon as someone shares them with you.`,
    reason: `You get this email because ${b.by.name} allowed ${b.to} to sign in to Narrative.`,
    textIntro: `${b.by.name} (${b.by.email}) invited you to Narrative.`,
    textLines: [`  Sign in with your Google account ${b.to}.`],
    ...logo(b),
  })
}

// ---------------------------------------------------------------------------
// Security notices
// ---------------------------------------------------------------------------

export function renderAccessTokenCreatedEmail(
  b: Base & { name: string; scopes: string[]; expiresAt: Date; at: Date },
): RenderedEmail {
  const scopes = b.scopes.map((s) => s.toUpperCase()).join(', ')
  return renderEmail({
    subject: `A new access token was created for your Narrative account`,
    preheader: `“${b.name}” can act as you in Narrative. Not you? Revoke it now.`,
    eyebrow: 'Security notice',
    headline: 'A new access token\nwas created',
    body: detailsTable([
      ['Name', b.name],
      ['Scopes', scopes],
      ['Created', when(b.at)],
      ['Expires', when(b.expiresAt)],
    ]),
    summary: {
      text: 'The token acts as you, with your access to every deck and folder you can open.',
      badge: { label: 'Security', tone: 'warn' },
    },
    cta: { label: 'Review access tokens', url: signInLink('/settings/access-tokens', b.origin) },
    note: 'Was this you? Then there is nothing to do. If not, **revoke the token** on that page right away.',
    reason: `You get this email because an access token was created for ${b.to}.`,
    textIntro: 'A new access token was created for your Narrative account.',
    textLines: [`  Name:     ${b.name}`, `  Scopes:   ${scopes}`, `  Created:  ${when(b.at)}`],
    ...logo(b),
  })
}

export function renderAppConnectedEmail(
  b: Base & { appName: string; redirectHost: string; at: Date },
): RenderedEmail {
  return renderEmail({
    subject: `${b.appName} was connected to your Narrative account`,
    preheader: `${b.appName} can now act as you in Narrative. Not you? Disconnect it.`,
    eyebrow: 'Security notice',
    headline: `${b.appName} was connected\nto your account`,
    body: detailsTable([
      ['App', b.appName],
      ['Returns to', b.redirectHost],
      ['Connected', when(b.at)],
    ]),
    summary: {
      text: 'The app acts as you, with your access to every deck and folder you can open.',
      badge: { label: 'Security', tone: 'warn' },
    },
    cta: { label: 'Review connected apps', url: signInLink('/settings/access-tokens', b.origin) },
    note: 'Was this you? Then there is nothing to do. If not, **disconnect the app** on that page right away.',
    reason: `You get this email because an app was connected to ${b.to}.`,
    textIntro: `${b.appName} was connected to your Narrative account.`,
    textLines: [
      `  App:        ${b.appName}`,
      `  Returns to: ${b.redirectHost}`,
      `  When:       ${when(b.at)}`,
    ],
    ...logo(b),
  })
}

// ---------------------------------------------------------------------------
// What happened to shared things
// ---------------------------------------------------------------------------

export function renderDeletedEmail(
  b: Base & { by: Person; kind: 'deck' | 'folder'; title: string; deckCount?: number },
): RenderedEmail {
  const rows: Array<[string, string]> = [[b.kind === 'deck' ? 'Deck' : 'Folder', b.title]]
  if (b.kind === 'folder' && b.deckCount !== undefined)
    rows.push(['Decks in it', `${b.deckCount} — deleted with it`])
  return renderEmail({
    subject: `${b.by.name} deleted the ${b.kind} "${b.title}"`,
    preheader: `“${b.title}” is gone from Narrative for everyone it was shared with.`,
    actor: b.by,
    eyebrow: `${b.kind === 'deck' ? 'Deck' : 'Folder'} deleted`,
    headline: `“${b.title}”\nwas deleted`,
    body: detailsTable(rows),
    summary: {
      text: `It is gone for everyone it was shared with, and cannot be opened any more.`,
      badge: { label: 'Deleted', tone: 'warn' },
    },
    cta: { label: 'Open Narrative', url: signInLink('/', b.origin) },
    note: `Think this was a mistake? Ask **${b.by.email}**.`,
    reason: `You get this email because “${b.title}” was shared with ${b.to}.`,
    textIntro: `${b.by.name} (${b.by.email}) deleted the ${b.kind} "${b.title}".`,
    textLines: rows.map(([k, v]) => `  ${k}: ${v}`),
    ...logo(b),
  })
}

export function renderInviteAcceptedEmail(
  b: Base & { who: Person; kind: 'deck' | 'folder'; title: string; path: string },
): RenderedEmail {
  return renderEmail({
    subject: `${b.who.name} accepted your invitation to "${b.title}"`,
    preheader: `${b.who.name} signed in and can now open the ${b.kind}.`,
    actor: b.who,
    eyebrow: 'Invitation accepted',
    headline: `${b.who.name} joined\n“${b.title}”`,
    summary: { text: `They signed in to Narrative and can open the ${b.kind} now.` },
    cta: { label: `Open the ${b.kind}`, url: signInLink(b.path, b.origin) },
    reason: `You get this email because you invited ${b.who.email} to Narrative.`,
    textIntro: `${b.who.name} (${b.who.email}) accepted your invitation to the ${b.kind} "${b.title}".`,
    textLines: [],
    ...logo(b),
  })
}

export function renderAccessRemovedEmail(
  b: Base & { by: Person; kind: 'deck' | 'folder'; title: string; role: DeckRole },
): RenderedEmail {
  return renderEmail({
    subject: `Your access to "${b.title}" was removed`,
    preheader: `${b.by.name} removed your access to the ${b.kind} "${b.title}".`,
    actor: b.by,
    eyebrow: 'Access removed',
    headline: `You no longer have access\nto “${b.title}”`,
    body: detailsTable([
      [b.kind === 'deck' ? 'Deck' : 'Folder', b.title],
      ['Your role was', roleLabel(b.role)],
    ]),
    summary: { text: `The ${b.kind} no longer appears in your Narrative.` },
    cta: { label: 'Open Narrative', url: signInLink('/', b.origin) },
    note: `Think this is a mistake? Ask **${b.by.email}**.`,
    reason: `You get this email because ${b.to} had access to “${b.title}”.`,
    textIntro: `${b.by.name} (${b.by.email}) removed your access to the ${b.kind} "${b.title}".`,
    textLines: [`  Your role was: ${roleLabel(b.role)}`],
    ...logo(b),
  })
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export function renderAgentConfirmationEmail(
  b: Base & { agent: string; action: string; target: string; confirmPath: string; expiresAt: Date },
): RenderedEmail {
  return renderEmail({
    subject: `${b.agent} is waiting for your approval in Narrative`,
    preheader: `${b.agent} asks for your approval: ${b.action}. Decide before ${when(b.expiresAt)}.`,
    eyebrow: 'Approval needed',
    headline: `${b.agent} is waiting\nfor your approval`,
    body: detailsTable([
      ['Action', b.action],
      ['On', b.target],
      ['Expires', when(b.expiresAt)],
    ]),
    summary: {
      text: 'Nothing happens until you decide. Declining or letting it expire changes nothing.',
      badge: { label: 'Waiting' },
    },
    cta: { label: 'Review and decide', url: signInLink(b.confirmPath, b.origin) },
    note: 'You get this because the request has waited a few minutes without an answer.',
    reason: `You get this email because an agent acting as ${b.to} asked for approval.`,
    textIntro: `${b.agent} is waiting for your approval in Narrative.`,
    textLines: [
      `  Action:   ${b.action}`,
      `  On:       ${b.target}`,
      `  Expires:  ${when(b.expiresAt)}`,
    ],
    ...logo(b),
  })
}
