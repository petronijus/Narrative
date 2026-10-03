/**
 * pages/moveMediaNotice.ts — what the folder page tells the user after a
 * deck moved, about the pictures and videos it linked from its old folder.
 *
 * The move copies them into the deck before it changes folders (a failure
 * there stops the move: the request fails and the page says so). What a
 * collaborator linked while the deck was moving is copied afterwards; if
 * that fails, the deck has moved but those pictures show nothing in the new
 * folder. The server reports it per deck (`MoveDecksResult.media`); this
 * turns it into one sentence, or null when everything came along.
 */

import type { MoveDecksResult } from '../api/client.js'

export function moveMediaNotice(result: MoveDecksResult): string | null {
  const entries = result.media ?? []
  const failed = entries.reduce((n, m) => n + m.copyFailed, 0)
  const errored = entries.some((m) => m.error !== undefined)
  if (failed === 0 && !errored) return null
  if (failed > 0) {
    const what = failed === 1 ? '1 picture or video' : `${failed} pictures or videos`
    return (
      `The deck moved, but ${what} added while it was moving could not be copied into it ` +
      'and will not show in its new folder. Insert them again there.'
    )
  }
  return (
    'The deck moved, but checking it for pictures or videos added while it was moving failed: ' +
    'some may not show in its new folder.'
  )
}
