/**
 * email/templates/deckInvite.ts
 *
 * "You've been invited to a deck" email, and its twin for a folder (folder
 * sharing, step 3): one layout, the wording per kind.
 *
 * Design notes
 * ------------
 * Email rendering is the wild west. Constraints we honour here:
 *   - **Tables for layout**. Outlook still routes HTML through the Word
 *     engine (no flex / grid / margin-on-block). Every column is a `<td>`.
 *   - **Inline styles only**. Most clients (Gmail, Yahoo) strip <style>
 *     tags from the email body before render.
 *   - **System font stack**. Custom @font-face works in ~half of clients
 *     and looks visibly broken in the rest, so we use the SF/Segoe stack
 *     that every OS already has.
 *   - **No background-image**. Outlook needs a VML fallback for these;
 *     we use solid background-color + table cells to fake a gradient
 *     hero band.
 *   - **Width 600 px**. Standard mobile-friendly upper bound.
 *   - **Light mode primary**. Dark-mode-aware emails need a brittle
 *     `@media (prefers-color-scheme: dark)` block that several clients
 *     handle inconsistently — we accept light-mode-only for v1.
 *   - **Plaintext fallback** mirrors the HTML's structure for clients
 *     that drop HTML.
 *
 * Every dynamic field is `escapeHtml`-encoded before substitution.
 */

import type { DeckRole } from '../../auth/permissions.js'

export interface DeckInviteEmailInput {
  /** Lower-cased invitee email. */
  recipientEmail: string
  deckTitle: string
  /** Display name of the inviter. Falls back to email at the call site. */
  inviterName: string
  inviterEmail: string
  role: DeckRole
  /**
   * URL that lands the recipient at the right deck after sign-in. The
   * caller builds it as `${SPA_ORIGIN}/api/auth/start?returnTo=/deck/<id>`.
   */
  signInUrl: string
}

export interface FolderInviteEmailInput {
  /** Lower-cased invitee email. */
  recipientEmail: string
  folderName: string
  inviterName: string
  inviterEmail: string
  role: DeckRole
  /** `${SPA_ORIGIN}/api/auth/start?returnTo=/folder/<id>`. */
  signInUrl: string
}

export interface RenderedEmail {
  subject: string
  html: string
  text: string
}

/** What differs between a deck and a folder invitation. */
interface InviteWording {
  /** `deck` or `folder` — in "shared a Narrative deck with you". */
  noun: string
  /** The deck title or folder name. */
  title: string
  /** The preview card's label for it in the plaintext ("Deck", "Folder"). */
  label: string
  /** What the role covers, a sentence for the plaintext and the HTML; empty for none. */
  scope: string
}

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

/** Inviter avatar initials. Two-character cap, uppercase. */
function inviterInitials(name: string, email: string): string {
  const source = name.trim().length > 0 ? name : email
  const parts = source.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '·'
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase()
}

/** Deterministic, calm avatar colour from a string. */
function avatarColour(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0
  const hue = Math.abs(h) % 360
  // Constant S+L so the colour is brand-coherent, not chaotic.
  return `hsl(${hue}, 55%, 55%)`
}

function roleLabel(role: DeckRole): string {
  return role === 'owner' ? 'Co-owner' : role[0]!.toUpperCase() + role.slice(1)
}

