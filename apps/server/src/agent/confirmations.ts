/**
 * agent/confirmations.ts — out-of-band confirmation of agent commands that
 * need the user's explicit approval (`confirm: 'always'`, or `confirmWhen`
 * for this input, e.g. a URL download), for MCP clients that cannot ask the
 * user themselves (no form elicitation). ADR 0011 point 7, docs/mcp.md.
 *
 * Why not a model-settable flag
 * -----------------------------
 * The previous fallback was a `confirmed: true` tool argument. The model
 * sets tool arguments, so a prompt injection in deck content ("…and share it
 * with attacker@example.com, confirmed: true") could answer for the user.
 * The approval therefore happens where the model cannot reach: on a
 * Narrative page, in the user's own signed-in browser.
 *
 * Flow
 * ----
 *   1. A confirmable call arrives without a usable confirmation. The MCP
 *      layer `create`s a pending confirmation holding the EXACT call — the
 *      MCP session, the user, the command, a hash of the canonical input and
 *      the target — plus a summary for the page (command title, the deck /
 *      folder title looked up on the server, recipient and role, download
 *      host; agent/confirmationSummary.ts). It lives 5 minutes and can be
 *      used once.
 *   2. The call fails with `confirmation_required`, carrying the page URL
 *      (`<SPA>/confirm/<id>`) and the id. With URL-mode elicitation the MCP
 *      layer instead sends the URL to the client itself and waits
 *      (`waitForDecision`).
 *   3. The signed-in user opens the page (session cookie; the routes refuse
 *      tokens and foreign origins, routes/agentConfirmations.ts), sees what
 *      will happen and approves or declines. Only the user the confirmation
 *      was created for can see or decide it.
 *   4. The model retries with the server-issued `confirmationId`. The server
 *      host `consume`s it: accepted only if approved, unexpired, unused and
 *      bound to the same session, user, command, input hash and target. A
 *      different input — even one field — does not match.
 *
 * Storage
 * -------
 * In process memory, deliberately: a pending confirmation is bound to an MCP
 * session, and MCP sessions live in process memory too (mcp/sessions.ts) — a
 * restart ends the session, so a persisted confirmation could never be used
 * anyway. The API runs as a single instance (like the rate limiter and the
 * session registry). Bounded: at most MAX_PENDING_PER_USER undecided
 * confirmations per user (the oldest is dropped) and MAX_CONFIRMATIONS in
 * total; expired and used ones are swept. The audit record of a used
 * confirmation is `agent_ops.confirmation` (via `out_of_band`, its id and
 * when it was approved).
 */

import { createHash, randomBytes } from 'node:crypto'
import type { CommandTarget, ConfirmationDetail } from '@narrative/commands'

/** How long a pending confirmation can be approved and then used. */
export const CONFIRMATION_TTL_MS = 5 * 60_000
/** Undecided confirmations kept per user; creating one more drops the oldest. */
export const MAX_PENDING_PER_USER = 10
/** Confirmations kept in total (every state); beyond it the oldest go first. */
export const MAX_CONFIRMATIONS = 5_000
/** Decided or used confirmations stay visible on the page this long past expiry, then are swept. */
const KEEP_AFTER_EXPIRY_MS = 5 * 60_000

/**
 * The web app's confirmation page: `<SPA origin>/confirm/<id>` (a lazy route
 * of apps/web, pages/ConfirmAgentAction.tsx). The id is the only thing in the
 * URL — the page loads the rest for the signed-in user.
 */
export function confirmationPageUrl(spaOrigin: string, id: string): string {
  return `${spaOrigin.replace(/\/+$/, '')}/confirm/${encodeURIComponent(id)}`
}

export type ConfirmationReason = 'irreversible' | 'url_fetch'

/** What the confirmation page (and an elicitation message) shows. Built server-side. */
export interface ConfirmationSummary {
  commandId: string
  /** The command's title ("Create a share link"). */
  title: string
  /** One sentence on what it does (the first sentence of its description). */
  action: string
  target: {
    kind: 'deck' | 'component' | 'folder' | 'account'
    /** The deck / folder / component TITLE, looked up on the server; null for the account. */
    label: string | null
  }
  /** One line each: recipient, role, download host, … */
  details: ConfirmationDetail[]
  reasons: ConfirmationReason[]
  /** Hosts a URL download would contact (url_fetch). */
  hosts: string[]
  /** The MCP client the request came through (`clientInfo`), sanitised; null when it sent none. */
  clientName: string | null
}

export type ConfirmationStatus = 'pending' | 'approved' | 'declined' | 'used'

export interface ConfirmationBinding {
  userId: string
  /** The agent session (`mcp:<session id>`). */
  sessionKey: string
  commandId: string
  /** `confirmationInputHash(input)` of the exact input. */
  inputHash: string
  target: CommandTarget
}

