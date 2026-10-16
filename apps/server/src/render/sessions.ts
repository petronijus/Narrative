/**
 * render/sessions.ts — render sessions: one render token per person and
 * document (a deck, or a component master for its card), reused by their render jobs so the render worker keeps the page it
 * opened with it (apps/render-worker/src/warmPages.ts) and the next look or
 * export skips loading the app.
 *
 * A session lasts `SESSION_IDLE_MS` after its last job and never longer than
 * `SESSION_MAX_MS` from its start. It ends — its token revoked, which closes
 * the page's connections — when its person loses access to the deck
 * (`endRenderSessions`, called wherever access is taken away), or when the
 * render page is refused. In this process's memory, like the tokens
 * (auth/renderTokens.ts); an entry goes when its token ends.
 */

import {
  extendRenderToken,
  mintRenderToken,
  revokeRenderToken,
  type RenderDoc,
  type RenderLane,
} from '../auth/renderTokens.js'

/** A session's token lives this long after its last job ends. */
export const SESSION_IDLE_MS = 120_000
/** No session (and no token of one) outlives this, however busy. */
export const SESSION_MAX_MS = 15 * 60_000

interface Session {
  token: string
  target: RenderDoc
  userId: string
  startedAt: number
}

const sessions = new Map<string, Session>()
/** A person's session and the server's background one as them are separate. */
const keyOf = (target: RenderDoc, userId: string, lane: RenderLane): string =>
  `${target.kind}:${target.id}\u0000${userId}\u0000${lane}`

/**
 * The session's token for a job that needs it for `jobMs`: the current one,
 * extended, or a new one (none yet, its token ended, or `jobMs` would carry
 * it past `SESSION_MAX_MS`).
 */
export function sessionTokenFor(
  args: { target: RenderDoc; userId: string; lane?: RenderLane },
  jobMs: number,
  now: number,
): string {
  const lane = args.lane ?? 'person'
  const key = keyOf(args.target, args.userId, lane)
  const current = sessions.get(key)
  if (
    current !== undefined &&
    now - current.startedAt + jobMs <= SESSION_MAX_MS &&
    extendRenderToken(current.token, jobMs, now)
  ) {
    return current.token
  }
  // An old token is left to expire, not revoked: a job of it may still run.
  const session: Session = { token: '', target: args.target, userId: args.userId, startedAt: now }
  session.token = mintRenderToken(
    args.target,
    args.userId,
    now,
    jobMs,
    () => {
      if (sessions.get(key) === session) sessions.delete(key)
    },
    lane,
  )
  sessions.set(key, session)
  return session.token
}

/**
 * After a job of `token`: its session goes on for `SESSION_IDLE_MS`, but not
 * past `SESSION_MAX_MS` (its token then runs out with the job's own time).
 */
export function sessionJobEnded(token: string, now: number): void {
  for (const session of sessions.values()) {
    if (session.token !== token) continue
    const left = session.startedAt + SESSION_MAX_MS - now
    if (left > 0) extendRenderToken(token, Math.min(SESSION_IDLE_MS, left), now)
    return
  }
}

/**
 * End the render sessions of `userId` — on the deck `deckId`, on every
 * component master (`components: true`: a folder's membership ended, and a
 * master's card session is as coarse as that), or on everything: their
 * tokens are revoked and the render pages' connections closed. Called
 * wherever the person's access is taken away — a page kept open from an
 * earlier job would otherwise go on reading until the session ran out.
 */
export function endRenderSessions(args: {
  userId: string
  deckId?: string
  components?: boolean
}): number {
  let ended = 0
  for (const session of [...sessions.values()]) {
    if (session.userId !== args.userId) continue
    const { target } = session
    if (args.deckId !== undefined && !(target.kind === 'deck' && target.id === args.deckId)) {
      continue
    }
    if (args.components === true && target.kind !== 'component') continue
    revokeRenderToken(session.token)
    ended += 1
  }
  return ended
}

/** End one session by its token (its page was refused). */
export function endRenderSession(token: string): void {
  revokeRenderToken(token)
}

/** Live sessions (tests and diagnostics). */
export function renderSessionCount(): number {
  return sessions.size
}

/** Test helper. */
export function clearRenderSessionsForTests(): void {
  for (const session of [...sessions.values()]) revokeRenderToken(session.token)
  sessions.clear()
}
