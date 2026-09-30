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
 *     asked for it, who must still be an editor of the deck and still pass
 *     the sign-in policy (checked on every use, like a personal access
 *     token);
 *   - uploads exactly one file of the size and kind (image / video / font)
 *     declared when it was issued;
 *   - is bound to the first upload it creates (`claim`), and may then only
 *     continue (PATCH) and finish that upload;
 *   - dies with the credential that asked for it (revoking a personal access
 *     token or an MCP OAuth connection deletes its sessions) and with every
 *     other agent credential of the user (the account kill switch,
 *     auth/agentCredentials.ts).
 * At most `MAX_OPEN_UPLOAD_SESSIONS` unused, unexpired sessions per user.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, count, eq, gt, isNull, lt } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { Database } from '../db/client.js'
import { uploadSessions, users } from '../db/schema.js'
import type { PatOwner } from '../auth/personalAccessTokens.js'
import type { UploadKind } from './uploadPolicy.js'
import type { MediaOwner } from './mediaOwner.js'

export const UPLOAD_SESSION_PREFIX = 'nus_'
/** How long a session may be used to START its upload. */
export const UPLOAD_SESSION_TTL_MS = 15 * 60 * 1000
/**
 * How long after that a session bound to an upload may still continue and
 * finish it: a large video over a slow line outlasts the start window.
 */
export const UPLOAD_SESSION_CONTINUE_MS = 2 * 60 * 60 * 1000
/** Unused, unexpired sessions one user may hold at once. */
export const MAX_OPEN_UPLOAD_SESSIONS = 10
/** Expired sessions are deleted this long after expiry (past any continuation), when new ones are issued. */
const SWEEP_AFTER_MS = 24 * 60 * 60 * 1000

const SECRET_BYTES = 32
const RAW_TOKEN_RE = /^nus_[A-Za-z0-9_-]{43}$/

export interface UploadSessionRecord {
  id: string
  tokenHash: string
  userSub: string
  /** The deck it uploads into, or null for a component master's session. */
  deckId: string | null
  /** The component master it uploads into (migration 0029), or null for a deck's. */
  componentId: string | null
  expiresAt: Date
  uploadId: string | null
  /** The credential that asked for it (auth/agentSessions.ts keys); null for a browser session. */
  credentialKey: string | null
  /** The exact size of the file it may upload. */
  sizeBytes: number
  /** The only kind of file it may upload. */
  kind: UploadKind
}

/** A stored session with what the sign-in policy needs about its user. */
export interface UploadSessionWithOwner extends UploadSessionRecord {
  ownerEmail: string | null
  ownerEmailVerified: boolean
}

