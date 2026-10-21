/**
 * documentEpoch.ts — the wire format of the document epoch (ADR 0017).
 *
 * The browser keeps a local copy of what the server confirmed (apps/web
 * state/localDocCopy.ts). A copy, or a Y.Doc that stayed open, from before
 * the server's state went BACK — a document replaced instead of edited, the
 * database restored from a backup — holds items the server no longer knows,
 * and its sync step 2 would add them back.
 *
 * So the server stamps what it hands out with an epoch of two parts:
 *
 *   - `generation` — the instance's restore generation (apps/server
 *     hocuspocus/instanceGeneration.ts): advanced after every backup, and
 *     past everything ever issued when a restore is detected at boot (the
 *     server then refuses every generation below its new floor);
 *   - `docEpoch` — the document's own epoch (`doc_epoch`), advanced by
 *     whatever replaces that one document's state.
 *
 * Each connection claims the epoch of the content its Y.Doc holds in the
 * auth frame's token; the server refuses a claim whose `docEpoch` is not the
 * document's or whose `generation` is below its floor, with
 * {@link STALE_DOCUMENT_REASON}, before it processes any of the connection's
 * messages. Right after a connection is established the server tells it the
 * current epoch ({@link DocumentEpochMessage}). To the browser an epoch is an
 * opaque string, compared for equality.
 *
 * The token stays a sentinel otherwise: the session travels in the
 * `narrative_session` cookie (ADR 0005) and a share link in the WebSocket
 * URL (apps/web state/hocuspocusAuth.ts).
 */

/** The `type` of the stateless message that tells a connection its document's epoch. */
export const DOCUMENT_EPOCH_MESSAGE_TYPE = 'narrative.documentEpoch'

/** The close reason of a connection whose claimed epoch is not the document's. */
export const STALE_DOCUMENT_REASON = 'stale-document'

/** The auth-frame token of a connection that claims nothing (an empty Y.Doc). */
export const CONNECT_TOKEN_SENTINEL = 'cookie'

/** `<generation>.<docEpoch>`, both positive integers (see the module comment). */
export type DocumentEpoch = string

export interface DocumentEpochParts {
  generation: number
  docEpoch: number
}

/** Sent by the server to each connection once it is established. */
export interface DocumentEpochMessage {
  type: typeof DOCUMENT_EPOCH_MESSAGE_TYPE
  /** The connection's document name (`<deckId>`, `folder:<id>`, `component:<id>`). */
  documentName: string
  epoch: DocumentEpoch
}

const PART = '[1-9][0-9]{0,14}'
const EPOCH_RE = new RegExp(`^(${PART})\\.(${PART})$`)
const TOKEN_RE = new RegExp(`^cookie(?:;epoch=(${PART}\\.${PART}))?$`)

const isPart = (n: number): boolean => Number.isSafeInteger(n) && n >= 1

/** The two parts of an epoch, or null when `value` is not one. */
export function parseDocumentEpoch(value: unknown): DocumentEpochParts | null {
  if (typeof value !== 'string') return null
  const match = EPOCH_RE.exec(value)
  if (match === null) return null
  const generation = Number(match[1])
  const docEpoch = Number(match[2])
  return isPart(generation) && isPart(docEpoch) ? { generation, docEpoch } : null
}

/** Whether `value` is an epoch the server could have issued. */
export function isDocumentEpoch(value: unknown): value is DocumentEpoch {
  return parseDocumentEpoch(value) !== null
}

/** The epoch of `parts`. */
export function formatDocumentEpoch(parts: DocumentEpochParts): DocumentEpoch {
  if (!isPart(parts.generation) || !isPart(parts.docEpoch)) {
    throw new Error(`not a document epoch: ${parts.generation}.${parts.docEpoch}`)
  }
  return `${parts.generation}.${parts.docEpoch}`
}

/**
 * Parse a stateless payload into a {@link DocumentEpochMessage}, or null when
 * it is another message, not JSON or malformed. Never throws.
 */
export function parseDocumentEpochMessage(payload: unknown): DocumentEpochMessage | null {
  if (typeof payload !== 'string') return null
  let raw: unknown
  try {
    raw = JSON.parse(payload)
  } catch {
    return null
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const m = raw as Record<string, unknown>
  if (m['type'] !== DOCUMENT_EPOCH_MESSAGE_TYPE) return null
  const { documentName, epoch } = m
  if (typeof documentName !== 'string' || documentName === '' || documentName.length > 256)
    return null
  if (!isDocumentEpoch(epoch)) return null
  return { type: DOCUMENT_EPOCH_MESSAGE_TYPE, documentName, epoch }
}

/** The auth-frame token claiming `epoch` for the Y.Doc's content (null: an empty document). */
export function connectToken(epoch: DocumentEpoch | null): string {
  if (epoch === null) return CONNECT_TOKEN_SENTINEL
  if (!isDocumentEpoch(epoch)) throw new Error(`not a document epoch: ${String(epoch)}`)
  return `${CONNECT_TOKEN_SENTINEL};epoch=${epoch}`
}

/**
 * What a connection's token claims: the epoch of its content, null when it
 * claims none — the sentinel, or a token in another format (an older page,
 * a direct client), which keeps connecting as it always did.
 */
export function claimedDocumentEpoch(token: string): DocumentEpochParts | null {
  const match = TOKEN_RE.exec(token)
  if (match === null || match[1] === undefined) return null
  return parseDocumentEpoch(match[1])
}
