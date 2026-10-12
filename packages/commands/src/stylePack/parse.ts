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
