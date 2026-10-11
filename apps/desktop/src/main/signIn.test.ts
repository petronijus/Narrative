import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PENDING_TTL_MS,
  START_COOLDOWN_MS,
  SignInController,
  classifyRedeemRedirect,
  type RedeemOutcome,
  type SignInDeps,
} from './signIn.js'

const ORIGIN = 'https://narrative.example.com'
const API = `${ORIGIN}/api`
const TICKET = `ndt_${'t'.repeat(43)}`

let clock: number
let server: { origin: string; apiUrl: string } | null
let opened: string[]
let redeemed: Array<{ url: string; body: string; serverOrigin: string }>
let outcome: RedeemOutcome
let deps: SignInDeps

beforeEach(() => {
  clock = 1_000_000
  server = { origin: ORIGIN, apiUrl: API }
  opened = []
  redeemed = []
  outcome = { kind: 'signed-in', target: `${ORIGIN}/deck/abc` }
  deps = {
    now: () => clock,
    server: () => server,
    scheme: 'narrative',
    openExternal: vi.fn(async (url: string) => {
      opened.push(url)
    }),
    redeem: vi.fn(async (req) => {
      redeemed.push(req)
      return outcome
    }),
    signedIn: vi.fn(),
    failed: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn() },
  }
})

/** Start a sign-in; the start URL's parameters. */
async function start(
  controller: SignInController,
  returnTo = '/deck/abc',
): Promise<URLSearchParams> {
  expect(await controller.start(returnTo)).toBe('opened')
  const url = new URL(opened.at(-1)!)
  expect(`${url.origin}${url.pathname}`).toBe(`${API}/auth/start`)
  return url.searchParams
}

const link = (state: string, ticket = TICKET, scheme = 'narrative') =>
  `${scheme}://auth/complete?ticket=${ticket}&state=${state}`

describe('desktop sign-in in the shell', () => {
  it('opens the start URL with an S256 challenge and a state', async () => {
    const params = await start(new SignInController(deps))
    expect(params.get('client')).toBe('desktop')
    expect(params.get('scheme')).toBe('narrative')
    expect(params.get('code_challenge_method')).toBe('S256')
    expect(params.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(params.get('desktop_state')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(params.get('returnTo')).toBe('/deck/abc')
  })

  it('redeems the matching link once, with the verifier of the challenge', async () => {
    const controller = new SignInController(deps)
    const params = await start(controller)
    await controller.complete(link(params.get('desktop_state')!))
    expect(redeemed).toHaveLength(1)
    const body = new URLSearchParams(redeemed[0]!.body)
    expect(body.get('ticket')).toBe(TICKET)
    const verifier = body.get('verifier')!
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(
      params.get('code_challenge'),
    )
    expect(redeemed[0]!.url).toBe(`${API}/auth/desktop/redeem`)
    expect(deps.signedIn).toHaveBeenCalledWith(`${ORIGIN}/deck/abc`)
    // The same link again: the verifier is spent.
    await controller.complete(link(params.get('desktop_state')!))
    expect(redeemed).toHaveLength(1)
  })

  it('spends the verifier on a failed redeem too', async () => {
    outcome = { kind: 'failed', reason: 'desktop_sign_in_failed' }
    const controller = new SignInController(deps)
    const params = await start(controller)
    await controller.complete(link(params.get('desktop_state')!))
    expect(deps.failed).toHaveBeenCalledWith('desktop_sign_in_failed')
    expect(controller.isPending).toBe(false)
  })

  it.each([
    ['a wrong state', () => link('x'.repeat(43))],
    ['the dev scheme', (s: string) => link(s, TICKET, 'narrative-dev')],
    ['a malformed ticket', (s: string) => link(s, 'ndt_short')],
  ])('ignores %s and keeps the sign-in pending', async (_label, make) => {
    const controller = new SignInController(deps)
    const params = await start(controller)
    await controller.complete(make(params.get('desktop_state')!))
    expect(redeemed).toHaveLength(0)
    expect(controller.isPending).toBe(true)
  })

  it('ignores a link when no sign-in is pending, or after it expired', async () => {
    const controller = new SignInController(deps)
    await controller.complete(link('s'.repeat(43)))
    const params = await start(controller)
    clock += PENDING_TTL_MS
    await controller.complete(link(params.get('desktop_state')!))
    expect(redeemed).toHaveLength(0)
  })

  it('ignores a link after the shell moved to another server', async () => {
    const controller = new SignInController(deps)
    const params = await start(controller)
    server = { origin: 'http://localhost:5173', apiUrl: 'http://localhost:3001' }
    await controller.complete(link(params.get('desktop_state')!))
    expect(redeemed).toHaveLength(0)
  })

  it('refuses a second start within the cooldown, and an unsafe returnTo', async () => {
    const controller = new SignInController(deps)
    await start(controller)
    expect(await controller.start('/')).toBe('refused')
    clock += START_COOLDOWN_MS
    expect(await controller.start('/')).toBe('opened')
    clock += START_COOLDOWN_MS
    expect(await controller.start('//evil.example')).toBe('refused')
    expect(await controller.start('/\\evil.example')).toBe('refused')
  })

  it('a newer start replaces the older one', async () => {
    const controller = new SignInController(deps)
    const first = await start(controller)
    clock += START_COOLDOWN_MS
    const second = await start(controller)
    await controller.complete(link(first.get('desktop_state')!))
    expect(redeemed).toHaveLength(0)
    await controller.complete(link(second.get('desktop_state')!))
    expect(redeemed).toHaveLength(1)
  })
})

describe('the redeem redirect', () => {
  it('signs in on a page of the server', () => {
    expect(classifyRedeemRedirect(`${ORIGIN}/deck/abc`, ORIGIN)).toEqual({
      kind: 'signed-in',
      target: `${ORIGIN}/deck/abc`,
    })
  })
  it('fails on the error page or elsewhere', () => {
    expect(
      classifyRedeemRedirect(`${ORIGIN}/auth/error?reason=desktop_sign_in_failed`, ORIGIN),
    ).toEqual({ kind: 'failed', reason: 'desktop_sign_in_failed' })
    expect(classifyRedeemRedirect('https://evil.example/', ORIGIN).kind).toBe('failed')
  })
})
