import { describe, expect, it } from 'vitest'
import {
  MAX_LAUNCH_FILES,
  MAX_LAUNCH_PAYLOAD_BYTES,
  capLaunchPayload,
  parseCompleteUrl,
  parseLaunchArgs,
  validateLaunchPayload,
} from './deepLinks.js'

const TICKET = `ndt_${'a'.repeat(43)}`
const STATE = 'b'.repeat(43)
const LINK = `narrative://auth/complete?ticket=${TICKET}&state=${STATE}`

describe('launch arguments', () => {
  it('finds the link and .pptx files among Chromium, Playwright and app arguments', () => {
    const argv = [
      '/opt/Narrative/narrative',
      '-r',
      '/tmp/loader.js',
      '--no-sandbox',
      '--inspect=0',
      '/home/p/app',
      LINK,
      'Deck.PPTX',
      'file:///home/p/Other%20deck.pptx',
      'notes.txt',
    ]
    expect(parseLaunchArgs(argv, '/home/p/app', '/home/p', 'narrative')).toEqual({
      deepLink: LINK,
      files: ['/home/p/Deck.PPTX', '/home/p/Other deck.pptx'],
    })
  })

  it('takes only the active scheme', () => {
    const argv = ['exe', LINK.replace('narrative:', 'narrative-dev:')]
    expect(parseLaunchArgs(argv, '/app', '/', 'narrative').deepLink).toBeNull()
    expect(parseLaunchArgs(argv, '/app', '/', 'narrative-dev').deepLink).not.toBeNull()
  })

  it('stops at 20 files', () => {
    const argv = ['exe', ...Array.from({ length: 25 }, (_, i) => `/d/${i}.pptx`)]
    expect(parseLaunchArgs(argv, '/app', '/', 'narrative').files).toHaveLength(MAX_LAUNCH_FILES)
  })
})

describe('the hand-over to the running instance', () => {
  it('keeps the link and drops what does not fit, counting it', () => {
    const files = Array.from({ length: 20 }, (_, i) => `/${'x'.repeat(600)}/${i}.pptx`)
    const { payload, dropped } = capLaunchPayload({ deepLink: LINK, files })
    expect(payload.deepLink).toBe(LINK)
    expect(payload.files.length + dropped).toBe(20)
    expect(dropped).toBeGreaterThan(0)
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(MAX_LAUNCH_PAYLOAD_BYTES)
  })

  it('refuses a malformed payload piece by piece', () => {
    expect(validateLaunchPayload(null, 'narrative')).toEqual({ deepLink: null, files: [] })
    expect(
      validateLaunchPayload(
        {
          deepLink: 'https://evil.example',
          files: ['relative.pptx', '/abs/a.pptx', '/abs/b.exe', 7],
        },
        'narrative',
      ),
    ).toEqual({ deepLink: null, files: ['/abs/a.pptx'] })
    expect(validateLaunchPayload({ deepLink: LINK, files: [] }, 'narrative').deepLink).toBe(LINK)
  })
})

describe('the sign-in hand-off link', () => {
  it('reads ticket and state', () => {
    expect(parseCompleteUrl(LINK, 'narrative')).toEqual({ ticket: TICKET, state: STATE })
  })

  it.each([
    ['another scheme', LINK.replace('narrative:', 'narrative-dev:')],
    ['another host', LINK.replace('//auth/', '//evil/')],
    ['another path', LINK.replace('/complete', '/start')],
    ['a malformed ticket', LINK.replace(TICKET, 'ndt_short')],
    ['another credential', LINK.replace('ndt_', 'nrt_')],
    ['a malformed state', LINK.replace(STATE, 'x')],
    ['a repeated ticket', `${LINK}&ticket=${TICKET}`],
    ['no state', `narrative://auth/complete?ticket=${TICKET}`],
    ['not a URL', 'nonsense'],
  ])('refuses %s', (_label, link) => {
    expect(parseCompleteUrl(link, 'narrative')).toBeNull()
  })
})