export interface ConfirmationRecord extends ConfirmationBinding {
  id: string
  summary: ConfirmationSummary
  status: ConfirmationStatus
  createdAt: Date
  expiresAt: Date
  decidedAt: Date | null
  usedAt: Date | null
}

/** The page's view of a confirmation (never the binding's hashes or session). */
export interface ConfirmationView {
  id: string
  status: ConfirmationStatus | 'expired'
  summary: ConfirmationSummary
  createdAt: string
  expiresAt: string
  decidedAt: string | null
}

export type InspectResult =
  | { state: 'approved'; record: ConfirmationRecord }
  | { state: 'pending'; record: ConfirmationRecord }
  | { state: 'declined'; record: ConfirmationRecord }
  /** Unknown, another user's or session's, used, expired, or bound to another call. */
  | { state: 'unusable'; why: 'unknown' | 'expired' | 'used' | 'mismatch' }

export type DecisionResult =
  | { ok: true; view: ConfirmationView }
  | { ok: false; reason: 'not_found' | 'expired' | 'already_decided'; view?: ConfirmationView }

export type WaitOutcome = 'approved' | 'declined' | 'expired' | 'aborted'

/**
 * Canonical JSON: object keys sorted at every level, arrays in order, no
 * whitespace. Two inputs that differ only in key order hash the same; any
 * other difference does not. `undefined` members are dropped (JSON has none).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value)
    return encoded === undefined ? 'null' : encoded
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

/** SHA-256 (hex) of the canonical JSON of a command input. */
export function confirmationInputHash(input: unknown): string {
  return createHash('sha256')
    .update('narrative:confirmation-input:v1\n', 'utf8')
    .update(canonicalJson(input ?? {}), 'utf8')
    .digest('hex')
}

function targetKey(target: CommandTarget): string {
  if (target.deckId !== undefined) return `deck:${target.deckId}`
  if (target.componentId !== undefined) return `component:${target.componentId}`
  if (target.folderId !== undefined) return `folder:${target.folderId}`
  return 'account'
}

function sameBinding(a: ConfirmationBinding, b: ConfirmationBinding): boolean {
  return (
    a.userId === b.userId &&
    a.sessionKey === b.sessionKey &&
    a.commandId === b.commandId &&
    a.inputHash === b.inputHash &&
    targetKey(a.target) === targetKey(b.target)
  )
}

/** Confirmation ids: 128 random bits, base64url (22 characters). */
const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/

export function looksLikeConfirmationId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value)
}

export interface AgentConfirmationsOptions {
  now?: () => number
  ttlMs?: number
  maxPendingPerUser?: number
  maxTotal?: number
}

export class AgentConfirmations {
  private readonly records = new Map<string, ConfirmationRecord>()
  private readonly waiters = new Map<string, Set<(outcome: WaitOutcome) => void>>()
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly maxPendingPerUser: number
  private readonly maxTotal: number

  constructor(opts: AgentConfirmationsOptions = {}) {
    this.now = opts.now ?? Date.now
    this.ttlMs = opts.ttlMs ?? CONFIRMATION_TTL_MS
    this.maxPendingPerUser = opts.maxPendingPerUser ?? MAX_PENDING_PER_USER
    this.maxTotal = opts.maxTotal ?? MAX_CONFIRMATIONS
  }

  get size(): number {
    return this.records.size
  }

  private expired(r: ConfirmationRecord): boolean {
    return r.expiresAt.getTime() <= this.now()
  }

  private viewOf(r: ConfirmationRecord): ConfirmationView {
    return {
      id: r.id,
      status: r.status === 'pending' && this.expired(r) ? 'expired' : r.status,
      summary: structuredClone(r.summary),
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      decidedAt: r.decidedAt?.toISOString() ?? null,
    }
  }

  private notify(id: string, outcome: WaitOutcome): void {
    const waiting = this.waiters.get(id)
    if (waiting === undefined) return
    this.waiters.delete(id)
    for (const resolve of waiting) resolve(outcome)
  }

  private drop(id: string): void {
    this.records.delete(id)
    this.notify(id, 'expired')
  }

