/**
 * scripts/revokeUserAccess.ts
 *
 * Ops kill switch: revoke every session and every agent credential
 * (personal access tokens, and any future OAuth tokens — see
 * auth/agentCredentials.ts) of one user, named by email or Google `sub`.
 * Then say whether the user could sign straight back in (env allowlist,
 * pending invite or deck permission), because revoking credentials does not
 * take that away — the operator has to (docs/deploy.md, "Revoking a user").
 *
 * Usage:
 *   dev:  pnpm --filter @narrative/server db:revoke-user <email|sub> [--dry-run]
 *   prod: docker exec narrative-server \
 *           node apps/server/dist/apps/server/src/scripts/revokeUserAccess.js <email|sub> [--dry-run]
 *
 * Reads POSTGRES_URL, OIDC_ALLOWED_EMAILS and OIDC_ALLOWED_DOMAIN from the
 * environment (inside the server container they are already set).
 *
 * Limitation: this runs in its own process, so it cannot close WebSocket
 * connections the running server already holds. An editor tab the user has
 * open keeps its live connection until it reconnects (its reconnect then
 * fails). For an immediate cut-off, restart the server after running this
 * (`docker compose … restart server`); every client reconnects and the
 * revoked user's reconnect is refused. HTTP requests, tus uploads and MCP
 * calls re-verify their credential on every request and stop at once.
 *
 * Exit codes: 0 done, 1 bad usage or unknown user, 2 done but the user can
 * still sign in again (the operator must act).
 */

import { revokeUserAccess, resolveUser } from '../auth/userAccess.js'
import { parseAdminEmails } from '../auth/admin.js'

function usage(message?: string): never {
  if (message) console.error(message)
  console.error('Usage: revokeUserAccess <email|sub> [--dry-run]')
  process.exit(1)
}

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const positional = args.filter((a) => !a.startsWith('--'))
const unknownFlags = args.filter((a) => a.startsWith('--') && a !== '--dry-run')
if (unknownFlags.length > 0) usage(`Unknown option: ${unknownFlags.join(', ')}`)
if (positional.length !== 1) usage()
const identifier = positional[0]!

const allowlist = {
  allowedEmails: (process.env['OIDC_ALLOWED_EMAILS'] ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean),
  allowedDomain: process.env['OIDC_ALLOWED_DOMAIN']?.trim() || undefined,
  adminEmails: parseAdminEmails(process.env['ADMIN_EMAILS']),
}

// Imported only now: db/client.ts connects (and throws without POSTGRES_URL)
// at import time, so usage errors above never need a database.
const { db, pool } = await import('../db/client.js')

let exitCode = 0
try {
  const user = await resolveUser(db, identifier)
  if (!user) {
    console.error(`No user with email ${identifier} has ever signed in.`)
    exitCode = 1
  } else {
    const report = await revokeUserAccess(db, user, { allowlist, dryRun })
    const who = user.email ? `${user.email} (${user.sub})` : user.sub
    const verb = dryRun ? 'Would revoke' : 'Revoked'
    console.log(
      `${verb} for ${who}: ${report.revoked.sessions} session(s), ` +
        `${report.revoked.personalAccessTokens} personal access token(s), ` +
        `${report.revoked.mcpOAuthGrants} connected app(s) (MCP OAuth grants), ` +
        `${report.revoked.uploadSessions} upload session(s).`,
    )
    if (!dryRun) {
      console.log('Admin role and allowed-emails entry removed (if there were any).')
      console.log(
        'Open editor connections and MCP sessions on the running server stay up until their ' +
          'next request or reconnect (which is refused); restart the server for an immediate cut-off.',
      )
    }
    if (report.stillAllowedBy !== null) {
      const how = {
        env: 'the env allowlist (OIDC_ALLOWED_EMAILS / OIDC_ALLOWED_DOMAIN) — edit .env.prod and redeploy',
        admin: 'ADMIN_EMAILS — edit .env.prod and redeploy',
        allowlist: 'the allowed emails list — remove the address in the admin screen',
        invite: 'a pending deck invite — cancel it',
        permission: 'a deck permission — remove it from the shared decks',
      }[report.stillAllowedBy]
      console.warn(`WARNING: this user can still sign in again, via ${how}.`)
      exitCode = 2
    }
  }
} finally {
  await pool.end()
}
process.exit(exitCode)
