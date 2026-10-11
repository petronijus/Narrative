/**
 * http/htmlHeaders.ts
 *
 * Headers of the small pages the server renders itself — the MCP OAuth
 * consent and error pages (mcp/oauth/routes.ts) and the desktop sign-in
 * hand-off page (ADR 0014). They hold credentials or decisions, so they are
 * never cached, never framed, and run no script.
 */

import type { FastifyReply } from 'fastify'

/** No cache may keep the response (a token, a code or a page that carries one). */
export function noStore(reply: FastifyReply): FastifyReply {
  return reply.header('cache-control', 'no-store').header('pragma', 'no-cache')
}

/**
 * Headers of a server-rendered page. `formTargets` are where the page's form
 * may post; a page with a form gets `same-origin` as its referrer policy, not
 * `no-referrer` (see mcp/oauth/pages.ts `PageReferrerPolicy`: under
 * `no-referrer` the page's own form posts with `Origin: null`, which the
 * decision endpoint refuses). The page's `<meta name="referrer">` says the
 * same — it overrides this header, which is how the first fix, header only,
 * missed.
 */
export function htmlHeaders(reply: FastifyReply, formTargets: readonly string[]): FastifyReply {
  return noStore(reply)
    .type('text/html; charset=utf-8')
    .header('x-frame-options', 'DENY')
    .header('referrer-policy', formTargets.length > 0 ? 'same-origin' : 'no-referrer')
    .header(
      'content-security-policy',
      [
        "default-src 'none'",
        "style-src 'unsafe-inline'",
        `form-action ${formTargets.length > 0 ? formTargets.join(' ') : "'none'"}`,
        "frame-ancestors 'none'",
        "base-uri 'none'",
      ].join('; '),
    )
}
