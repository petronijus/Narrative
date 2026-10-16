/**
 * The desktop sign-in, end to end in the shell against a stub server that
 * plays the API's part (ADR 0015; the real routes are unit-tested in
 * apps/server/src/routes/desktopAuth.test.ts): the start URL in the system
 * browser, the hand-off link, the redeem as the shell's own navigation in a
 * hidden window, the cookie in the server's partition, the main window
 * signed in — and every link that is not the answer to its own sign-in
 * ignored.
 */

import { createHash, randomBytes } from 'node:crypto'
import { expect, test, type DesktopShell, type StubRequest } from './fixtures/desktop'

const TICKET = `ndt_${randomBytes(32).toString('base64url')}`

/** A stub API: records the start, checks and answers the redeem. */
function signInApi(state: { challenge: string | null; redeems: StubRequest[] }) {
  return (req: StubRequest, res: import('node:http').ServerResponse): boolean => {
    if (req.url.startsWith('/api/auth/start')) {
      state.challenge = new URL(req.url, 'http://x').searchParams.get('code_challenge')
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<p>at Google</p>')
      return true
    }
    if (req.url === '/api/auth/desktop/redeem' && req.method === 'POST') {
      state.redeems.push(req)
      const form = new URLSearchParams(req.body)
      const verifier = form.get('verifier') ?? ''
      const ok =
        form.get('ticket') === TICKET &&
        createHash('sha256').update(verifier).digest('base64url') === state.challenge &&
        req.headers['x-narrative-desktop'] === '1' &&
        req.headers['sec-fetch-site'] === 'none'
      res.writeHead(303, {
        location: ok ? '/after' : '/auth/error?reason=desktop_sign_in_failed',
        ...(ok
          ? { 'set-cookie': 'narrative_session=test-session; HttpOnly; Path=/; SameSite=Lax' }
          : {}),
        'cache-control': 'no-store',
      })
      res.end()
      return true
    }
    return false
  }
}

async function startSignIn(shell: DesktopShell): Promise<URLSearchParams> {
  expect(
    await shell.window.evaluate(() => window.narrativeDesktop!.signIn({ returnTo: '/after' })),
  ).toBe('opened')
  await expect.poll(async () => (await shell.opened()).length).toBe(1)
  return new URL((await shell.opened())[0]!).searchParams
}

function deliver(shell: DesktopShell, link: string): Promise<void> {
  return shell.app.evaluate(({ app }, deepLink) => {
    app.emit('second-instance', {}, [], '', { deepLink, files: [] })
  }, link)
}

const link = (ticket: string, state: string) =>
  `narrative-dev://auth/complete?ticket=${ticket}&state=${state}`

test.describe('desktop sign-in', () => {
  test('signs in through the system browser and lands signed in', async ({
    stubServer,
    launchShell,
  }) => {
    const api = { challenge: null as string | null, redeems: [] as StubRequest[] }
    const server = await stubServer(signInApi(api))
    const shell = await launchShell(server.origin)
    const params = await startSignIn(shell)
    expect(params.get('client')).toBe('desktop')
    expect(params.get('scheme')).toBe('narrative-dev')
    expect(params.get('code_challenge_method')).toBe('S256')
    expect(params.get('returnTo')).toBe('/after')
    expect((await shell.opened())[0]!.startsWith(`${server.origin}/api/auth/start?`)).toBe(true)

    await deliver(shell, link(TICKET, params.get('desktop_state')!))
    await expect.poll(() => shell.window.url()).toBe(`${server.origin}/after`)
    expect(api.redeems).toHaveLength(1)
    expect(api.redeems[0]!.headers['content-type']).toBe('application/x-www-form-urlencoded')

    const partition = `persist:narrative-custom-${createHash('sha256').update(server.origin).digest('hex').slice(0, 16)}`
    const cookies = await shell.app.evaluate(
      ({ session }, { partition, origin }) =>
        session
          .fromPartition(partition)
          .cookies.get({ url: origin })
          .then((c) => c.map((x) => x.name)),
      { partition, origin: server.origin },
    )
    expect(cookies).toEqual(['narrative_session'])

    // The same link again: the verifier is spent, nothing is redeemed.
    await deliver(shell, link(TICKET, params.get('desktop_state')!))
    await shell.window.waitForTimeout(500)
    expect(api.redeems).toHaveLength(1)
  })

  test('ignores links that are not the answer to its own sign-in', async ({
    stubServer,
    launchShell,
  }) => {
    const api = { challenge: null as string | null, redeems: [] as StubRequest[] }
    const server = await stubServer(signInApi(api))
    const shell = await launchShell(server.origin)
    // No sign-in pending yet.
    await deliver(shell, link(TICKET, 'a'.repeat(43)))
    const params = await startSignIn(shell)
    await deliver(shell, link(TICKET, 'b'.repeat(43))) // another state
    await deliver(shell, link('ndt_short', params.get('desktop_state')!)) // a malformed ticket
    await deliver(
      shell,
      link(TICKET, params.get('desktop_state')!).replace('narrative-dev:', 'narrative:'),
    )
    await shell.window.waitForTimeout(800)
    expect(api.redeems).toHaveLength(0)
    expect(shell.window.url()).toBe(`${server.origin}/`)
  })

  test('shows the sign-in error when the server refuses the ticket', async ({
    stubServer,
    launchShell,
  }) => {
    const api = { challenge: null as string | null, redeems: [] as StubRequest[] }
    const server = await stubServer(signInApi(api))
    const shell = await launchShell(server.origin)
    const params = await startSignIn(shell)
    await deliver(shell, link(`ndt_${'z'.repeat(43)}`, params.get('desktop_state')!))
    await expect
      .poll(() => shell.window.url())
      .toBe(`${server.origin}/auth/error?reason=desktop_sign_in_failed`)
  })
})
