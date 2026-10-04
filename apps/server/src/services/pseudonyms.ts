/**
 * services/pseudonyms.ts — a stable stand-in for a user id where the reader
 * may know that someone is there, and their display name, but not who they
 * are: the folder's active editors as a viewer or editor sees them (only
 * owners get user ids and emails — security review, folder sharing step 4).
 *
 * An HMAC of (folder, sub) with a secret drawn at process start: stable
 * while the server runs, so a polling page keeps one colour per person;
 * different per folder, so it cannot correlate people across folders; and
 * not recomputable by anyone who knows a sub. A restart draws a new secret,
 * which only re-colours the presence bubbles.
 */

import { createHmac, randomBytes } from 'node:crypto'

const SECRET = randomBytes(32)

/** The opaque id of `sub` among the active editors of `folderId` (`peer-` + 16 characters). */
export function folderPeerPseudonym(folderId: string, sub: string): string {
  const mac = createHmac('sha256', SECRET).update(`folder:${folderId}\n${sub}`, 'utf8')
  return `peer-${mac.digest('base64url').slice(0, 16)}`
}
