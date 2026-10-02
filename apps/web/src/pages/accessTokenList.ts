/**
 * pages/accessTokenList.ts — the Access tokens page's list when the server's
 * answer arrives late.
 *
 * The page asks for the list once, on mount, and keeps it current itself: a
 * created token is added, a revoked one removed. The first answer can arrive
 * after either — on a slow connection or a busy server the user may already
 * have created or revoked a token — and it describes the server before those
 * changes. Taken as it is, it dropped a token the user had just created (it
 * existed and worked, but the page no longer showed it) and brought back one
 * they had just revoked.
 */

import type { AccessTokenSummary } from '../api/client.js'

/**
 * The list to show once the server's list arrives: the tokens created on
 * this page that it does not list yet (newest first, as the server orders
 * them), then the server's, without any revoked on this page meanwhile.
 * Only what this page created or revoked is kept over the server's answer;
 * everything else is the server's.
 */
export function mergeLoadedTokens(
  loaded: readonly AccessTokenSummary[],
  createdHere: readonly AccessTokenSummary[],
  revokedHere: ReadonlySet<string>,
): AccessTokenSummary[] {
  const known = new Set(loaded.map((t) => t.id))
  const createdMeanwhile = createdHere.filter((t) => !known.has(t.id))
  return [...createdMeanwhile, ...loaded].filter((t) => !revokedHere.has(t.id))
}
