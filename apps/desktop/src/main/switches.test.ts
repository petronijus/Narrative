import { describe, expect, it } from 'vitest'
import { refusedSwitches } from './switches.js'

const exe = '/opt/Narrative/narrative'

describe('switches of a packaged app', () => {
  it('starts with links, files and the launcher switches', () => {
    expect(
      refusedSwitches([
        exe,
        'narrative://auth/complete?ticket=x',
        '/home/p/deck.pptx',
        '--ozone-platform-hint=auto',
        '--enable-wayland-ime',
        '-psn_0_12345',
      ]),
    ).toEqual([])
  })

  it.each([
    '--proxy-server=http://evil:8080',
    '--ignore-certificate-errors',
    '--log-net-log=/tmp/x',
    '--remote-debugging-port=9222',
    '-remote-debugging-port=9222',
    '--user-data-dir=/tmp/other',
    '--disable-web-security',
    '--host-resolver-rules=MAP * evil',
    '--js-flags=--allow-natives-syntax',
    '--renderer-cmd-prefix=gdb',
    '--no-sandbox',
    '--INSPECT',
  ])('refuses %s', (arg) => {
    expect(refusedSwitches([exe, arg])).toHaveLength(1)
  })

  it('reads nothing after a bare --', () => {
    expect(refusedSwitches([exe, '--', '--proxy-server=x'])).toEqual([])
  })
})
