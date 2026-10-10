// @vitest-environment node
/**
 * The production headers the in-browser export depends on
 * (infra/caddy/Caddyfile). The dev server sends no CSP, so the e2e suite
 * cannot see this: with framing denied, every "Export as PNG" on production
 * silently falls back to the render worker (0.10.22 shipped that way).
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const caddyfile = readFileSync(
  fileURLToPath(new URL('../../../../infra/caddy/Caddyfile', import.meta.url)),
  'utf8',
)
const cspFor = (matcher: string): string =>
  new RegExp(`header @${matcher} Content-Security-Policy "([^"]+)"`).exec(caddyfile)?.[1] ?? ''

describe('Caddyfile framing for the in-browser slide export', () => {
  it('lets this origin, and only it, frame the render page', () => {
    expect(caddyfile).toMatch(/@render_page path_regexp render_page \^\/deck\/\[\^\/\]\+\/render\$/)
    expect(caddyfile).toMatch(/header @render_page X-Frame-Options SAMEORIGIN/)
    expect(cspFor('render_page')).toContain("frame-ancestors 'self'")
  })

  it('lets the app frame its own pages, and nothing frame the rest', () => {
    expect(caddyfile).toMatch(/header @not_render_page X-Frame-Options DENY/)
    expect(cspFor('not_render_page')).toContain("frame-ancestors 'none'")
    expect(cspFor('not_render_page')).toContain("frame-src 'self'")
    expect(cspFor('render_page')).toContain("frame-src 'self'")
    // No blanket header left that would override either.
    expect(caddyfile).not.toMatch(/^\s*X-Frame-Options DENY\s*$/m)
  })
})
