import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assetOfResult,
  createVideoStillsWarmer,
  listenForVideoStills,
  MAX_PENDING,
  type TranscodeEvents,
  type VideoStills,
} from './videoStillsWarm.js'
import { signImgproxyUrl } from './imgproxyUrl.js'

const KEY = 'ab'.repeat(32)
const SALT = 'cd'.repeat(32)
const PUBLIC = 'https://narrative.test/imgproxy'
const CACHE = 'http://cache.internal'

beforeEach(() => {
  vi.stubEnv('IMGPROXY_KEY', KEY)
  vi.stubEnv('IMGPROXY_SALT', SALT)
  vi.stubEnv('IMGPROXY_ENDPOINT', PUBLIC)
})
afterEach(() => {
  vi.unstubAllEnvs()
})

const STILLS: VideoStills = {
  posterKey: 'decks/d1/videos/v1/poster.jpg',
  thumbnailKey: 'decks/d1/videos/v1/thumb.jpg',
}

/** A fetch that records URLs; with `hold`, answers only on `release`. */
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
    return new Response('jpg')
  })
  return {
    impl: impl as unknown as typeof fetch,
    urls,
    release: () => pending.splice(0).forEach((r) => r()),
    maxInFlight: () => maxInFlight,
  }
}

describe('video stills warmer', () => {
  it("requests exactly video-info's poster and thumbnail paths, on the cache's address", async () => {
    const f = fakeFetch()
    const warmer = createVideoStillsWarmer({
      endpoint: CACHE,
      readStills: async () => STILLS,
      fetchImpl: f.impl,
    })
    expect(warmer.warm('v1')).toBe(true)
    await warmer.idle()
    // As services/media.ts `videoInfo` signs them for a viewer: nginx keys
    // its cache on the path and signature, so anything else warms nothing.
    const viewer = [
      signImgproxyUrl({ storageKey: STILLS.posterKey!, variant: 'display', extension: 'jpg' }),
      signImgproxyUrl({ storageKey: STILLS.thumbnailKey!, variant: 'thumb', extension: 'jpg' }),
    ]
    expect(f.urls).toEqual(viewer.map((url) => url.replace(PUBLIC, CACHE)))
  })

  it('is off without an endpoint', async () => {
    const f = fakeFetch()
    const readStills = vi.fn(async () => STILLS)
    const warmer = createVideoStillsWarmer({ endpoint: null, readStills, fetchImpl: f.impl })
    expect(warmer.warm('v1')).toBe(false)
    await warmer.idle()
    expect(readStills).not.toHaveBeenCalled()
    expect(f.urls).toEqual([])
  })

  it('reads the keys from the row, and skips a still the row does not have', async () => {
    const f = fakeFetch()
    const readStills = vi.fn(async (assetId: string) =>
      assetId === 'gone' ? null : { posterKey: STILLS.posterKey, thumbnailKey: null },
    )
    const warmer = createVideoStillsWarmer({ endpoint: CACHE, readStills, fetchImpl: f.impl })
    warmer.warm('gone')
    warmer.warm('v1')
    await warmer.idle()
    expect(readStills.mock.calls.map(([id]) => id)).toEqual(['gone', 'v1'])
    expect(f.urls).toHaveLength(1)
    expect(f.urls[0]).toContain('/rs:fit:2560:2560:0/')
  })

  it('warms an asset once, however many events name it', async () => {
    const f = fakeFetch()
    const warmer = createVideoStillsWarmer({
      endpoint: CACHE,
      readStills: async () => STILLS,
      fetchImpl: f.impl,
    })
    expect(warmer.warm('v1')).toBe(true)
    expect(warmer.warm('v1')).toBe(false)
    await warmer.idle()
    expect(warmer.warm('v1')).toBe(false)
    expect(f.urls).toHaveLength(2)
  })

  it('makes one request at a time and bounds the waiting videos', async () => {
    const f = fakeFetch({ hold: true })
    const warmer = createVideoStillsWarmer({
      endpoint: CACHE,
      readStills: async () => STILLS,
      fetchImpl: f.impl,
    })
    // One running, MAX_PENDING waiting, the next refused.
    for (let i = 0; i <= MAX_PENDING; i++) expect(warmer.warm(`v${i}`)).toBe(true)
    expect(warmer.warm('one-too-many')).toBe(false)
    for (let i = 0; i < 2 * (MAX_PENDING + 1); i++) {
      await vi.waitFor(() => expect(f.urls.length).toBe(i + 1))
      f.release()
    }
    await warmer.idle()
    expect(f.maxInFlight()).toBe(1)
    expect(warmer.pending).toBe(0)
  })

  it('survives a failing read and a failing request', async () => {
    let calls = 0
    const impl = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw new Error('cache down')
      return new Response('jpg')
    }) as unknown as typeof fetch
    const warmer = createVideoStillsWarmer({
      endpoint: CACHE,
      readStills: async (id) => {
        if (id === 'bad') throw new Error('db down')
        return STILLS
      },
      fetchImpl: impl,
    })
    warmer.warm('bad')
    warmer.warm('v1')
    await warmer.idle()
    // The poster failed, the thumbnail was still asked for.
    expect(calls).toBe(2)
  })
})

describe('the transcode queue events', () => {
  function setup() {
    const emitter = new EventEmitter()
    const warmed: string[] = []
    listenForVideoStills(emitter as unknown as TranscodeEvents, {
      warm: (id) => {
        warmed.push(id)
        return true
      },
      idle: async () => undefined,
      pending: 0,
    })
    return { emitter, warmed }
  }

  it("warms on the worker's stills report and on a completion", () => {
    const { emitter, warmed } = setup()
    emitter.emit('progress', { jobId: '1', data: { stage: 'stills', assetId: 'v1' } })
    emitter.emit('completed', { jobId: '2', returnvalue: { assetId: 'v2', posterKey: 'x' } })
    // BullMQ may hand the return value over as its JSON.
    emitter.emit('completed', { jobId: '3', returnvalue: JSON.stringify({ assetId: 'v3' }) })
    expect(warmed).toEqual(['v1', 'v2', 'v3'])
  })

  it('ignores any other progress and return values that name no asset', () => {
    const { emitter, warmed } = setup()
    emitter.emit('progress', { jobId: '1', data: 50 })
    emitter.emit('progress', { jobId: '1', data: { stage: 'playback', assetId: 'v1' } })
    emitter.emit('progress', { jobId: '1', data: { stage: 'stills', assetId: '' } })
    emitter.emit('completed', { jobId: '2', returnvalue: 'not json' })
    emitter.emit('completed', { jobId: '2', returnvalue: null })
    expect(warmed).toEqual([])
  })

  it('reads an asset id from a return value only when it is a non-empty string', () => {
    expect(assetOfResult({ assetId: 'a' })).toBe('a')
    expect(assetOfResult('{"assetId":"b"}')).toBe('b')
    expect(assetOfResult({ assetId: 7 })).toBeNull()
    expect(assetOfResult(undefined)).toBeNull()
  })
})