export interface UploadSessionStore {
  insert(record: UploadSessionRecord): Promise<void>
  findByHash(tokenHash: string): Promise<UploadSessionWithOwner | null>
  /** Unused sessions of the user that have not expired at `now`. */
  countOpen(userSub: string, now: Date): Promise<number>
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

function isUploadKind(v: unknown): v is UploadKind {
  return v === 'image' || v === 'video' || v === 'font'
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
        .select({
          id: uploadSessions.id,
          tokenHash: uploadSessions.tokenHash,
          userSub: uploadSessions.userSub,
          deckId: uploadSessions.deckId,
          componentId: uploadSessions.componentId,
          expiresAt: uploadSessions.expiresAt,
          uploadId: uploadSessions.uploadId,
          credentialKey: uploadSessions.credentialKey,
          sizeBytes: uploadSessions.sizeBytes,
          kind: uploadSessions.kind,
          ownerEmail: users.email,
          ownerEmailVerified: users.emailVerified,
        })
        .from(uploadSessions)
        .leftJoin(users, eq(users.sub, uploadSessions.userSub))
        .where(eq(uploadSessions.tokenHash, tokenHash))
        .limit(1)
      // A row without its size and kind (none are written that way) is not usable.
      if (row === undefined || row.sizeBytes === null || !isUploadKind(row.kind)) return null
      return {
        ...row,
        sizeBytes: row.sizeBytes,
        kind: row.kind,
        ownerEmailVerified: row.ownerEmailVerified === true,
      }
    },
    async countOpen(userSub, now) {
      const [row] = await db
        .select({ n: count() })
        .from(uploadSessions)
        .where(
          and(
            eq(uploadSessions.userSub, userSub),
            isNull(uploadSessions.uploadId),
            gt(uploadSessions.expiresAt, now),
          ),
        )
      return row?.n ?? 0
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

/** Delete the upload sessions a revoked credential opened; resolves to how many. */
export async function revokeUploadSessionsForCredential(
  db: Database,
  credentialKey: string,
): Promise<number> {
  const gone = await db
    .delete(uploadSessions)
    .where(eq(uploadSessions.credentialKey, credentialKey))
    .returning({ id: uploadSessions.id })
  return gone.length
}

/** Delete every upload session of a user (the account kill switch); resolves to how many. */
export async function revokeAllUploadSessionsForUser(
  db: Database,
  userSub: string,
): Promise<number> {
  const gone = await db
    .delete(uploadSessions)
    .where(eq(uploadSessions.userSub, userSub))
    .returning({ id: uploadSessions.id })
  return gone.length
}

export interface IssuedUploadSession {
  /** The raw token: returned once, never stored. */
  token: string
  expiresAt: Date
}

export interface VerifiedUploadSession {
  id: string
  userSub: string
  /** Where the one upload goes: a deck, or a component master. */
  owner: MediaOwner
  /** The upload the session is bound to, or null before it created one. */
  uploadId: string | null
  sizeBytes: number
  kind: UploadKind
}

export class UploadSessionLimitError extends Error {
  constructor() {
    super(
      `At most ${MAX_OPEN_UPLOAD_SESSIONS} unused upload sessions at once; use or let the open ones expire (15 minutes)`,
    )
    this.name = 'UploadSessionLimitError'
  }
}

export interface UploadSessionService {
  /** Throws `UploadSessionLimitError` past `MAX_OPEN_UPLOAD_SESSIONS`. */
  issue(args: {
    userSub: string
    owner: MediaOwner
    sizeBytes: number
    kind: UploadKind
    credentialKey?: string | undefined
  }): Promise<IssuedUploadSession>
  /** The session behind a raw token, or null (unknown, malformed, expired, owner not allowed). */
  verify(raw: string): Promise<VerifiedUploadSession | null>
  /** Bind an unbound, unexpired session to the upload it just created. */
  claim(session: VerifiedUploadSession, uploadId: string): Promise<boolean>
}

export interface UploadSessionServiceOptions {
  /**
   * The sign-in policy, re-applied to the session's user on every use — the
   * same check personal access tokens get (auth/signInPolicy.ts).
   */
  isOwnerAllowed: (owner: PatOwner) => Promise<boolean>
  now?: () => Date
}

export function createUploadSessionService(
  store: UploadSessionStore,
  opts: UploadSessionServiceOptions,
): UploadSessionService {
  const now = opts.now ?? (() => new Date())
  return {
    async issue({ userSub, owner, sizeBytes, kind, credentialKey }) {
      const issuedAt = now()
      // Keep the table small: whatever expired a day ago is gone.
      await store.sweep(new Date(issuedAt.getTime() - SWEEP_AFTER_MS))
      if ((await store.countOpen(userSub, issuedAt)) >= MAX_OPEN_UPLOAD_SESSIONS) {
        throw new UploadSessionLimitError()
      }
      const token = `${UPLOAD_SESSION_PREFIX}${randomBytes(SECRET_BYTES).toString('base64url')}`
      const expiresAt = new Date(issuedAt.getTime() + UPLOAD_SESSION_TTL_MS)
      await store.insert({
        id: nanoid(),
        tokenHash: hashUploadSessionToken(token),
        userSub,
        deckId: 'deckId' in owner ? owner.deckId : null,
        componentId: 'componentId' in owner ? owner.componentId : null,
        expiresAt,
        uploadId: null,
        credentialKey: credentialKey ?? null,
        sizeBytes,
        kind,
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
      const allowed = await opts.isOwnerAllowed({
        userSub: record.userSub,
        email: record.ownerEmail,
        emailVerified: record.ownerEmailVerified,
      })
      if (!allowed) return null
      const owner: MediaOwner | null =
        record.componentId !== null
          ? { componentId: record.componentId }
          : record.deckId !== null
            ? { deckId: record.deckId }
            : null
      if (owner === null) return null
      return {
        id: record.id,
        userSub: record.userSub,
        owner,
        uploadId: record.uploadId,
        sizeBytes: record.sizeBytes,
        kind: record.kind,
      }
    },
    async claim(session, uploadId) {
      return store.claim(session.id, uploadId, now())
    },
  }
}
