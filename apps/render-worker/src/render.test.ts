import { describe, expect, it } from 'vitest'
import { maskTokens, refuseLate, RenderJobError, renderPageUrl } from './render.js'

describe('renderPageUrl', () => {
  it('opens the deck render page on the first slide, drawing nothing on screen, with the token as share_token', () => {
    const url = renderPageUrl(
      'https://narrative.example.com',
      {
        page: { kind: 'deck', deckId: 'd 1' },
        token: `nrr_${'a'.repeat(43)}`,
      },
      's1',
    )
    const parsed = new URL(url)
    expect(parsed.origin).toBe('https://narrative.example.com')
    expect(parsed.pathname).toBe('/deck/d%201/render')
    expect(parsed.searchParams.get('slide')).toBe('s1')
    expect(parsed.searchParams.get('paint')).toBe('off')
    expect(parsed.searchParams.get('share_token')).toBe(`nrr_${'a'.repeat(43)}`)
    expect(parsed.searchParams.has('frozen')).toBe(false)
  })

  it('opens a component master’s render page in its folder, and a frozen page when asked', () => {
    const url = new URL(
      renderPageUrl(
        'https://narrative.example.com',
        { page: { kind: 'component', componentId: 'c1', folderId: 'f1' }, token: 'nrr_x' },
        'master',
        { frozen: true },
      ),
    )
    expect(url.pathname).toBe('/folder/f1/component/c1/render')
    expect(url.searchParams.get('slide')).toBe('master')
    expect(url.searchParams.get('frozen')).toBe('1')
  })
})

describe('refuseLate', () => {
  const job = (deadline: number) => ({
    kind: 'export' as const,
    page: { kind: 'deck' as const, deckId: 'd' },
    uploads: [],
    token: 'nrr_x',
    stateVector: '',
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
