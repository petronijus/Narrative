/**
 * email/client.ts
 *
 * Transactional email via Resend (https://resend.com).
 *
 * Env contract
 * ------------
 *   RESEND_API_KEY  Resend API key. When missing, sendEmail() logs to the
 *                   console instead of calling the API — keeps dev + first
 *                   prod boots from breaking while you're setting things up.
 *   EMAIL_FROM      e.g. `Narrative <noreply@example.com>`. Without a
 *                   verified domain in Resend, use `onboarding@resend.dev`
 *                   (Resend's shared dev sender — TO-addresses are limited
 *                   to the email of the Resend account owner).
 *
 * Failure semantics
 * -----------------
 * `sendEmail()` is best-effort. Every call site invokes it fire-and-forget;
 * the underlying database row (e.g. a `deck_invites` row) is the source of
 * truth and the notification is just a nudge. If the send fails we log and
 * carry on — never throw.
 */

import { Resend } from 'resend'

export interface SendEmailInput {
  to: string
  subject: string
  /** HTML body. Always provide; clients that strip HTML use `text`. */
  html: string
  /** Plain-text fallback. Required by most spam filters. */
  text: string
}

/**
 * Lazily-constructed Resend client. We hold a single instance for the
 * lifetime of the process; their SDK is thread-safe.
 */
let cached: Resend | null = null
function client(): Resend | null {
  const key = process.env['RESEND_API_KEY']
  if (!key) return null
  if (cached) return cached
  cached = new Resend(key)
  return cached
}

function emailFrom(): string {
  return process.env['EMAIL_FROM'] ?? 'Narrative <onboarding@resend.dev>'
}

/**
 * Sends a transactional email. Never throws; logs on failure.
 *
 * Returns the Resend message id when delivery was queued upstream, or
 * `null` when no API key is configured (developer mode — the message
 * content is logged so you can copy/paste it during local testing).
 */
export async function sendEmail(input: SendEmailInput): Promise<string | null> {
  const resend = client()
  if (!resend) {
    // No API key — log the would-be email and bail. This lets us run
    // dev + initial prod without crashing the invite path while DNS
    // verification is in flight.
    console.log('[email] RESEND_API_KEY missing — would-be email:', {
      to: input.to,
      subject: input.subject,
      text: input.text.slice(0, 200) + (input.text.length > 200 ? '…' : ''),
    })
    return null
  }

  try {
    const { data, error } = await resend.emails.send({
      from: emailFrom(),
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
    })
    if (error) {
      console.warn('[email] resend rejected', { to: input.to, error })
      return null
    }
    return data?.id ?? null
  } catch (err) {
    console.warn('[email] send threw', { to: input.to, err })
    return null
  }
}
