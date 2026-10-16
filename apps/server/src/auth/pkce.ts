/**
 * auth/pkce.ts
 *
 * PKCE with S256 (RFC 7636), shared by the MCP OAuth server
 * (mcp/oauth/service.ts) and the desktop sign-in tickets
 * (auth/desktopTickets.ts, ADR 0015): a client keeps a random verifier, sends
 * only its SHA-256 (the challenge) up front, and proves possession later by
 * presenting the verifier.
 */

import { createHash, timingSafeEqual } from 'node:crypto'

/** RFC 7636 §4.1: 43–128 characters of the unreserved set. */
export const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/
/** An S256 challenge: base64url of a SHA-256, unpadded — always 43 characters. */
export const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/

/** The S256 challenge of `verifier` (RFC 7636 §4.2). */
export function s256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url')
}

/** Whether `verifier` is well formed and hashes to `challenge`, compared in constant time. */
export function s256Matches(verifier: string, challenge: string): boolean {
  if (!PKCE_VERIFIER.test(verifier)) return false
  const actual = Buffer.from(s256(verifier), 'utf8')
  const expected = Buffer.from(challenge, 'utf8')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
