/**
 * state/hocuspocusAuth.ts — how the page authenticates a Hocuspocus
 * connection (the deck's document and its folder's token document).
 *
 * `token` must always be set: HocuspocusProvider sends its auth message only
 * when it has a token, and the server (it has an `onAuthenticate` hook)
 * holds every message of a connection until that message arrives — without
 * one a document never syncs. The value is a sentinel the server ignores
 * (`docs/adr/0005-server-side-session-cookies.md`):
 *
 *   - signed in: the server reads the `narrative_session` cookie on the
 *     WebSocket upgrade;
 *   - a share-link visit (`?share_token=…` in the page URL): the token goes
 *     as the `share_token` parameter, which the server checks first
 *     (apps/server/src/hocuspocus/authenticate.ts).
 */

/** The share token of the current page, or null. */
export function shareTokenFrom(search: string): string | null {
  return new URLSearchParams(search).get('share_token')
}

/** The HocuspocusProvider options that authenticate a connection from a page with this query string. */
export function hocuspocusAuthOptions(search: string): {
  token: string
  parameters?: { share_token: string }
} {
  const shareToken = shareTokenFrom(search)
  return shareToken === null
    ? { token: 'cookie' }
    : { token: 'cookie', parameters: { share_token: shareToken } }
}
