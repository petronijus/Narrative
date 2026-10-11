/**
 * main/signIn.ts
 *
 * The shell's half of the desktop sign-in (ADR 0014,
 * docs/plans/desktop-d0-spec.md §3.4 and §4.4). Google refuses OAuth inside
 * the app, so:
 *
 *   1. `start` makes a PKCE verifier and a state nonce, remembers them and
 *      opens the server's `/auth/start?client=desktop…` in the system browser;
 *   2. the server hands a one-time ticket back through
 *      `<scheme>://auth/complete?ticket=…&state=…`;
 *   3. `complete` takes that link only while its own sign-in is pending, for
 *      the server it started on, with the state it made (compared in
 *      constant time), and redeems ticket + verifier in a hidden window of
 *      the server's partition, so the session cookie lands where the editor
 *      reads it.
 *
 * The verifier and state are used once: whatever the redeem's outcome, the
 * pending sign-in ends with it (security review of D0 steps 2–4, M2a). The
 * ticket is single-use on the server anyway, so a retry could never succeed.
 * Electron is injected (`SignInDeps`), so this logic is tested without it.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { parseCompleteUrl, type DesktopScheme } from './deepLinks.js'

/** The server's OAuth state cookie lives 10 minutes (apps/server/src/routes/auth.ts). */
export const PENDING_TTL_MS = 10 * 60_000
/** One page cannot open unlimited browser tabs. */
export const START_COOLDOWN_MS = 5_000
/** No redirect from the redeem within this time counts as a failure. */
export const REDEEM_TIMEOUT_MS = 15_000

export type RedeemOutcome =
  | { kind: 'signed-in'; target: string }
  | { kind: 'failed'; reason: string }

export interface RedeemRequest {
  /** `<api>/auth/desktop/redeem` */
  url: string
  /** The form body: ticket and verifier. */
  body: string
  serverOrigin: string
}

export interface SignInDeps {
  now(): number
  /** The server the shell has loaded: its origin and API base. */
  server(): { origin: string; apiUrl: string } | null
  scheme: DesktopScheme
  /** Open a URL in the system browser. */
  openExternal(url: string): Promise<void>
  /** Post the redeem as a navigation of a hidden window in the server's partition. */
  redeem(request: RedeemRequest): Promise<RedeemOutcome>
  /** Show the app signed in at `target` (a URL on the server). */
  signedIn(target: string): void
  /** Tell the person the sign-in did not work. */
  failed(reason: string): void
  log: {
    info(message: string, fields?: object): void
    warn(message: string, fields?: object): void
  }
}

interface Pending {
  verifier: string
  state: string
  serverOrigin: string
  apiUrl: string
  createdAt: number
}

const isSafeReturnTo = (value: string): boolean =>
  value.startsWith('/') &&
  !value.startsWith('//') &&
  value.length < 500 &&
  !/[\x00-\x1f\x7f\\]/.test(value)

export class SignInController {
  private pending: Pending | null = null
  private lastStart = -Infinity
  private redeeming = false

  constructor(private readonly deps: SignInDeps) {}

  /** Start a sign-in in the system browser; 'refused' within the cooldown or without a server. */
  async start(returnTo: string): Promise<'opened' | 'refused'> {
    const now = this.deps.now()
    const server = this.deps.server()
    if (server === null || !isSafeReturnTo(returnTo)) return 'refused'
    if (now - this.lastStart < START_COOLDOWN_MS) {
      this.deps.log.warn('sign-in start refused: cooldown')
      return 'refused'
    }
    this.lastStart = now
    const verifier = randomBytes(32).toString('base64url')
    const state = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url')
    // A new start replaces an older one; its link is then refused.
    this.pending = {
      verifier,
      state,
      serverOrigin: server.origin,
      apiUrl: server.apiUrl,
      createdAt: now,
    }
    const query = new URLSearchParams({
      client: 'desktop',
      scheme: this.deps.scheme,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      desktop_state: state,
      returnTo,
    })
    await this.deps.openExternal(`${server.apiUrl}/auth/start?${query.toString()}`)
    this.deps.log.info('sign-in started in the browser')
    return 'opened'
  }

  /** Forget a pending sign-in (the shell moved to another server). */
  cancel(): void {
    this.pending = null
  }

  /** Whether a sign-in is waiting for its link (for tests and the UI). */
  get isPending(): boolean {
    return this.pending !== null && this.deps.now() - this.pending.createdAt < PENDING_TTL_MS
  }

  /**
   * Take a `<scheme>://auth/complete` link. Anything that is not the answer
   * to this shell's own pending sign-in is ignored (and logged without the
   * ticket); a link that is, is redeemed once.
   */
  async complete(link: string): Promise<void> {
    const parsed = parseCompleteUrl(link, this.deps.scheme)
    if (parsed === null) {
      this.deps.log.warn('sign-in link ignored: not a sign-in link')
      return
    }
    const pending = this.pending
    const server = this.deps.server()
    if (pending === null || this.deps.now() - pending.createdAt >= PENDING_TTL_MS) {
      this.deps.log.warn('sign-in link ignored: no sign-in is pending')
      return
    }
    if (server === null || server.origin !== pending.serverOrigin) {
      this.deps.log.warn('sign-in link ignored: started for another server')
      return
    }
    const a = Buffer.from(parsed.state, 'utf8')
    const b = Buffer.from(pending.state, 'utf8')
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      this.deps.log.warn('sign-in link ignored: state does not match')
      return
    }
    if (this.redeeming) {
      this.deps.log.warn('sign-in link ignored: a redeem is running')
      return
    }

    // From here the verifier is spent, whatever happens.
    this.pending = null
    this.redeeming = true
    try {
      const outcome = await this.deps.redeem({
        url: `${pending.apiUrl}/auth/desktop/redeem`,
        body: new URLSearchParams({ ticket: parsed.ticket, verifier: pending.verifier }).toString(),
        serverOrigin: pending.serverOrigin,
      })
      if (outcome.kind === 'signed-in') {
        this.deps.log.info('signed in')
        this.deps.signedIn(outcome.target)
      } else {
        this.deps.log.warn('sign-in redeem failed', { reason: outcome.reason })
        this.deps.failed(outcome.reason)
      }
    } finally {
      this.redeeming = false
    }
  }
}

/**
 * Where the redeem's 303 went: into the app (signed in), or to the sign-in
 * error page, or anywhere else (a failure).
 */
export function classifyRedeemRedirect(target: string, serverOrigin: string): RedeemOutcome {
  let url: URL
  try {
    url = new URL(target)
  } catch {
    return { kind: 'failed', reason: 'bad_redirect' }
  }
  if (url.origin !== serverOrigin) return { kind: 'failed', reason: 'foreign_redirect' }
  if (url.pathname === '/auth/error') {
    return { kind: 'failed', reason: url.searchParams.get('reason') ?? 'sign_in_failed' }
  }
  return { kind: 'signed-in', target: url.toString() }
}
