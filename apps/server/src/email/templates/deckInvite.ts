/**
 * email/templates/deckInvite.ts
 *
 * The "shared with you" email for a deck, and its twin for a folder: one
 * layout, the wording per kind. `access: 'invite'` (the default) announces a
 * pending invite, accepted by signing in; `access: 'granted'` tells someone
 * who already uses Narrative that the access is theirs at once.
 *
 * Look: Narrative's own — the warm paper of its icon, black type, one black
 * call to action, a single blue accent for the role. A deck shows its real
 * first-slide thumbnail (a signed imgproxy URL, fetched by the mail client);
 * a folder shows up to three of its decks. Without a thumbnail a deck gets a
 * dark title card instead.
 *
 * Design notes
 * ------------
 * Email rendering is the wild west. Constraints we honour here:
 *   - **Tables for layout**. Outlook still routes HTML through the Word
 *     engine (no flex / grid / margin-on-block). Every column is a `<td>`.
 *   - **Inline styles only**. Most clients (Gmail, Yahoo) strip <style>
 *     tags from the email body before render.
 *   - **System font stack**. Custom @font-face works in ~half of clients.
 *   - **No background-image**; images are plain `<img>` with width, height
 *     and alt text, so a client that blocks images still reads well.
 *   - **Width 600 px**. Standard mobile-friendly upper bound.
 *   - **Light mode only** (`color-scheme: light`): dark-mode email CSS is
 *     handled inconsistently.
 *   - **Plaintext fallback** mirrors the HTML's structure.
 *
 * Every dynamic field is `escapeHtml`-encoded before substitution.
 */

import type { DeckRole } from '../../auth/permissions.js'

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

export interface RenderedEmail {
  subject: string
  html: string
  text: string
}

// ---------------------------------------------------------------------------
// Palette (Narrative's icon: black on warm paper)
// ---------------------------------------------------------------------------

const PAPER = '#efe9df'
const INK = '#111111'
const INK_SOFT = '#3f3d39'
const MUTED = '#86827a'
const RULE = '#e6e0d5'
const ACCENT = '#1a8cff'
const ACCENT_TINT = '#e8f3ff'
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Avatar initials. Two-character cap, uppercase. */
function initialsOf(name: string, email: string): string {
  const source = name.trim().length > 0 ? name : email
  const parts = source.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '·'
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase()
}

function roleLabel(role: DeckRole): string {
  return role === 'owner' ? 'Co-owner' : role[0]!.toUpperCase() + role.slice(1)
}

