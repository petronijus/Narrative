/**
 * stylePack/parse.ts — a style pack as a service accepts it (A4.3): the
 * shape (`StylePackSchema`) and the whole-pack rules (`validateStylePack`),
 * one error naming every problem by its path.
 */

import { StylePackSchema, validateStylePack, type StylePack } from '@narrative/shared'
import { CommandError } from '../errors.js'

/** At most this many problems are named in one error (the rest are counted). */
const MAX_LISTED = 20

/** Throws `invalid_input` naming the problems. */
export function parseStylePack(value: unknown): StylePack {
  const parsed = StylePackSchema.safeParse(value)
  const issues = parsed.success
    ? validateStylePack(parsed.data)
    : parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))
  if (issues.length === 0 && parsed.success) return parsed.data
  const listed = issues
    .slice(0, MAX_LISTED)
    .map((i) => `${i.path === '' ? 'pack' : i.path}: ${i.message}`)
  const more = issues.length > MAX_LISTED ? `; and ${issues.length - MAX_LISTED} more` : ''
  throw new CommandError(
    'invalid_input',
    `the style pack is not valid — ${listed.join('; ')}${more}`,
  )
}

/** Packs `storedStylePack` accepted, by identity: a live snapshot is checked once per change. */
const accepted = new WeakSet<object>()

/**
 * The folder's stored pack, checked before it is used to lay out or check
 * slides or to compile. Every write validates the pack, but the folder
 * document is a Yjs document any folder editor's client can write directly:
 * a malformed pack is refused here with its problems named (`conflict`),
 * not met later as a crash in layout or compile. Reading it (style.pack.get,
 * Folder Settings) stays possible, so it can be fixed.
 */
export function storedStylePack(pack: StylePack): StylePack {
  if (accepted.has(pack)) return pack
  try {
    parseStylePack(pack)
  } catch (err) {
    if (!(err instanceof CommandError)) throw err
    throw new CommandError(
      'conflict',
      err.message.replace(
        'the style pack is not valid',
        "the folder's stored style pack is not valid (fix it in Folder Settings → Style pack, or style.pack.edit)",
      ),
    )
  }
  accepted.add(pack)
  return pack
}
