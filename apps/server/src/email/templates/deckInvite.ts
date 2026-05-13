/**
 * email/templates/deckInvite.ts
 *
 * "You've been invited to a deck" email. Sent on:
 *   1. New pending invite (invitee has never logged in).
 *   2. Re-invite (role change on an existing pending invite) — same template,
 *      the row's id stays stable so old links still work.
 *
 * Design constraints:
 *   - Inline-styled HTML only — most mail clients strip <style> blocks.
 *   - Mirror every link with a plaintext URL for clients that drop HTML.
 *   - Keep subject + opening line specific (deck title + inviter name) so
 *     it reads like a personal note, not a marketing blast → better
 *     inbox placement.
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
   * caller builds it as `${SPA_ORIGIN}/auth/start?returnTo=/deck/<id>`.
   */
  signInUrl: string
}

export interface RenderedEmail {
  subject: string
  html: string
  text: string
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function roleLabel(role: DeckRole): string {
  return role === 'owner' ? 'co-owner' : role
}

export function renderDeckInviteEmail(input: DeckInviteEmailInput): RenderedEmail {
  const safeDeck = escapeHtml(input.deckTitle)
  const safeInviter = escapeHtml(input.inviterName)
  const safeInviterEmail = escapeHtml(input.inviterEmail)
  const safeRole = escapeHtml(roleLabel(input.role))
  const safeUrl = escapeHtml(input.signInUrl)

  const subject = `${input.inviterName} invited you to "${input.deckTitle}" on Narrative`

  const text = [
    `${input.inviterName} (${input.inviterEmail}) invited you as ${roleLabel(input.role)} on the Narrative deck "${input.deckTitle}".`,
    '',
    `Open the deck:`,
    `  ${input.signInUrl}`,
    '',
    `Sign in with the Google account ${input.recipientEmail} — your access is bound to that address.`,
    '',
    `If you didn't expect this invite, you can ignore this email. The invite expires in 30 days.`,
  ].join('\n')

  const html = `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1f2937;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f6f7f9;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:32px;">
        <tr><td>
          <h1 style="margin:0 0 16px 0;font-size:20px;font-weight:600;color:#111827;line-height:1.3;">
            ${safeInviter} invited you to a Narrative deck
          </h1>
          <p style="margin:0 0 12px 0;font-size:14px;line-height:1.6;color:#374151;">
            <strong style="color:#111827;">${safeInviter}</strong>
            (<a href="mailto:${safeInviterEmail}" style="color:#2563eb;text-decoration:none;">${safeInviterEmail}</a>)
            invited you as <strong>${safeRole}</strong> on:
          </p>
          <p style="margin:0 0 24px 0;font-size:16px;font-weight:600;color:#111827;line-height:1.4;">
            ${safeDeck}
          </p>
          <p style="margin:0 0 24px 0;">
            <a href="${safeUrl}" style="display:inline-block;background:#2563eb;color:#ffffff;font-weight:600;font-size:14px;text-decoration:none;padding:10px 20px;border-radius:8px;">
              Open the deck
            </a>
          </p>
          <p style="margin:0 0 16px 0;font-size:13px;line-height:1.6;color:#6b7280;">
            Sign in with the Google account
            <strong style="color:#374151;">${escapeHtml(input.recipientEmail)}</strong> —
            your access is bound to that address. The invite expires in 30 days.
          </p>
          <p style="margin:16px 0 0 0;font-size:12px;color:#9ca3af;">
            If the button doesn't work, paste this URL into your browser:<br>
            <a href="${safeUrl}" style="color:#6b7280;word-break:break-all;">${safeUrl}</a>
          </p>
        </td></tr>
      </table>
      <p style="margin:16px 0 0 0;font-size:11px;color:#9ca3af;">
        Sent by Narrative · ignore if unexpected
      </p>
    </td></tr>
  </table>
</body>
</html>`

  return { subject, html, text }
}
