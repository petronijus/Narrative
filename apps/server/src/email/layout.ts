/**
 * email/layout.ts
 *
 * The one look every Narrative email shares: the warm paper of the app icon,
 * black type, one black call to action, a single blue accent. A message
 * (email/templates/*.ts) fills the blocks; the layout owns the shell, the
 * brand row, the person who acted, the footer and the plaintext twin.
 *
 * Email rendering constraints honoured here:
 *   - **Tables for layout**. Outlook routes HTML through the Word engine (no
 *     flex / grid / margin-on-block). Every column is a `<td>`.
 *   - **Inline styles only**. Gmail and Yahoo strip <style> tags.
 *   - **System font stack**. Custom @font-face works in ~half of clients.
 *   - **No background-image**; images are plain `<img>` with width, height
 *     and alt text, so a client that blocks images still reads well.
 *   - **Width 600 px**, light mode only (`color-scheme: light`).
 *   - **Plaintext fallback** mirrors the HTML's structure.
 *
 * Every dynamic string goes through `escapeHtml` here; a message passes raw
 * text, and only `Html`-branded fragments it built with the helpers below.
 */

/** Narrative's tagline — the home screen's subline, the only one we use. */
export const TAGLINE = 'Pro tool for keynote masters'

// Palette (the app icon: black on warm paper)
export const PAPER = '#efe9df'
export const INK = '#111111'
export const INK_SOFT = '#3f3d39'
export const MUTED = '#86827a'
export const RULE = '#e6e0d5'
export const ACCENT = '#1a8cff'
export const ACCENT_TINT = '#e8f3ff'
export const WARN = '#b4231a'
export const WARN_TINT = '#fdecea'
export const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif"

/** An HTML fragment built from escaped parts — the only HTML a message may hand the layout. */
export type Html = string & { readonly __html: true }

export const html = (s: string): Html => s as Html