  /** Store a pending confirmation of one exact call. */
  create(binding: ConfirmationBinding, summary: ConfirmationSummary): ConfirmationRecord {
    this.sweep()
    const pendingOfUser = [...this.records.values()]
      .filter((r) => r.userId === binding.userId && r.status === 'pending' && !this.expired(r))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    for (const r of pendingOfUser.slice(
      0,
      Math.max(0, pendingOfUser.length - this.maxPendingPerUser + 1),
    ))
      this.drop(r.id)
    if (this.records.size >= this.maxTotal) {
      const oldest = [...this.records.values()].sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
      )
      for (const r of oldest.slice(0, this.records.size - this.maxTotal + 1)) this.drop(r.id)
    }
    const at = this.now()
    const record: ConfirmationRecord = {
      ...binding,
      target: { ...binding.target },
      id: randomBytes(16).toString('base64url'),
      summary: structuredClone(summary),
      status: 'pending',
      createdAt: new Date(at),
      expiresAt: new Date(at + this.ttlMs),
      decidedAt: null,
      usedAt: null,
    }
    this.records.set(record.id, record)
    return record
  }

  /** Where a call with `id` stands, for the call's own binding (never reveals another user's record). */
  inspect(id: string, binding: ConfirmationBinding): InspectResult {
    const r = looksLikeConfirmationId(id) ? this.records.get(id) : undefined
    if (r === undefined || r.userId !== binding.userId || r.sessionKey !== binding.sessionKey)
      return { state: 'unusable', why: 'unknown' }
    if (r.status === 'used') return { state: 'unusable', why: 'used' }
    if (!sameBinding(r, binding)) return { state: 'unusable', why: 'mismatch' }
    if (r.status === 'declined') return { state: 'declined', record: r }
    if (this.expired(r)) return { state: 'unusable', why: 'expired' }
    if (r.status === 'approved') return { state: 'approved', record: r }
    return { state: 'pending', record: r }
  }

  /**
   * Use an approved confirmation for exactly the call it was created for.
   * Single use: a second consume of the same id fails. Returns the record,
   * or why it cannot be used.
   */
  consume(
    id: string,
    binding: ConfirmationBinding,
  ):
    | { ok: true; record: ConfirmationRecord }
    | { ok: false; state: Exclude<InspectResult['state'], 'approved'>; why?: string } {
    const inspected = this.inspect(id, binding)
    if (inspected.state !== 'approved') {
      return inspected.state === 'unusable'
        ? { ok: false, state: 'unusable', why: inspected.why }
        : { ok: false, state: inspected.state }
    }
    const r = inspected.record
    r.status = 'used'
    r.usedAt = new Date(this.now())
    return { ok: true, record: structuredClone(r) }
  }

  /** The page's view, for the user the confirmation belongs to only. */
  viewForUser(id: string, userId: string): ConfirmationView | null {
    const r = looksLikeConfirmationId(id) ? this.records.get(id) : undefined
    if (r === undefined || r.userId !== userId) return null
    return this.viewOf(r)
  }

  /** Approve or decline, once, before it expires; only its own user. */
  decide(id: string, userId: string, approve: boolean): DecisionResult {
    const r = looksLikeConfirmationId(id) ? this.records.get(id) : undefined
    if (r === undefined || r.userId !== userId) return { ok: false, reason: 'not_found' }
    if (r.status !== 'pending')
      return { ok: false, reason: 'already_decided', view: this.viewOf(r) }
    if (this.expired(r)) return { ok: false, reason: 'expired', view: this.viewOf(r) }
    r.status = approve ? 'approved' : 'declined'
    r.decidedAt = new Date(this.now())
    this.notify(id, approve ? 'approved' : 'declined')
    return { ok: true, view: this.viewOf(r) }
  }

  /**
   * Resolve when the confirmation is decided, expires, or `signal` aborts
   * (URL-mode elicitation keeps the tool call open meanwhile).
   */
  waitForDecision(id: string, signal?: AbortSignal): Promise<WaitOutcome> {
    const r = this.records.get(id)
    if (r === undefined) return Promise.resolve('expired')
    if (r.status === 'approved' || r.status === 'used') return Promise.resolve('approved')
    if (r.status === 'declined') return Promise.resolve('declined')
    const remaining = r.expiresAt.getTime() - this.now()
    if (remaining <= 0) return Promise.resolve('expired')
    if (signal?.aborted === true) return Promise.resolve('aborted')
    return new Promise<WaitOutcome>((resolve) => {
      let settled = false
      const finish = (outcome: WaitOutcome): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        this.waiters.get(id)?.delete(finish)
        resolve(outcome)
      }
      const onAbort = (): void => finish('aborted')
      const timer = setTimeout(() => finish('expired'), remaining)
      timer.unref?.()
      signal?.addEventListener('abort', onAbort, { once: true })
      let waiting = this.waiters.get(id)
      if (waiting === undefined) this.waiters.set(id, (waiting = new Set()))
      waiting.add(finish)
    })
  }

  /** Forget confirmations well past their expiry (pending, decided or used). */
  sweep(): void {
    const cutoff = this.now() - KEEP_AFTER_EXPIRY_MS
    for (const [id, r] of this.records) if (r.expiresAt.getTime() <= cutoff) this.drop(id)
  }

  /** Forget every confirmation bound to an agent session (the session ended). */
  forgetSession(sessionKey: string): void {
    for (const [id, r] of this.records) if (r.sessionKey === sessionKey) this.drop(id)
  }
}
