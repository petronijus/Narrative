import { describe, expect, it } from 'vitest'
import { maskTokens, refuseLate, RenderJobError, renderPageUrl } from './render.js'

describe('renderPageUrl', () => {
  it('opens the deck render page on the first slide with the token as share_token', () => {
    const url = renderPageUrl(
      'https://narrative.example.com',
      {
        deckId: 'd 1',
        uploads: [{ slideId: 's1', url: 'https://storage.test/a', headers: {} }],
        token: `nrr_${'a'.repeat(43)}`,
        deadline: 0,
        workBudgetMs: 0,
      },
      's1',
    )
    const parsed = new URL(url)
    expect(parsed.origin).toBe('https://narrative.example.com')
    expect(parsed.pathname).toBe('/deck/d%201/render')
    expect(parsed.searchParams.get('slide')).toBe('s1')
    expect(parsed.searchParams.get('share_token')).toBe(`nrr_${'a'.repeat(43)}`)
  })
})

describe('refuseLate', () => {
  const job = (deadline: number) => ({
    deckId: 'd',
    uploads: [],
    token: 'nrr_x',
    deadline,
    workBudgetMs: 1_000,
  })

  it('drops a job nobody waits for, without blaming the browser', () => {
    let caught: unknown
    try {
      refuseLate(job(Date.now() - 1))
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(RenderJobError)
    expect((caught as RenderJobError).reason).toBe('late')
    expect((caught as RenderJobError).browserSuspect).toBe(false)
    expect(() => refuseLate(job(Date.now() + 60_000))).not.toThrow()
  })
})

describe('maskTokens', () => {
  it('keeps render tokens and share links out of errors and logs', () => {
    expect(
      maskTokens(`net::ERR at https://n.example/a?share_token=nrr_${'b'.repeat(43)}&x=1`),
    ).toBe('net::ERR at https://n.example/a?share_token=***&x=1')
    expect(maskTokens(`token nrr_${'c'.repeat(43)} expired`)).toBe('token nrr_*** expired')
  })
})
