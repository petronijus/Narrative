/**
 * render/sessions.test.ts — render sessions: one token per person and deck,
 * reused while it lasts, never past SESSION_MAX_MS, ended when access goes,
 * and forgotten when its token ends.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../hocuspocus/connections.js', () => ({ closeShareTokenConnections: vi.fn(() => 0) }))

import { closeShareTokenConnections } from '../hocuspocus/connections.js'
import { resolveRenderToken } from '../auth/renderTokens.js'
import {
  clearRenderSessionsForTests,
  endRenderSessions,
  renderSessionCount,
  SESSION_IDLE_MS,
  SESSION_MAX_MS,
  sessionJobEnded,
  sessionTokenFor,
} from './sessions.js'

const JOB = 155_000

afterEach(() => {
  clearRenderSessionsForTests()
  vi.useRealTimers()
})

describe('render sessions', () => {
  it('reuses one token per person and deck', () => {
    const now = Date.now()
    const a = sessionTokenFor({ deckId: 'd1', userId: 'u1' }, JOB, now)
    expect(sessionTokenFor({ deckId: 'd1', userId: 'u1' }, JOB, now + 1_000)).toBe(a)
    expect(sessionTokenFor({ deckId: 'd1', userId: 'u2' }, JOB, now)).not.toBe(a)
    expect(sessionTokenFor({ deckId: 'd2', userId: 'u1' }, JOB, now)).not.toBe(a)
    // The server's background work as u1 has a session of its own.
    const bg = sessionTokenFor({ deckId: 'd1', userId: 'u1', lane: 'background' }, JOB, now)
    expect(bg).not.toBe(a)
    expect(sessionTokenFor({ deckId: 'd1', userId: 'u1', lane: 'background' }, JOB, now)).toBe(bg)
    expect(resolveRenderToken(bg)).toMatchObject({ requestedBy: 'u1', lane: 'background' })
    expect(resolveRenderToken(a)?.lane).toBe('person')
    expect(renderSessionCount()).toBe(4)
  })

  it('starts a new token rather than carry one past SESSION_MAX_MS', () => {
    const start = Date.now()
    const args = { deckId: 'd1', userId: 'u1' }
    const a = sessionTokenFor(args, JOB, start)
    // A job every 100 s keeps the session going…
    let t = start
    for (; t + 100_000 + JOB <= start + SESSION_MAX_MS; ) {
      sessionJobEnded(a, t)
      t += 100_000
      expect(sessionTokenFor(args, JOB, t)).toBe(a)
    }
    // …until the next job would carry it past the maximum.
    sessionJobEnded(a, t)
    expect(sessionTokenFor(args, JOB, t + 100_000)).not.toBe(a)
  })

  it('goes on SESSION_IDLE_MS after a job, but never past SESSION_MAX_MS', () => {
    vi.useFakeTimers()
    const a = sessionTokenFor({ deckId: 'd1', userId: 'u1' }, JOB, Date.now())
    vi.advanceTimersByTime(10_000)
    sessionJobEnded(a, Date.now())
    vi.advanceTimersByTime(SESSION_IDLE_MS - 1)
    expect(resolveRenderToken(a)).not.toBeNull()
    vi.advanceTimersByTime(1)
    expect(resolveRenderToken(a)).toBeNull()
    // Its entry went with its token.
    expect(renderSessionCount()).toBe(0)

    const late = Date.now()
    const b = sessionTokenFor({ deckId: 'd1', userId: 'u1' }, JOB, late)
    // A job ending 30 s before the session's maximum extends it only that far.
    vi.setSystemTime(late + SESSION_MAX_MS - 30_000)
    sessionJobEnded(b, late + SESSION_MAX_MS - 30_000)
    vi.advanceTimersByTime(30_000)
    expect(resolveRenderToken(b)).toBeNull()
  })

  it('ends a person’s sessions on a deck, or on all decks, closing their pages', () => {
    const now = Date.now()
    const d1 = sessionTokenFor({ deckId: 'd1', userId: 'u1' }, JOB, now)
    const d2 = sessionTokenFor({ deckId: 'd2', userId: 'u1' }, JOB, now)
    const other = sessionTokenFor({ deckId: 'd1', userId: 'u2' }, JOB, now)
    expect(endRenderSessions({ userId: 'u1', deckId: 'd1' })).toBe(1)
    expect(resolveRenderToken(d1)).toBeNull()
    expect(closeShareTokenConnections).toHaveBeenCalledWith(d1)
    expect(resolveRenderToken(d2)).not.toBeNull()
    expect(endRenderSessions({ userId: 'u1' })).toBe(1)
    expect(resolveRenderToken(d2)).toBeNull()
    expect(resolveRenderToken(other)).not.toBeNull()
    // A new job after that starts a new session.
    expect(sessionTokenFor({ deckId: 'd1', userId: 'u1' }, JOB, now)).not.toBe(d1)
  })
})