/** What the role lets the recipient do, one sentence. */
function roleMeaning(role: DeckRole, noun: 'deck' | 'folder'): string {
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

/** A dark title card where no thumbnail exists — 16:9 at `width`. */
function titleCard(title: string, width: number, fontSize: number): string {
  const height = Math.round((width * 9) / 16)
  return `<table role="presentation" width="${width}" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:${width}px;">
  <tr><td height="${height}" align="center" valign="middle" style="height:${height}px;background:${INK};border:1px solid ${INK};border-radius:10px;padding:0 20px;">
    <div style="font-family:${FONT};font-size:${fontSize}px;font-weight:700;line-height:1.25;letter-spacing:-0.02em;color:#ffffff;">${escapeHtml(title)}</div>
  </td></tr>
</table>`
}

/** A 16:9 slide preview: the thumbnail, or a title card. */
function slidePreview(title: string, url: string | null | undefined, width: number): string {
  if (url === null || url === undefined || url === '') {
    return titleCard(title, width, width > 300 ? 26 : 14)
  }
  const height = Math.round((width * 9) / 16)
  return `<img src="${escapeHtml(url)}" width="${width}" height="${height}" alt="${escapeHtml(title)}"
       style="display:block;width:100%;max-width:${width}px;height:auto;border:1px solid ${RULE};border-radius:10px;background:${PAPER};">`
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

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
  const title = escapeHtml(kind.title)
  const inviter = escapeHtml(input.inviterName)
  const inviterEmail = escapeHtml(input.inviterEmail)
  const recipient = escapeHtml(input.recipientEmail)
  const role = escapeHtml(roleLabel(input.role))
  const meaning = escapeHtml(roleMeaning(input.role, noun))
  const url = escapeHtml(input.signInUrl)
  const initials = escapeHtml(initialsOf(input.inviterName, input.inviterEmail))
  const logo =
    input.appOrigin === undefined
      ? `<div style="width:36px;height:36px;border-radius:9px;background:${PAPER};border:1px solid ${RULE};font-family:${FONT};font-size:20px;font-weight:800;line-height:36px;text-align:center;color:${INK};">N</div>`
      : `<img src="${escapeHtml(input.appOrigin)}/apple-touch-icon.png" width="36" height="36" alt="Narrative" style="display:block;width:36px;height:36px;border-radius:9px;border:1px solid ${RULE};">`

  const subject = `${input.inviterName} shared "${kind.title}" with you on Narrative`
  const preheader = pending
    ? `${input.inviterName} invited you to the ${noun} "${kind.title}" — sign in with Google to open it.`
    : `${input.inviterName} gave you access to the ${noun} "${kind.title}". It's ready in Narrative.`

  // -------------------------------------------------------------------------
  // Plaintext
  // -------------------------------------------------------------------------
  const text = [
    `${input.inviterName} (${input.inviterEmail}) shared a Narrative ${noun} with you.`,
    '',
    `  ${noun === 'deck' ? 'Deck' : 'Folder'}:  ${kind.title}`,
    ...kind.textLines,
    `  Role:  ${roleLabel(input.role)} — ${roleMeaning(input.role, noun)}`,
    '',
    `Open the ${noun}:`,
    `  ${input.signInUrl}`,
    '',
    pending
      ? `Sign in with ${input.recipientEmail} — your access is bound to that Google account. The invite expires in 30 days.`
      : `It is already in your Narrative, under ${input.recipientEmail}.`,
    '',
    `—`,
    `Narrative · presentations, made together`,
  ].join('\n')

  // -------------------------------------------------------------------------
  // HTML
  // -------------------------------------------------------------------------
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:${PAPER};font-family:${FONT};color:${INK};-webkit-font-smoothing:antialiased;">
  <div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:${PAPER};opacity:0;">${escapeHtml(preheader)}</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAPER};">
    <tr><td align="center" style="padding:40px 16px 32px 16px;">

      <!-- Brand -->
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">
        <tr><td style="padding:0 8px 20px 8px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
            <td style="vertical-align:middle;padding-right:10px;">${logo}</td>
            <td style="vertical-align:middle;font-family:${FONT};font-size:17px;font-weight:700;letter-spacing:-0.01em;color:${INK};">Narrative</td>
          </tr></table>
        </td></tr>
      </table>

      <!-- Card -->
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:18px;overflow:hidden;box-shadow:0 1px 2px rgba(17,17,17,0.04),0 12px 32px rgba(17,17,17,0.06);">

        <!-- Who shared -->
        <tr><td style="padding:36px 40px 0 40px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
            <td style="vertical-align:middle;padding-right:12px;">
              <div style="width:36px;height:36px;border-radius:50%;background:${INK};color:#ffffff;font-family:${FONT};font-size:13px;font-weight:600;line-height:36px;text-align:center;">${initials}</div>
            </td>
            <td style="vertical-align:middle;font-family:${FONT};">
              <div style="font-size:14px;font-weight:600;color:${INK};line-height:1.3;">${inviter}</div>
              <div style="font-size:12px;color:${MUTED};line-height:1.4;">${inviterEmail}</div>
            </td>
          </tr></table>
        </td></tr>

        <!-- Headline -->
        <tr><td style="padding:24px 40px 24px 40px;font-family:${FONT};">
          <div style="font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:${MUTED};padding-bottom:10px;">
            ${pending ? `Invitation to a ${noun}` : `New ${noun} for you`}
          </div>
          <div style="font-size:28px;font-weight:700;line-height:1.2;letter-spacing:-0.025em;color:${INK};">
            ${pending ? 'You&rsquo;re invited to' : 'You now have access to'}<br>&ldquo;${title}&rdquo;
          </div>
        </td></tr>

        ${kind.preview}

        <!-- Role -->
        <tr><td style="padding:0 40px 28px 40px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid ${RULE};border-bottom:1px solid ${RULE};">
            <tr>
              <td style="padding:16px 0;vertical-align:middle;font-family:${FONT};font-size:14px;line-height:1.5;color:${INK_SOFT};">${meaning}</td>
              <td align="right" style="padding:16px 0 16px 16px;vertical-align:middle;white-space:nowrap;">
                <span style="display:inline-block;background:${ACCENT_TINT};color:${ACCENT};font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:0.02em;padding:5px 12px;border-radius:9999px;">${role}</span>
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- Call to action -->
        <tr><td style="padding:0 40px 20px 40px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
            <td align="center" bgcolor="${INK}" style="border-radius:9999px;background:${INK};">
              <a href="${url}" style="display:inline-block;padding:15px 30px;font-family:${FONT};font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:9999px;letter-spacing:-0.005em;">Open the ${noun}&nbsp;&nbsp;&rarr;</a>
            </td>
          </tr></table>
        </td></tr>

        <tr><td style="padding:0 40px 36px 40px;font-family:${FONT};font-size:13px;line-height:1.6;color:${MUTED};">
          ${
            pending
              ? `Sign in with Google as <strong style="color:${INK_SOFT};font-weight:600;">${recipient}</strong> &mdash; the invite is bound to that address and expires in 30 days. Not expecting it? You can ignore this email.`
              : `It&rsquo;s already in your Narrative &mdash; signed in as <strong style="color:${INK_SOFT};font-weight:600;">${recipient}</strong>.`
          }
        </td></tr>

        <!-- Plain URL fallback -->
        <tr><td style="padding:18px 40px 22px 40px;background:#faf8f4;border-top:1px solid ${RULE};font-family:${FONT};font-size:11px;line-height:1.6;color:${MUTED};">
          Button not working? Paste this link into your browser:<br>
          <a href="${url}" style="color:${MUTED};text-decoration:underline;word-break:break-all;">${url}</a>
        </td></tr>
      </table>

      <!-- Footer -->
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">
        <tr><td align="center" style="padding:22px 8px 0 8px;font-family:${FONT};font-size:11px;line-height:1.6;color:${MUTED};">
          You get this email because ${inviter} shared a ${noun} with ${recipient}.<br>
          <strong style="color:${INK_SOFT};font-weight:600;">Narrative</strong> &middot; presentations, made together
        </td></tr>
      </table>

    </td></tr>
  </table>
</body>
</html>`

  return { subject, html, text }
}