export function escapeHtml(s: string): string {
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

/** The web app's public origin, as the emails link to it. */
export function appOrigin(): string {
  return (
    process.env['SPA_ORIGIN'] ??
    process.env['PUBLIC_URL'] ??
    `https://${process.env['DOMAIN'] ?? 'localhost'}`
  )
}

/** A link that signs in with Google if needed, then lands on `path` of the web app. */
export function signInLink(path: string, origin = appOrigin()): string {
  return `${origin}/api/auth/start?returnTo=${encodeURIComponent(path)}`
}

export interface Badge {
  label: string
  tone?: 'accent' | 'warn'
}

export interface EmailContent {
  subject: string
  /** The inbox preview line. */
  preheader: string
  /** Who did it: their avatar, name and email over the headline. Absent for system notices. */
  actor?: { name: string; email: string }
  /** The small uppercase line over the headline. */
  eyebrow: string
  /** The headline, plain text; `\n` breaks the line. */
  headline: string
  /** Rows between the headline and the summary line (a preview, a details table). */
  body?: Html
  /** One sentence of what this means for the reader, with an optional badge on the right. */
  summary?: { text: string; badge?: Badge }
  /** The one button. */
  cta: { label: string; url: string }
  /** Small print under the button: plain text, `**bold**` allowed. */
  note?: string
  /** Footer: why the reader gets this email (plain text). */
  reason: string
  /** Plaintext lines describing the content (between the opening line and the link). */
  textLines: string[]
  /** The plaintext's opening line. */
  textIntro: string
  /** Public origin of the web app, for the logo; absent = a drawn "N". */
  logoOrigin?: string
}

export interface RenderedEmail {
  subject: string
  html: string
  text: string
}

/** `**bold**` in a plain-text note → escaped HTML with strong tags. */
function noteHtml(note: string): string {
  return escapeHtml(note).replace(
    /\*\*(.+?)\*\*/g,
    `<strong style="color:${INK_SOFT};font-weight:600;">$1</strong>`,
  )
}

function badgeHtml(badge: Badge): string {
  const warn = badge.tone === 'warn'
  return `<span style="display:inline-block;background:${warn ? WARN_TINT : ACCENT_TINT};color:${warn ? WARN : ACCENT};font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:0.02em;padding:5px 12px;border-radius:9999px;">${escapeHtml(badge.label)}</span>`
}

/** A two-column label/value table for the body (values are plain text). */
export function detailsTable(rows: Array<[string, string]>): Html {
  const cells = rows
    .map(
      ([label, value], i) => `<tr>
        <td style="padding:${i === 0 ? 2 : 12}px 16px 0 0;vertical-align:top;font-family:${FONT};font-size:12px;letter-spacing:0.02em;color:${MUTED};white-space:nowrap;">${escapeHtml(label)}</td>
        <td style="padding:${i === 0 ? 0 : 10}px 0 0 0;vertical-align:top;font-family:${FONT};font-size:14px;line-height:1.45;color:${INK};word-break:break-word;">${escapeHtml(value)}</td>
      </tr>`,
    )
    .join('')
  return html(`<tr><td style="padding:0 40px 28px 40px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#faf8f4;border:1px solid ${RULE};border-radius:12px;">
      <tr><td style="padding:18px 20px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0">${cells}</table>
      </td></tr>
    </table>
  </td></tr>`)
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
export function slidePreview(title: string, url: string | null | undefined, width: number): string {
  if (url === null || url === undefined || url === '') {
    return titleCard(title, width, width > 300 ? 26 : 14)
  }
  const height = Math.round((width * 9) / 16)
  return `<img src="${escapeHtml(url)}" width="${width}" height="${height}" alt="${escapeHtml(title)}"
       style="display:block;width:100%;max-width:${width}px;height:auto;border:1px solid ${RULE};border-radius:10px;background:${PAPER};">`
}

export function renderEmail(c: EmailContent): RenderedEmail {
  const logo =
    c.logoOrigin === undefined
      ? `<div style="width:36px;height:36px;border-radius:9px;background:${PAPER};border:1px solid ${RULE};font-family:${FONT};font-size:20px;font-weight:800;line-height:36px;text-align:center;color:${INK};">N</div>`
      : `<img src="${escapeHtml(c.logoOrigin)}/apple-touch-icon.png" width="36" height="36" alt="Narrative" style="display:block;width:36px;height:36px;border-radius:9px;border:1px solid ${RULE};">`
  const url = escapeHtml(c.cta.url)
  const headline = c.headline.split('\n').map(escapeHtml).join('<br>')

  const actorRow =
    c.actor === undefined
      ? ''
      : `<tr><td style="padding:36px 40px 0 40px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
            <td style="vertical-align:middle;padding-right:12px;">
              <div style="width:36px;height:36px;border-radius:50%;background:${INK};color:#ffffff;font-family:${FONT};font-size:13px;font-weight:600;line-height:36px;text-align:center;">${escapeHtml(initialsOf(c.actor.name, c.actor.email))}</div>
            </td>
            <td style="vertical-align:middle;font-family:${FONT};">
              <div style="font-size:14px;font-weight:600;color:${INK};line-height:1.3;">${escapeHtml(c.actor.name)}</div>
              <div style="font-size:12px;color:${MUTED};line-height:1.4;">${escapeHtml(c.actor.email)}</div>
            </td>
          </tr></table>
        </td></tr>`

  const summaryRow =
    c.summary === undefined
      ? ''
      : `<tr><td style="padding:0 40px 28px 40px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid ${RULE};border-bottom:1px solid ${RULE};">
            <tr>
              <td style="padding:16px 0;vertical-align:middle;font-family:${FONT};font-size:14px;line-height:1.5;color:${INK_SOFT};">${escapeHtml(c.summary.text)}</td>
              ${
                c.summary.badge === undefined
                  ? ''
                  : `<td align="right" style="padding:16px 0 16px 16px;vertical-align:middle;white-space:nowrap;">${badgeHtml(c.summary.badge)}</td>`
              }
            </tr>
          </table>
        </td></tr>`

  const text = [
    c.textIntro,
    '',
    ...c.textLines,
    ...(c.textLines.length > 0 ? [''] : []),
    `${c.cta.label}:`,
    `  ${c.cta.url}`,
    ...(c.note === undefined ? [] : ['', c.note.replace(/\*\*/g, '')]),
    '',
    `—`,
    `Narrative · ${TAGLINE}`,
    c.reason,
  ].join('\n')

  const body = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
  <title>${escapeHtml(c.subject)}</title>
</head>
<body style="margin:0;padding:0;background:${PAPER};font-family:${FONT};color:${INK};-webkit-font-smoothing:antialiased;">
  <div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:${PAPER};opacity:0;">${escapeHtml(c.preheader)}</div>

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

        ${actorRow}

        <!-- Headline -->
        <tr><td style="padding:${c.actor === undefined ? 36 : 24}px 40px 24px 40px;font-family:${FONT};">
          <div style="font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:${MUTED};padding-bottom:10px;">${escapeHtml(c.eyebrow)}</div>
          <div style="font-size:28px;font-weight:700;line-height:1.2;letter-spacing:-0.025em;color:${INK};">${headline}</div>
        </td></tr>

        ${c.body ?? ''}

        ${summaryRow}

        <!-- Call to action -->
        <tr><td style="padding:0 40px 20px 40px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
            <td align="center" bgcolor="${INK}" style="border-radius:9999px;background:${INK};">
              <a href="${url}" style="display:inline-block;padding:15px 30px;font-family:${FONT};font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:9999px;letter-spacing:-0.005em;">${escapeHtml(c.cta.label)}&nbsp;&nbsp;&rarr;</a>
            </td>
          </tr></table>
        </td></tr>

        <tr><td style="padding:0 40px 36px 40px;font-family:${FONT};font-size:13px;line-height:1.6;color:${MUTED};">
          ${c.note === undefined ? '' : noteHtml(c.note)}
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
          ${escapeHtml(c.reason)}<br>
          <strong style="color:${INK_SOFT};font-weight:600;">Narrative</strong> &middot; ${escapeHtml(TAGLINE)}
        </td></tr>
      </table>

    </td></tr>
  </table>
</body>
</html>`

  return { subject: c.subject, html: body, text }
}
