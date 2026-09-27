/**
 * observability/sentry.test.ts — the Sentry scrubber (L7): credential
 * headers, request cookies, personal access tokens and the session cookie
 * never leave the process in an event, a transaction or a breadcrumb.
 */

import { describe, it, expect } from 'vitest'
import { FILTERED, scrubSentryPayload, scrubString } from './sentry.js'

const PAT = `nrt_${'Ab9_-'.repeat(8)}xyz`

describe('scrubSentryPayload', () => {
  it('filters credential headers in any casing, and request cookies', () => {
    const event = {
      request: {
        url: 'https://narrative.example.com/api/decks',
        headers: {
          Authorization: `Bearer ${PAT}`,
          cookie: 'narrative_session=abc; other=1',
          'Set-Cookie': 'narrative_session=def',
          'Proxy-Authorization': 'Basic x',
          'user-agent': 'curl/8',
        },
        cookies: { narrative_session: 'abc' },
      },
    }
    const out = scrubSentryPayload(event)
    expect(out.request.headers).toEqual({
      Authorization: FILTERED,
      cookie: FILTERED,
      'Set-Cookie': FILTERED,
      'Proxy-Authorization': FILTERED,
      'user-agent': 'curl/8',
    })
    expect(out.request.cookies).toBe(FILTERED)
    // The input is untouched.
    expect(event.request.headers.Authorization).toBe(`Bearer ${PAT}`)
  })

  it('masks tokens and session cookies inside any string, however deep', () => {
    const event = {
      message: `verify failed for ${PAT}`,
      exception: {
        values: [
          {
            value: `Error: bad header narrative_session=s3cr3t; Path=/`,
            stacktrace: { frames: [{ vars: { token: PAT, nested: [{ t: `x ${PAT} y` }] } }] },
          },
        ],
      },
      breadcrumbs: [{ data: { url: `https://h/api/mcp?token=${PAT}` } }],
      extra: { headers: { AUTHORIZATION: 'Bearer abc' } },
    }
    const out = JSON.stringify(scrubSentryPayload(event))
    expect(out).not.toContain(PAT.slice(4))
    expect(out).not.toContain('s3cr3t')
    expect(out).not.toContain('Bearer abc')
    expect(out).toContain(`nrt_${FILTERED}`)
    expect(out).toContain(`narrative_session=${FILTERED}`)
  })

  it('handles breadcrumbs, cycles and non-object values without throwing', () => {
    const crumb: Record<string, unknown> = { category: 'http', message: PAT }
    crumb['self'] = crumb
    const out = scrubSentryPayload(crumb)
    expect(out['message']).toBe(`nrt_${FILTERED}`)
    expect(out['self']).toBe(FILTERED)
    expect(scrubSentryPayload(null)).toBeNull()
    expect(scrubSentryPayload(42)).toBe(42)
  })

  it('masks every MCP OAuth credential kind, keeping its prefix', () => {
    const secret = 'Zx9_-'.repeat(8)
    for (const prefix of ['nmo', 'nmr', 'nmc', 'nms']) {
      const out = scrubString(`POST /oauth/token code=${prefix}_${secret}&x=1`)
      expect(out).toBe(`POST /oauth/token code=${prefix}_${FILTERED}&x=1`)
    }
  })

  it('leaves ordinary text alone', () => {
    expect(scrubString('deck d1 has 3 slides; tokens.colors.primary')).toBe(
      'deck d1 has 3 slides; tokens.colors.primary',
    )
  })
})
