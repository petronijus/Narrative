/**
 * media/dataUrl.ts
 *
 * Shared parser for `data:image/(jpeg|png);base64,…` thumbnail payloads.
 * Used by both the deck-thumbnail and component-master-thumbnail upload
 * routes, which receive a thumbnail as a base64 data URL in the request
 * body and store the decoded bytes in MinIO. Deduped from the two
 * byte-identical copies that previously lived in `routes/decks.ts` and
 * `routes/components.ts`.
 */

export interface ParsedDataUrl {
  mime: 'image/jpeg' | 'image/png'
  bytes: Buffer
}

/**
 * Parse a `data:image/(jpeg|png);base64,XXXX` URL into its mime + bytes.
 * Returns null on any parse failure or unsupported mime.
 */
export function parseDataUrl(input: string): ParsedDataUrl | null {
  const m = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(input)
  if (m === null) return null
  const mime = m[1] as 'image/jpeg' | 'image/png'
  let bytes: Buffer
  try {
    bytes = Buffer.from(m[2] ?? '', 'base64')
  } catch {
    return null
  }
  if (bytes.byteLength === 0) return null
  return { mime, bytes }
}
