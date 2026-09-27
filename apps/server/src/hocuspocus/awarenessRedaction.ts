/**
 * hocuspocus/awarenessRedaction.ts
 *
 * Defence in depth for awareness privacy (security review of A1,
 * 2026-09-27): what a read-only connection — a share-link viewer, or a
 * signed-in viewer — receives of other peers' awareness states never carries
 * an account identifier.
 *
 * Current editors already publish only a random per-tab peer id as
 * `user.id` and never an email as a name (web SlideDocProvider). But
 * awareness is client-asserted: an older editor tab, a modified client or a
 * bug could still publish a Google `sub` or an email, and Hocuspocus
 * forwards every state verbatim to every connection of the document —
 * including anonymous share-link viewers, who have no business learning who
 * the collaborators are. So, for those connections, every awareness message
 * is rewritten on its way out:
 *   - `user.id` becomes `peer:<clientId>` (clients' `toPeerInfo` requires a
 *     string id; the Yjs client id is already public on the wire);
 *   - a `user.name` that looks like an email becomes a neutral label;
 *   - any other string that looks like an email is removed, wherever it sits
 *     in the state (array elements included).
 * Collaborators with edit rights keep receiving the states unchanged (they
 * can list the deck's collaborators anyway), and the server's own view of
 * awareness (editor.context, awarenessOwnership.ts) is not affected: only
 * the bytes sent to a redacted connection change.
 *
 * Mechanism (Hocuspocus 2.15): every byte a WebSocket connection receives
 * goes through `Connection#send(Uint8Array)` — the connection's initial
 * `sendCurrentAwareness()` (called in the Connection constructor right after
 * `document.addConnection(this)`, with `readOnly` and `context` already set),
 * the awareness broadcasts of `Document#handleAwarenessUpdate`, sync and
 * stateless messages. `awarenessRedactionExtension()` wraps
 * `document.addConnection` in `afterLoadDocument` (before any connection can
 * exist) so each read-only / share-link connection gets a `send` that
 * rewrites awareness messages and passes every other message through
 * byte-identical. A message that cannot be decoded is dropped rather than
 * forwarded unredacted (fail closed).
 *
 * Wire format of an outgoing Hocuspocus awareness message:
 *   varString documentName · varUint type (Awareness = 1) · varUint8Array update
 * and of the y-protocols awareness update inside it:
 *   varUint count · count × (varUint clientID · varUint clock · varString JSON state)
 */

import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import type { Document, Extension, afterLoadDocumentPayload } from '@hocuspocus/server'

/** Hocuspocus `MessageType.Awareness`. */
export const HOCUSPOCUS_AWARENESS_MESSAGE = 1

/** What a redacted `user.name` that looked like an email reads as. */
export const REDACTED_PEER_NAME = 'Collaborator'

/** Deeper structures than this are dropped: awareness states are shallow. */
const MAX_DEPTH = 8

const EMAIL_RE = /[^\s@<>()[\]{}"',;:]+@[^\s@<>()[\]{}"',;:]+\.[^\s@<>()[\]{}"',;:]+/u

/** Does `value` contain something that looks like an email address? */
export function looksLikeEmail(value: string): boolean {
  return EMAIL_RE.test(value)
}

/** Remove email-looking strings anywhere in a JSON value (undefined = drop it). */
function withoutEmails(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return looksLikeEmail(value) ? undefined : value
  if (value === null || typeof value !== 'object') return value
  if (depth >= MAX_DEPTH) return undefined
  if (Array.isArray(value)) {
    return value.map((v) => withoutEmails(v, depth + 1)).filter((v) => v !== undefined)
  }
  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const cleaned = withoutEmails(v, depth + 1)
    if (cleaned !== undefined) out[key] = cleaned
  }
  return out
}

/** One peer's awareness state as a redacted connection may see it. */
export function redactAwarenessState(clientId: number, state: unknown): unknown {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    return withoutEmails(state, 0) ?? null
  }
  const { user, ...rest } = state as Record<string, unknown>
  const out = withoutEmails(rest, 0) as Record<string, unknown>
  if (user !== null && typeof user === 'object' && !Array.isArray(user)) {
    const { id: _id, name, ...userRest } = user as Record<string, unknown>
    const redactedUser = withoutEmails(userRest, 1) as Record<string, unknown>
    redactedUser['id'] = `peer:${clientId}`
    if (typeof name === 'string') {
      redactedUser['name'] = looksLikeEmail(name) ? REDACTED_PEER_NAME : name
    }
    out['user'] = redactedUser
  }
  return out
}

