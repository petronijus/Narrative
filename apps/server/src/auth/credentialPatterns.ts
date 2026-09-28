/**
 * auth/credentialPatterns.ts — every Narrative bearer credential format, for
 * the places that must never keep one — the Sentry scrubber
 * (observability/sentry.ts), the agent audit log (agent/opRedaction.ts) and
 * the agent eval's recordings (tests/agent-eval/lib/report.ts) — and for
 * the WebSocket, which refuses every one of them (hocuspocus/authenticate.ts).
 *
 *   nrt_  personal access token          (auth/personalAccessTokens.ts)
 *   nmo_  MCP OAuth access token         (mcp/oauth)
 *   nmr_  MCP OAuth refresh token
 *   nmc_  MCP OAuth authorization code
 *   nms_  MCP OAuth client secret
 *   nus_  upload session token           (media/uploadSessions.ts)
 *
 * A NEW credential format must be added here (and its test in
 * credentialPatterns.test.ts), or it leaks through all of them.
 */

export const CREDENTIAL_PREFIXES = ['nrt', 'nmo', 'nmr', 'nmc', 'nms', 'nus'] as const

/** Any Narrative credential anywhere in a string; group 1 is its prefix (without `_`). */
export function credentialPattern(): RegExp {
  return new RegExp(`\\b(${CREDENTIAL_PREFIXES.join('|')})_[A-Za-z0-9_-]+`, 'g')
}

/** `value` with every Narrative credential's secret replaced by `mask` (the prefix is kept). */
export function maskCredentials(value: string, mask: string): string {
  return value.replace(credentialPattern(), `$1_${mask}`)
}

/** Whether a value claims to be a Narrative credential of any kind (well-formed or not). */
export function looksLikeNarrativeCredential(value: string | null | undefined): value is string {
  return typeof value === 'string' && CREDENTIAL_PREFIXES.some((p) => value.startsWith(`${p}_`))
}
