/**
 * shared/src/credentialPatterns.ts — every Narrative bearer credential
 * format, for the places that must never keep one — the telemetry scrubber
 * (telemetryScrub.ts: the server's and the editor's Sentry), the agent audit
 * log (server agent/opRedaction.ts) and the agent eval's recordings
 * (tests/agent-eval/lib/report.ts) — and for the WebSocket, which refuses
 * every one of them (server hocuspocus/authenticate.ts).
 *
 *   nrt_  personal access token          (auth/personalAccessTokens.ts)
 *   nmo_  MCP OAuth access token         (mcp/oauth)
 *   nmr_  MCP OAuth refresh token
 *   nmc_  MCP OAuth authorization code
 *   nms_  MCP OAuth client secret
 *   nus_  upload session token           (media/uploadSessions.ts)
 *   nrr_  render token                   (auth/renderTokens.ts; a share link
 *         for the render worker, so the WebSocket admits it only as
 *         `share_token`, never as a bearer)
 *   ndt_  desktop sign-in ticket         (auth/desktopTickets.ts; one-time,
 *         60 s, redeemed only with its PKCE verifier)
 *
 * A NEW credential format must be added here (and its test in
 * credentialPatterns.test.ts), or it leaks through all of them.
 */

export const CREDENTIAL_PREFIXES = ['nrt', 'nmo', 'nmr', 'nmc', 'nms', 'nus', 'nrr', 'ndt'] as const

/** Any Narrative credential anywhere in a string; group 1 is its prefix (without `_`). */
export function credentialPattern(): RegExp {
  return new RegExp(`\\b(${CREDENTIAL_PREFIXES.join('|')})_[A-Za-z0-9_-]+`, 'g')
}

/** `value` with every Narrative credential's secret replaced by `mask` (the prefix is kept). */
export function maskCredentials(value: string, mask: string): string {
  return value.replace(credentialPattern(), `$1_${mask}`)
}

/**
 * `value` with every `share_token=` value masked. A share link's id carries
 * no prefix (a bare nanoid, valid until revoked), so `maskCredentials` cannot
 * see it; it travels as this query parameter — and so does a render token.
 */
export function maskShareTokens(value: string, mask: string): string {
  return value.replace(/(share_token=)[^&#\s"'<>]*/g, `$1${mask}`)
}

/** Whether a value claims to be a Narrative credential of any kind (well-formed or not). */
export function looksLikeNarrativeCredential(value: string | null | undefined): value is string {
  return typeof value === 'string' && CREDENTIAL_PREFIXES.some((p) => value.startsWith(`${p}_`))
}
