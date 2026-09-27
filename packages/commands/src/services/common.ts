/**
 * Types shared by several server service interfaces (see ../services.ts).
 */

import type { Role } from '../types.js'

/**
 * Where a server command gets a file from.
 *
 * - `url`: an http(s) URL the server downloads itself. The download is
 *   guarded against SSRF (public addresses only, re-checked on every
 *   redirect, pinned to the vetted address) and capped at the same size the
 *   upload path allows for that kind of file.
 * - `base64`: the bytes inline (a bare base64 string or a `data:` URL).
 * - `bytes`: raw bytes, for the HTTP routes that already received a body.
 *   Never exposed to agents (their input schemas only offer `url` and
 *   `base64`).
 *
 * `filename` and `mimeType` are hints: the server sniffs the bytes and
 * validates them exactly as it validates a browser upload.
 */
export type BinarySource =
  | { kind: 'url'; url: string; filename?: string | undefined; mimeType?: string | undefined }
  | { kind: 'base64'; data: string; filename?: string | undefined; mimeType?: string | undefined }
  | {
      kind: 'bytes'
      bytes: Uint8Array
      filename?: string | undefined
      mimeType?: string | undefined
    }

/** A deck role, as the server stores it. */
export type DeckRole = Role

/**
 * A position in a keyset-paged list: the sort key and the id of the last
 * item a page returned. The next page starts strictly after it. `key` is
 * the service's own encoding of the sort value (for example a timestamp
 * with microseconds, which a JavaScript Date cannot hold); commands wrap
 * the keyset into an opaque cursor and never interpret it. A service
 * rejects a `key` it did not produce with `invalid_input`.
 */
export interface ListKeyset {
  key: string
  id: string
}

/** Largest page a paged list service returns (the commands' `limit` maximum). */
export const MAX_LIST_PAGE_SIZE = 200

/** One font face a deck or folder serves to its editors. */
export interface FontFaceInfo {
  assetId: string
  family: string | null
  weight: number | null
  style: string | null
  postscriptName: string | null
  /** Short-lived presigned URL of the font file. */
  url: string
  sizeBytes: number
  /** ISO timestamp. */
  uploadedAt: string
}