/** Deterministic gradient stops for the deck-card preview, hashed off the title. */
function deckPreviewGradient(seed: string): { from: string; to: string } {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0
  const hue1 = Math.abs(h) % 360
  const hue2 = (hue1 + 40) % 360
  return {
    from: `hsl(${hue1}, 70%, 55%)`,
    to: `hsl(${hue2}, 75%, 45%)`,
  }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export function renderDeckInviteEmail(input: DeckInviteEmailInput): RenderedEmail {
  return renderInvite(input, { noun: 'deck', title: input.deckTitle, label: 'Deck', scope: '' })
}

export function renderFolderInviteEmail(input: FolderInviteEmailInput): RenderedEmail {
  return renderInvite(input, {
    noun: 'folder',
    title: input.folderName,
    label: 'Folder',
    scope: 'You see everything in it: its decks, components, fonts and design tokens.',
  })
}

function renderInvite(
  input: Omit<DeckInviteEmailInput, 'deckTitle'>,
  wording: InviteWording,
): RenderedEmail {
  const safeDeck = escapeHtml(wording.title)
  const safeScope = escapeHtml(wording.scope)
  const noun = wording.noun
  const safeInviter = escapeHtml(input.inviterName)
  const safeInviterEmail = escapeHtml(input.inviterEmail)
  const safeRecipient = escapeHtml(input.recipientEmail)
  const safeRole = escapeHtml(roleLabel(input.role))
  const safeUrl = escapeHtml(input.signInUrl)
  const initials = escapeHtml(inviterInitials(input.inviterName, input.inviterEmail))
  const inviterColour = avatarColour(input.inviterEmail)
  const gradient = deckPreviewGradient(wording.title)

  const subject = `${input.inviterName} shared "${wording.title}" with you on Narrative`

  // -------------------------------------------------------------------------
  // Plaintext
  // -------------------------------------------------------------------------
  const text = [
    `${input.inviterName} (${input.inviterEmail}) shared a Narrative ${noun} with you.`,
    '',
    `  ${wording.label}:  ${wording.title}`,
    `  Role:  ${roleLabel(input.role)}`,
    ...(wording.scope === '' ? [] : ['', wording.scope]),
    '',
    `Open the ${noun}:`,
    `  ${input.signInUrl}`,
    '',
    `Sign in with ${input.recipientEmail} — your access is bound to that Google account.`,
    `The invite expires in 30 days.`,
    '',
    `—`,
    `Narrative — pro tool for keynote masters.`,
  ].join('\n')

  // -------------------------------------------------------------------------
  // HTML
  // -------------------------------------------------------------------------
  // Common style fragments — inlined per element to survive client strippers.
  const fontStack =
    "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif"

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>${subject}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:${fontStack};color:#0f172a;-webkit-font-smoothing:antialiased;">
  <!-- Preheader — hidden in-body, shown in the inbox preview line. -->
  <div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:#f4f4f5;opacity:0;">
    ${safeInviter} shared "${safeDeck}" with you · open with one click
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f5;">
    <tr><td align="center" style="padding:32px 16px;">

      <!-- Card -->
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,0.06),0 8px 24px rgba(15,23,42,0.08);">

        <!-- Hero band -->
        <tr><td style="background:#0f172a;padding:24px 32px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td align="left" style="vertical-align:middle;">
                <span style="display:inline-block;font-size:18px;font-weight:700;letter-spacing:-0.01em;color:#ffffff;line-height:1;">
                  Narrative
                </span>
              </td>
              <td align="right" style="vertical-align:middle;font-size:12px;font-weight:500;color:#94a3b8;letter-spacing:0.04em;text-transform:uppercase;">
                Shared with you
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- Body -->
        <tr><td style="padding:36px 36px 8px 36px;">

          <!-- Inviter row -->
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px 0;">
            <tr>
              <td style="vertical-align:middle;padding-right:12px;">
                <div style="width:44px;height:44px;border-radius:50%;background:${inviterColour};color:#ffffff;font-size:14px;font-weight:600;line-height:44px;text-align:center;">
                  ${initials}
                </div>
              </td>
              <td style="vertical-align:middle;">
                <div style="font-size:14px;color:#475569;line-height:1.4;">
                  <strong style="color:#0f172a;font-weight:600;">${safeInviter}</strong>
                  invited you to a ${noun}
                </div>
                <div style="font-size:12px;color:#94a3b8;line-height:1.4;margin-top:2px;">
                  ${safeInviterEmail}
                </div>
              </td>
            </tr>
          </table>

          <!-- Deck preview card -->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px 0;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">
            <tr><td style="background:linear-gradient(135deg,${gradient.from},${gradient.to});background-color:${gradient.from};padding:48px 24px;text-align:center;">
              <div style="font-size:22px;font-weight:700;color:#ffffff;line-height:1.3;letter-spacing:-0.015em;text-shadow:0 1px 2px rgba(0,0,0,0.18);">
                ${safeDeck}
              </div>
            </td></tr>
            <tr><td style="background:#ffffff;padding:14px 20px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="vertical-align:middle;font-size:12px;color:#64748b;letter-spacing:0.02em;">
                    Your role
                  </td>
                  <td align="right" style="vertical-align:middle;">
                    <span style="display:inline-block;background:#eef2ff;color:#3730a3;font-size:12px;font-weight:600;letter-spacing:0.02em;padding:4px 10px;border-radius:9999px;">
                      ${safeRole}
                    </span>
                  </td>
                </tr>
              </table>
            </td></tr>
          </table>

          <!-- CTA -->
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 28px auto;">
            <tr><td align="center" style="border-radius:10px;background:#2563eb;">
              <a href="${safeUrl}"
                 style="display:inline-block;padding:13px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;letter-spacing:-0.005em;">
                Open the ${noun} &rarr;
              </a>
            </td></tr>
          </table>

          ${
            safeScope === ''
              ? ''
              : `<p style="margin:0 0 12px 0;font-size:13px;line-height:1.6;color:#475569;text-align:center;">${safeScope}</p>`
          }
          <p style="margin:0 0 12px 0;font-size:13px;line-height:1.6;color:#475569;text-align:center;">
            Sign in with <strong style="color:#0f172a;">${safeRecipient}</strong> —
            your access is bound to that Google account.
          </p>
          <p style="margin:0 0 8px 0;font-size:12px;line-height:1.6;color:#94a3b8;text-align:center;">
            This invite expires in 30 days. If you weren't expecting it, you can ignore this email.
          </p>

        </td></tr>

        <!-- Plain-text URL fallback (for clients that don't render the CTA) -->
        <tr><td style="padding:0 36px 24px 36px;">
          <hr style="border:0;border-top:1px solid #f1f5f9;margin:0 0 16px 0;">
          <p style="margin:0;font-size:11px;line-height:1.6;color:#94a3b8;">
            Trouble with the button? Paste this URL into your browser:<br>
            <a href="${safeUrl}" style="color:#64748b;text-decoration:underline;word-break:break-all;">${safeUrl}</a>
          </p>
        </td></tr>
      </table>

      <!-- Footer outside the card -->
      <p style="margin:16px 0 0 0;font-size:11px;line-height:1.5;color:#94a3b8;text-align:center;">
        <strong style="color:#64748b;font-weight:600;">Narrative</strong>
        &nbsp;·&nbsp; pro tool for keynote masters
      </p>

    </td></tr>
  </table>
</body>
</html>`

  return { subject, html, text }
}
