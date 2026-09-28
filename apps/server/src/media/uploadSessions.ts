/**
 * media/uploadSessions.ts
 *
 * One-time credentials for ONE media upload into ONE deck through the tus
 * server (`media.uploadSession`, agentic A2.7a). An agent with a shell
 * (Claude Code) cannot hand a local file to MCP except as base64 it writes
 * out itself — impractical beyond a few kilobytes. It asks for a session
 * instead and sends the file with curl to the tus upload the editor uses,
 * so the bytes get the editor's checks (media/finalizeUpload.ts) and the
 * asset id comes back in the response.
 *
 * A session token (`nus_` + 43 base64url chars, 256 bits):
 *   - is shown once, in the command's result; only its SHA-256 is stored;
 *   - must start its upload within `UPLOAD_SESSION_TTL_MS` of being issued,
 *     and may continue it for `UPLOAD_SESSION_CONTINUE_MS` more;
 *   - authenticates tus requests only (media/tus.ts) — never any other
 *     route: `readBearerPat` does not recognise the prefix, so elsewhere it
 *     is no credential at all;
 *   - uploads media (image, video, font) into its deck only, as the user who
 *     asked for it, who must still be an editor of the deck;
 *   - is bound to the first upload it creates (`claim`), and may then only
 *     continue (PATCH) and finish that upload.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, eq, isNull, lt, gt } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { Database } from '../db/client.js'
import { uploadSessions } from '../db/schema.js'

export const UPLOAD_SESSION_PREFIX = 'nus_'
/** How long a session may be used to START its upload. */
export const UPLOAD_SESSION_TTL_MS = 15 * 60 * 1000
/**
 * How long after that a session bound to an upload may still continue and
 * finish it: a large video over a slow line outlasts the start window.
 */
export const UPLOAD_SESSION_CONTINUE_MS = 2 * 60 * 60 * 1000
/** Expired sessions are deleted this long after expiry (past any continuation), when new ones are issued. */
const SWEEP_AFTER_MS = 24 * 60 * 60 * 1000

const SECRET_BYTES = 32
const RAW_TOKEN_RE = /^nus_[A-Za-z0-9_-]{43}$/

export interface UploadSessionRecord {
  id: string
  tokenHash: string
  userSub: string
  deckId: string
  expiresAt: Date
  uploadId: string | null
}

export interface UploadSessionStore {
  insert(record: UploadSessionRecord): Promise<void>
  findByHash(tokenHash: string): Promise<UploadSessionRecord | null>
  /**
   * Bind the session to `uploadId` if it is still unbound and unexpired at
   * `now`; true when this call bound it. Atomic: two concurrent creations
   * with one token cannot both win.
   */
  claim(id: string, uploadId: string, now: Date): Promise<boolean>
  /** Delete sessions that expired before `before`. */
  sweep(before: Date): Promise<void>
}

export function hashUploadSessionToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}

/** Whether a bearer value claims to be an upload session token (well-formed or not). */
export function looksLikeUploadSessionToken(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.startsWith(UPLOAD_SESSION_PREFIX)
}

/** The upload session token in an `Authorization` header, or null. */
export function readBearerUploadSession(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header
  if (!value) return null
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(value)
  const credential = match?.[1]
  return looksLikeUploadSessionToken(credential) ? credential : null
}

function hashesEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex')
  const bb = Buffer.from(b, 'hex')
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

export function createDrizzleUploadSessionStore(db: Database): UploadSessionStore {
  return {
    async insert(record) {
      await db.insert(uploadSessions).values(record)
    },
    async findByHash(tokenHash) {
      const [row] = await db
        .select()
        .from(uploadSessions)
        .where(eq(uploadSessions.tokenHash, tokenHash))
        .limit(1)
      return row === undefined
        ? null
        : {
            id: row.id,
            tokenHash: row.tokenHash,
            userSub: row.userSub,
            deckId: row.deckId,
            expiresAt: row.expiresAt,
            uploadId: row.uploadId,
          }
    },
    async claim(id, uploadId, now) {
      const claimed = await db
        .update(uploadSessions)
        .set({ uploadId })
        .where(
          and(
            eq(uploadSessions.id, id),
            isNull(uploadSessions.uploadId),
            gt(uploadSessions.expiresAt, now),
          ),
        )
        .returning({ id: uploadSessions.id })
      return claimed.length === 1
    },
    async sweep(before) {
      await db.delete(uploadSessions).where(lt(uploadSessions.expiresAt, before))
    },
  }
}

export interface IssuedUploadSession {
  /** The raw token: returned once, never stored. */
  token: string
  expiresAt: Date
}

export interface VerifiedUploadSession {
  id: string
  userSub: string
  deckId: string
  /** The upload the session is bound to, or null before it created one. */
  uploadId: string | null
}

export interface UploadSessionService {
  issue(args: { userSub: string; deckId: string }): Promise<IssuedUploadSession>
  /** The session behind a raw token, or null (unknown, malformed or expired). */
  verify(raw: string): Promise<VerifiedUploadSession | null>
  /** Bind an unbound, unexpired session to the upload it just created. */
  claim(session: VerifiedUploadSession, uploadId: string): Promise<boolean>
}

export function createUploadSessionService(
  store: UploadSessionStore,
  opts: { now?: () => Date } = {},
): UploadSessionService {
  const now = opts.now ?? (() => new Date())
  return {
    async issue({ userSub, deckId }) {
      const issuedAt = now()
      // Keep the table small: whatever expired a day ago is gone.
      await store.sweep(new Date(issuedAt.getTime() - SWEEP_AFTER_MS))
      const token = `${UPLOAD_SESSION_PREFIX}${randomBytes(SECRET_BYTES).toString('base64url')}`
      const expiresAt = new Date(issuedAt.getTime() + UPLOAD_SESSION_TTL_MS)
      await store.insert({
        id: nanoid(),
        tokenHash: hashUploadSessionToken(token),
        userSub,
        deckId,
        expiresAt,
        uploadId: null,
      })
      return { token, expiresAt }
    },
    async verify(raw) {
      if (!RAW_TOKEN_RE.test(raw)) return null
      const hash = hashUploadSessionToken(raw)
      const record = await store.findByHash(hash)
      if (record === null || !hashesEqual(record.tokenHash, hash)) return null
      const deadline =
        record.uploadId === null
          ? record.expiresAt.getTime()
          : record.expiresAt.getTime() + UPLOAD_SESSION_CONTINUE_MS
      if (deadline <= now().getTime()) return null
      return {
        id: record.id,
        userSub: record.userSub,
        deckId: record.deckId,
        uploadId: record.uploadId,
      }
    },
    async claim(session, uploadId) {
      return store.claim(session.id, uploadId, now())
    },
  }
}
