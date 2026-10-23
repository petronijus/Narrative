/**
 * commands/src/commands/listPaging.ts — paging for the account-wide lists
 * (`deck.list`, `folder.list`). A user can hold hundreds of decks; the whole
 * list does not fit one tool result (579 decks came to 145 k characters,
 * over Claude Code's MCP output limit), so these commands return pages.
 *
 * Keyset paging, not offsets: a deck edited or created between two calls
 * neither repeats an item nor skips one that already existed on a later
 * page. The service reports the position of the last item it returned (a
 * `ListKeyset`, services/common.ts); this module wraps it into an opaque
 * cursor string and back.
 *
 * Cursor = base64url(JSON `{ v, list, key, id, filter }`):
 *   v       format version (1)
 *   list    which command issued it — a deck cursor is refused by folder.list
 *   key/id  the service's keyset
 *   filter  the filters of the call that issued it; a cursor sent with other
 *           filters is refused, because its position means nothing in a
 *           differently filtered list
 * It is not a secret and not signed: it names only a position in lists the
 * caller can already read, and the service re-validates `key` and scopes
 * every query to the caller.
 */

import { z } from 'zod'
import { CommandError } from '../errors.js'
import { MAX_LIST_PAGE_SIZE, type ListKeyset } from '../services/common.js'

export const DEFAULT_LIST_PAGE_SIZE = 50

const CURSOR_VERSION = 1
const MAX_CURSOR_CHARS = 2048

export const ListLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_LIST_PAGE_SIZE)
  .default(DEFAULT_LIST_PAGE_SIZE)
  .describe(`Page size, 1 to ${MAX_LIST_PAGE_SIZE} (default ${DEFAULT_LIST_PAGE_SIZE})`)

export const ListCursorSchema = z
  .string()
  .min(1)
  .max(MAX_CURSOR_CHARS)
  .describe("The previous page's `nextCursor` (with that call's filters)")

export const ListQuerySchema = z
  .string()
  .max(200)
  .transform((q) => q.trim())
  .refine((q) => q.length > 0, 'the query must not be blank')

export type ListName = 'deck' | 'folder'

/** The filters a cursor is bound to (absent filters as null, so the comparison is exact). */
export type ListFilter = Readonly<Record<string, string | null>>

// base64url over UTF-8, written out because this package also runs in the
// browser (no Buffer) and `btoa`/`atob` only take Latin-1 strings.
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    const chars = i + 2 < bytes.length ? 4 : i + 1 < bytes.length ? 3 : 2
    for (let c = 0; c < chars; c++) out += B64URL[(n >> (18 - 6 * c)) & 63]
  }
  return out
}

/** Null when `encoded` is not canonical base64url of valid UTF-8. */
function fromBase64Url(encoded: string): string | null {
  if (encoded.length % 4 === 1) return null
  const bytes: number[] = []
  for (let i = 0; i < encoded.length; i += 4) {
    const chunk = encoded.slice(i, i + 4)
    let n = 0
    for (let c = 0; c < 4; c++) {
      const v = c < chunk.length ? B64URL.indexOf(chunk[c]!) : 0
      if (v < 0) return null
      n = (n << 6) | v
    }
    bytes.push((n >> 16) & 255)
    if (chunk.length > 2) bytes.push((n >> 8) & 255)
    if (chunk.length > 3) bytes.push(n & 255)
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes))
  } catch {
    return null
  }
}

interface CursorPayload {
  v: number
  list: ListName
  key: string
  id: string
  filter: Record<string, string | null>
}

export function encodeListCursor(list: ListName, keyset: ListKeyset, filter: ListFilter): string {
  const payload: CursorPayload = {
    v: CURSOR_VERSION,
    list,
    key: keyset.key,
    id: keyset.id,
    filter: { ...filter },
  }
  return toBase64Url(JSON.stringify(payload))
}

function invalidCursor(message: string): CommandError {
  return new CommandError('invalid_input', `cursor: ${message}`, {
    issues: [{ path: ['cursor'], message }],
  })
}

function sameFilter(a: Record<string, unknown>, b: ListFilter): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) if ((a[k] ?? null) !== (b[k] ?? null)) return false
  return true
}

/** The keyset inside a cursor this list issued for these filters; `invalid_input` otherwise. */
export function decodeListCursor(list: ListName, cursor: string, filter: ListFilter): ListKeyset {
  let payload: unknown
  try {
    const json = fromBase64Url(cursor)
    if (json === null) throw new Error('not base64url')
    payload = JSON.parse(json)
  } catch {
    throw invalidCursor('not a cursor this list returned — pass `nextCursor` unchanged')
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload))
    throw invalidCursor('not a cursor this list returned — pass `nextCursor` unchanged')
  const p = payload as Partial<Record<keyof CursorPayload, unknown>>
  if (
    p.v !== CURSOR_VERSION ||
    typeof p.key !== 'string' ||
    typeof p.id !== 'string' ||
    p.key.length === 0 ||
    p.id.length === 0 ||
    typeof p.filter !== 'object' ||
    p.filter === null ||
    Array.isArray(p.filter)
  ) {
    throw invalidCursor('not a cursor this list returned — pass `nextCursor` unchanged')
  }
  if (p.list !== list)
    throw invalidCursor(`this cursor belongs to ${String(p.list)}.list, not ${list}.list`)
  if (!sameFilter(p.filter as Record<string, unknown>, filter))
    throw invalidCursor(
      'the filters differ from the call that returned this cursor — repeat them unchanged, or start over without a cursor',
    )
  return { key: p.key, id: p.id }
}
