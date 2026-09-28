/**
 * mcp/oauth/pages.ts — the two server-rendered pages of the OAuth flow:
 * the consent page and the error page. Deliberately plain HTML (no SPA, no
 * script): they must work before the web app is involved, and a page that
 * grants access should have as little code on it as possible.
 *
 * Every dynamic value is HTML-escaped. The response headers (routes.ts)
 * forbid framing (clickjacking a consent button), scripts and foreign form
 * targets.
 */

import type { PendingAuthorizationView } from './service.js'

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const STYLE = `
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; display: grid;
         place-items: center; min-height: 100vh; background: #f4f4f5; color: #18181b; }
  @media (prefers-color-scheme: dark) { body { background: #18181b; color: #f4f4f5; }
    main { background: #27272a !important; } .muted { color: #a1a1aa !important; } }
  main { background: #fff; border-radius: 12px; padding: 32px; max-width: 460px; width: calc(100% - 48px);
         box-shadow: 0 1px 3px rgba(0,0,0,.12); }
  h1 { font-size: 20px; margin: 0 0 16px; }
  ul { padding-left: 20px; } li { margin: 6px 0; }
  .muted { color: #52525b; font-size: 14px; }
  .warn { border-left: 3px solid #d97706; padding-left: 12px; }
  .dest { border: 1px solid #a1a1aa; border-radius: 8px; padding: 12px 16px; margin: 16px 0; font-size: 18px;
          overflow-wrap: anywhere; }
  .dest .muted { font-size: 14px; }
  form { display: flex; gap: 12px; margin-top: 24px; }
  button { flex: 1; font: inherit; padding: 10px 16px; border-radius: 8px; border: 1px solid #a1a1aa;
           background: transparent; color: inherit; cursor: pointer; }
  button.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
`

/**
 * A page's referrer policy — kept in its `<meta name="referrer">`, which
 * overrides the HTTP header. `same-origin` on a page with a form: under
 * `no-referrer` the browser posts the page's own form with `Origin: null`
 * (Fetch spec, origin serialisation for non-GET requests), which the
 * decision endpoint refuses — every consent failed that way until
 * 2026-09-28. `same-origin` still keeps the Referer from every other site.
 */
export type PageReferrerPolicy = 'no-referrer' | 'same-origin'

function page(title: string, body: string, referrer: PageReferrerPolicy = 'no-referrer'): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="${referrer}"><title>${escapeHtml(title)} · Narrative</title>
<style>${STYLE}</style></head><body><main>${body}</main></body></html>`
}

export interface ConsentPageInput {
  view: PendingAuthorizationView
  csrfToken: string
  /** Absolute URL the form posts to. */
  action: string
  userLabel: string
}

/**
 * The consent page. What it must make unmistakable (MCP authorization spec;
 * Anthropic's connector guidance):
 *   - WHERE the approval goes: the redirect URI's host, in a box of its own,
 *     because that is who receives the authorization code;
 *   - who vouches for the client's name: the host that published a metadata
 *     document, or nobody for a self-registered client;
 *   - on EVERY page, when the request was made and "only approve if you
 *     just started connecting": a consent link can be sent to a user by
 *     anyone (a phishing mail, a page that opens it), and the request time
 *     lets them notice one they did not start;
 *   - a warning when the approval returns to a program on this computer, and
 *     a stronger one when the client can ONLY return to this computer (its
 *     every redirect URI is a loopback address): such a request can be
 *     started by any local program, so the user must have started it.
 */
export function consentPage(input: ConsentPageInput): string {
  const { view } = input
  const name = escapeHtml(view.clientName)
  const destination = view.loopback
    ? `<strong>a program on this computer</strong> (<code>${escapeHtml(view.redirectHost)}</code>)`
    : `<strong>${escapeHtml(view.redirectHost)}</strong>`
  const identity =
    view.publisherHost !== null
      ? `<p class="muted">This application is described by <strong>${escapeHtml(view.publisherHost)}</strong>.</p>`
      : `<p class="muted">This application registered itself under this name; Narrative cannot verify it. Check where
         the approval is sent below.</p>`
  const requested = `<time datetime="${escapeHtml(view.createdAt.toISOString())}">${escapeHtml(
    formatUtc(view.createdAt),
  )}</time>`
  const startedWarning =
    view.loopback && view.loopbackOnly
      ? `<p class="warn"><strong>Only approve if you just started connecting Narrative from an application on this
         computer, such as Claude Code.</strong> This application can only receive the approval on this computer, so
         any program running here could have started this request. Requested ${requested}.</p>`
      : view.loopback
        ? `<p class="warn"><strong>Only approve if you just started connecting Narrative from an application such as
           Claude Code.</strong> This connection returns to a program on your own computer. Requested ${requested}.</p>`
        : `<p class="warn"><strong>Only approve if you just started connecting Narrative from ${name}.</strong> If you
           did not, choose Deny: someone may be trying to get access to your account. Requested ${requested}.</p>`
  const lifetime = view.offline
    ? 'It stays connected until you disconnect it: it renews its access by itself.'
    : 'Its access ends after one hour; it then has to ask you again.'
  return page(
    'Connect to Narrative',
    `<h1>Allow ${name} to use Narrative?</h1>
     <p><strong>${name}</strong> wants to act as <strong>${noEmailRewrite(escapeHtml(input.userLabel))}</strong> in
     Narrative.</p>
     ${identity}
     <div class="dest"><span class="muted">After you approve, you are sent to</span><br>${destination}</div>
     <p>With the <code>mcp</code> permission it can:</p>
     <ul>
       <li>read and edit every deck and folder you can open, with your role on each;</li>
       <li>create, import, export and delete decks, and share them — irreversible actions still ask you first.</li>
     </ul>
     <p class="muted">${lifetime}</p>
     ${startedWarning}
     <p class="muted">You can disconnect it at any time under Access tokens → Connected apps; its changes can be
     reverted from the deck's Agent activity.</p>
     <form method="post" action="${escapeHtml(input.action)}">
       <input type="hidden" name="request" value="${escapeHtml(view.id)}">
       <input type="hidden" name="csrf" value="${escapeHtml(input.csrfToken)}">
       <button type="submit" name="decision" value="deny">Deny</button>
       <button type="submit" name="decision" value="approve" class="primary">Allow</button>
     </form>`,
    'same-origin',
  )
}

/**
 * Keep an e-mail address readable behind Cloudflare: its Email Obfuscation
 * rewrites addresses in HTML into "[email protected]" plus an inline script
 * to decode them, and this page's CSP (rightly) blocks that script, so the
 * user saw "[email protected]" where their own address belongs.
 * Cloudflare skips what sits between these comments.
 */
function noEmailRewrite(html: string): string {
  return `<!--email_off-->${html}<!--/email_off-->`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `27 Sep 2026, 09:41 UTC` — server-rendered (the page runs no script, so no local time zone). */
export function formatUtc(at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}, ` +
    `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())} UTC`
  )
}

export function errorPage(message: string): string {
  return page('Cannot connect', `<h1>Cannot connect to Narrative</h1><p>${escapeHtml(message)}</p>`)
}

export function signInPage(signInUrl: string | null): string {
  return page(
    'Sign in to Narrative',
    signInUrl === null
      ? `<h1>Sign in to Narrative first</h1><p>Open Narrative in this browser, sign in, then reload this page.</p>`
      : `<h1>Sign in to Narrative first</h1><p><a href="${escapeHtml(signInUrl)}">Sign in</a> to continue connecting.</p>`,
  )
}
