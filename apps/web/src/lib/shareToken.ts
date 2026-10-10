/**
 * lib/shareToken.ts
 *
 * A page opened from a share link carries `?share_token=` (so does the render
 * worker's page, whose render token is a share link). The deck document and
 * `GET /decks/:id` receive it already (state/hocuspocusAuth.ts,
 * state/DeckRoleContext.tsx); the reads a shared deck renders with — media
 * URLs, video info, the folder's and the deck's fonts — must carry it too,
 * or a visitor without a session gets 401 and the slide paints placeholders
 * and fallback fonts.
 */

import { shareTokenFrom } from '../state/hocuspocusAuth.js'

/** The current page's share token, or null (none, or no page at all). */
export function pageShareToken(): string | null {
  const search = globalThis.location?.search
  return search === undefined ? null : shareTokenFrom(search)
}

/** `url` with `share_token` appended when there is one; unchanged otherwise. */
export function withShareToken(url: string, shareToken: string | null = pageShareToken()): string {
  if (shareToken === null || shareToken === '') return url
  return `${url}${url.includes('?') ? '&' : '?'}share_token=${encodeURIComponent(shareToken)}`
}