/** Rewrite every state of a y-protocols awareness update. Throws on malformed input. */
export function redactAwarenessUpdate(update: Uint8Array): Uint8Array {
  const decoder = decoding.createDecoder(update)
  const encoder = encoding.createEncoder()
  const count = decoding.readVarUint(decoder)
  encoding.writeVarUint(encoder, count)
  for (let i = 0; i < count; i++) {
    const clientId = decoding.readVarUint(decoder)
    const clock = decoding.readVarUint(decoder)
    const state: unknown = JSON.parse(decoding.readVarString(decoder))
    encoding.writeVarUint(encoder, clientId)
    encoding.writeVarUint(encoder, clock)
    // `null` is a removal; it carries nothing to redact.
    encoding.writeVarString(
      encoder,
      JSON.stringify(state === null ? null : redactAwarenessState(clientId, state)),
    )
  }
  return encoding.toUint8Array(encoder)
}

/**
 * The bytes a redacted connection receives for an outgoing Hocuspocus
 * message: awareness messages rewritten, everything else untouched (the same
 * array). Throws when an awareness message cannot be decoded.
 */
export function redactOutgoingMessage(message: Uint8Array): Uint8Array {
  const decoder = decoding.createDecoder(message)
  let documentName: string
  let type: number
  try {
    documentName = decoding.readVarString(decoder)
    type = decoding.readVarUint(decoder)
  } catch {
    // Not a Hocuspocus message we understand: nothing awareness-shaped to leak.
    return message
  }
  if (type !== HOCUSPOCUS_AWARENESS_MESSAGE) return message
  const update = decoding.readVarUint8Array(decoder)
  const encoder = encoding.createEncoder()
  encoding.writeVarString(encoder, documentName)
  encoding.writeVarUint(encoder, type)
  encoding.writeVarUint8Array(encoder, redactAwarenessUpdate(update))
  return encoding.toUint8Array(encoder)
}

/** The parts of a Hocuspocus Connection this module reads and wraps. */
interface RedactableConnection {
  readOnly: boolean
  context: unknown
  send(message: Uint8Array): void
}

/** Read-only connections and share-link connections get redacted awareness. */
export function needsAwarenessRedaction(connection: {
  readOnly: boolean
  context: unknown
}): boolean {
  if (connection.readOnly) return true
  const shareToken = (connection.context as { shareToken?: unknown } | null | undefined)?.shareToken
  return typeof shareToken === 'string' && shareToken !== ''
}

type Log = { warn: (obj: object, msg: string) => void }

/** Wrap `connection.send` so awareness messages are redacted. Idempotent. */
export function redactConnectionAwareness(
  connection: RedactableConnection,
  log?: Log,
  documentName?: string,
): void {
  const marked = connection as RedactableConnection & { __awarenessRedacted?: true }
  if (marked.__awarenessRedacted) return
  marked.__awarenessRedacted = true
  const send = connection.send.bind(connection)
  connection.send = (message: Uint8Array): void => {
    let out: Uint8Array
    try {
      out = redactOutgoingMessage(message)
    } catch (err) {
      log?.warn(
        { err, doc: documentName },
        'dropped an awareness message that could not be redacted',
      )
      return
    }
    send(out)
  }
}

const wrapped = new WeakSet<Document>()

/**
 * Start redacting awareness for the read-only connections of `document`.
 * Idempotent. Called from `afterLoadDocument`; exported for tests.
 */
export function trackAwarenessRedaction(document: Document, log?: Log): void {
  if (wrapped.has(document)) return
  wrapped.add(document)
  const addConnection = document.addConnection.bind(document)
  document.addConnection = ((connection: Parameters<Document['addConnection']>[0]) => {
    const c = connection as unknown as RedactableConnection
    if (needsAwarenessRedaction(c)) redactConnectionAwareness(c, log, document.name)
    return addConnection(connection)
  }) as Document['addConnection']
}

/** The Hocuspocus extension that redacts awareness for read-only connections. */
export function awarenessRedactionExtension(opts: { log?: Log } = {}): Extension {
  return {
    async afterLoadDocument({ document }: afterLoadDocumentPayload): Promise<void> {
      trackAwarenessRedaction(document, opts.log)
    },
  }
}
