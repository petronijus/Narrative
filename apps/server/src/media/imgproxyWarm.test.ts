import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createImgproxyWarmer, MAX_PENDING } from './imgproxyWarm.js'
import { signImgproxyUrl } from './imgproxyUrl.js'

const KEY = 'ab'.repeat(32)
const SALT = 'cd'.repeat(32)

beforeEach(() => {
  vi.stubEnv('IMGPROXY_KEY', KEY)
  vi.stubEnv('IMGPROXY_SALT', SALT)
})
afterEach(() => {
  vi.unstubAllEnvs()
})

/** A fetch that records URLs and answers when `release` is called (or at once). */
function fakeFetch(opts: { hold?: boolean } = {}) {
  const urls: string[] = []
  const pending: Array<() => void> = []
  let inFlight = 0
  let maxInFlight = 0
  const impl = vi.fn(async (url: string | URL | Request) => {
    urls.push(String(url))
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    if (opts.hold === true) await new Promise<void>((resolve) => pending.push(resolve))
    inFlight -= 1
    return new Response('img')
  })
  return {
    impl: impl as unknown as typeof fetch,
    urls,
    release: () => pending.splice(0).forEach((r) => r()),
    maxInFlight: () => maxInFlight,
  }
}

describe('imgproxy warmer', () => {
  it("requests a browser's signed paths of preview, then display, on the cache's address", async () => {
    const f = fakeFetch()
    const warmer = createImgproxyWarmer({ endpoint: 'http://cache.internal', fetchImpl: f.impl })
    expect(warmer.warm('decks/d1/uploads/a1/original.jpg')).toBe(true)
    await warmer.idle()
    const browser = (variant: 'preview' | 'display') =>
      signImgproxyUrl({
        storageKey: 'decks/d1/uploads/a1/original.jpg',
        variant,
        baseUrl: 'https://narrative.test/imgproxy',
      })
    // The same path and signature a viewer's URL has: nginx keys its cache on it.
    expect(f.urls).toEqual([
      browser('preview').replace('https://narrative.test/imgproxy', 'http://cache.internal'),
      browser('display').replace('https://narrative.test/imgproxy', 'http://cache.internal'),
    ])
  })

  it('is off without an endpoint', () => {
    const f = fakeFetch()
    const warmer = createImgproxyWarmer({ endpoint: null, fetchImpl: f.impl })
    expect(warmer.warm('decks/d1/uploads/a1/original.jpg')).toBe(false)
    expect(f.urls).toEqual([])
  })

  it('never waits for the requests, runs one image at a time, and skips past the bound', async () => {
    const f = fakeFetch({ hold: true })
    const warmer = createImgproxyWarmer({ endpoint: 'http://cache.internal', fetchImpl: f.impl })
    // Returns at once although nothing answered.
    expect(warmer.warm('k0')).toBe(true)
    // The same key twice is one entry.
    expect(warmer.warm('k0')).toBe(true)
    for (let i = 1; i <= MAX_PENDING; i++) expect(warmer.warm(`k${i}`)).toBe(true)
    expect(warmer.warm('one too many')).toBe(false)
    expect(warmer.pending).toBe(MAX_PENDING + 1)
    // Drain: each release answers what is in flight.
    while (warmer.pending > 0) {
      f.release()
      await new Promise((r) => setTimeout(r, 0))
    }
    await warmer.idle()
    expect(f.maxInFlight()).toBe(1)
    expect(f.urls).toHaveLength((MAX_PENDING + 1) * 2)
  })

  it('swallows failures and goes on with the next variant and image', async () => {
    const urls: string[] = []
    const failing = vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url))
      throw new Error('connection refused')
    }) as unknown as typeof fetch
    const warmer = createImgproxyWarmer({ endpoint: 'http://cache.internal', fetchImpl: failing })
    warmer.warm('a')
    warmer.warm('b')
    await warmer.idle()
    expect(urls).toHaveLength(4)
  })

  it('a missing signing key fails the warm quietly, not the upload', async () => {
    vi.stubEnv('IMGPROXY_KEY', '')
    const f = fakeFetch()
    const warmer = createImgproxyWarmer({ endpoint: 'http://cache.internal', fetchImpl: f.impl })
    expect(warmer.warm('a')).toBe(true)
    await warmer.idle()
    expect(f.urls).toEqual([])
  })
})
