/**
 * agent/opRedaction.ts
 *
 * What an agent op's input and result look like by the time they reach
 * `agent_ops` (services/runs.ts `recordOp`). The audit trail must say what
 * an agent did without becoming a second copy of every file it uploaded or a
 * store of live credentials:
 *
 *   - Inline file bytes are replaced by `{ redacted, bytes, sha256 }` — the
 *     size and digest of the DECODED bytes, enough to tell which file it was
 *     (compare with the stored asset) without keeping the file:
 *       - every `data:` URL, whatever key it sits under;
 *       - every string under a key named `base64` — the one field today's
 *         command schemas use for inline files (`{ base64 }` file sources in
 *         commands/serverShared.ts, the inline `deck.exportPptx` result);
 *       - as a safety net for fields added later, any other string of at
 *         least `BASE64_HEURISTIC_MIN_CHARS` characters that is strictly
 *         base64 / base64url (no spaces, correct padding). Ids, colours,
 *         names and prose never look like that at that length.
 *   - Whole-string http(s) URLs lose their query string, fragment and any
 *     `user:password@`: presigned links (`X-Amz-Signature=…`, the export
 *     download URL an op returns) and tokens in query parameters are live
 *     credentials, the path is what an auditor needs.
 *   - Every Narrative credential anywhere in a string (shared/src/credentialPatterns.ts:
 *     personal access tokens, MCP OAuth tokens / codes / secrets, upload
 *     sessions — e.g. the `nus_…` `media.uploadSession` returns, also inside
 *     its ready curl command) keeps its prefix and loses the secret.
 *
 * Structure is kept: objects stay objects with the same keys, arrays keep
 * their length, so `ops.apply` batches still read op by op. The function is
 * pure and never throws on JSON-shaped input.
 *
 * Trade-off, written down: an op that carried inline bytes, or a signed URL,
 * is no longer replayable from the log alone (ADR 0011 point 4). Replay of
 * such an op needs the stored asset it produced; everything else still
 * replays deterministically.
 */

import { createHash } from 'node:crypto'
import { maskCredentials } from '@narrative/shared'

/** Strings at least this long that are strictly base64 are treated as file bytes. */
export const BASE64_HEURISTIC_MIN_CHARS = 1024

/** Nesting deeper than this is cut (JSON inputs are shallow; this bounds a pathological one). */
const MAX_DEPTH = 64

export interface RedactedBytes {
  redacted: 'base64' | 'data-url'
  /** Size of the decoded bytes. */
  bytes: number
  /** SHA-256 (hex) of the decoded bytes. */
  sha256: string
  /** The media type a `data:` URL declared, when it declared one. */
  mediaType?: string
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/
const BASE64URL_RE = /^[A-Za-z0-9_-]+={0,2}$/
const DATA_URL_RE = /^data:([^,]*),/i
const HTTP_URL_RE = /^https?:\/\//i

function digest(bytes: Buffer): { bytes: number; sha256: string } {
  return { bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') }
}

function looksLikeBase64(value: string): boolean {
  if (value.length < BASE64_HEURISTIC_MIN_CHARS) return false
  if (BASE64_RE.test(value)) return value.length % 4 === 0
  // base64url is often sent unpadded.
  return BASE64URL_RE.test(value) && value.length % 4 !== 1
}

function redactDataUrl(value: string): RedactedBytes {
  const match = DATA_URL_RE.exec(value)
  const meta = match?.[1] ?? ''
  const payload = value.slice(match?.[0].length ?? value.length)
  const params = meta.split(';')
  const isBase64 = params.slice(1).some((p) => p.trim().toLowerCase() === 'base64')
  let bytes: Buffer
  if (isBase64) {
    bytes = Buffer.from(payload, 'base64')
  } else {
    try {
      bytes = Buffer.from(decodeURIComponent(payload), 'utf8')
    } catch {
      bytes = Buffer.from(payload, 'utf8')
    }
  }
  const mediaType = params[0]?.trim()
  return {
    redacted: 'data-url',
    ...digest(bytes),
    ...(mediaType ? { mediaType: mediaType.slice(0, 100) } : {}),
  }
}

function redactBase64(value: string): RedactedBytes {
  return { redacted: 'base64', ...digest(Buffer.from(value, 'base64')) }
}

/** An http(s) URL without query string, fragment or credentials. Non-URLs come back unchanged. */
export function stripUrlSecrets(value: string): string {
  if (!HTTP_URL_RE.test(value)) return value
  let url: URL
  try {
    url = new URL(value)
  } catch {
    // Not parseable: drop everything from the first `?` or `#` anyway.
    return value.replace(/[?#].*$/s, '')
  }
  if (url.search === '' && url.hash === '' && url.username === '' && url.password === '') {
    return value
  }
  url.search = ''
  url.hash = ''
  url.username = ''
  url.password = ''
  return url.toString()
}

/** A string with every Narrative credential's secret replaced (shared/src/credentialPatterns.ts). */
export function redactTokens(value: string): string {
  return maskCredentials(value, '[redacted]')
}

function redactString(value: string, key: string | null): unknown {
  if (DATA_URL_RE.test(value)) return redactDataUrl(value)
  if (key === 'base64') return redactBase64(value)
  if (looksLikeBase64(value)) return redactBase64(value)
  return stripUrlSecrets(redactTokens(value))
}

function redactValue(value: unknown, key: string | null, depth: number): unknown {
  if (typeof value === 'string') return redactString(value, key)
  if (value === null || typeof value !== 'object') return value
  if (depth >= MAX_DEPTH) return { truncated: 'depth' }
  if (Array.isArray(value)) return value.map((v) => redactValue(v, null, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = redactValue(v, k, depth + 1)
  }
  return out
}

/**
 * The value as `agent_ops` stores it: inline bytes replaced by their size and
 * digest, URLs stripped of secrets, structure unchanged. `undefined` stays
 * `undefined`.
 */
export function redactForAudit(value: unknown): unknown {
  if (value === undefined) return undefined
  return redactValue(value, null, 0)
}
