/**
 * services/render.test.ts
 *
 * The render service (services/render.ts) around a fake worker queue: which
 * slides it asks for, from the live document; who may ask; what the job
 * carries (a render token for this deck that outlives the deadline a little,
 * one presigned upload per slide with its signed headers, a deadline under
 * Cloudflare's 100 s, a work budget by size); the fair share of the
 * one-at-a-time queue (in-flight cap, priority by load); how the worker's
 * failures reach the caller; the two deliveries.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import {
  renderFailureMessage,
  type RenderExportJob,
  type RenderJobData,
  type RenderJobResult,
} from '@narrative/shared'

type RenderExportResult = Extract<RenderJobResult, { kind: 'export' }>
import { MAX_RENDER_SLIDES, type RenderView } from '@narrative/commands'

vi.mock('../auth/permissions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../auth/permissions.js')>()),
  resolveDeckAccess: vi.fn(),
}))
vi.mock('./liveDocs.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./liveDocs.js')>()),
  readDocCopy: vi.fn(),
}))
vi.mock('../media/s3Client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../media/s3Client.js')>()),
  buildS3Client: vi.fn(() => ({
    send: vi.fn(async () => ({
      ContentLength: 8,
      // A PNG's signature: the service checks what the worker stored.
      Body: {
        transformToByteArray: async () =>
          new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      },
    })),
  })),
  presignGetUrl: vi.fn(async (key: string) => `https://storage.test/get/${key}?sig`),
  presignPutUrl: vi.fn(async (key: string, type: string, ttl: number) => ({
    url: `https://storage.test/put/${key}?type=${type}&ttl=${ttl}`,
    headers: { 'content-type': type, 'cache-control': 'private, no-store' },
  })),
}))
vi.mock('../hocuspocus/connections.js', () => ({ closeShareTokenConnections: vi.fn(() => 0) }))
vi.mock('./deckThumbnailStore.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./deckThumbnailStore.js')>()),
  storeDeckThumbnail: vi.fn(),
}))
vi.mock('./decks.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./decks.js')>()),
  deckRecord: vi.fn((row: { thumbnailKey: string | null }) => ({
    thumbnailUrl: row.thumbnailKey === null ? null : `https://img.test/${row.thumbnailKey}?v=1`,
    thumbnailUpdatedAt: row.thumbnailKey === null ? null : '2026-10-11T18:00:00.000Z',
  })),
}))

import { resolveDeckAccess } from '../auth/permissions.js'
import { resolveRenderToken } from '../auth/renderTokens.js'
import { readDocCopy } from './liveDocs.js'
import { clearCardStateForTests } from '../render/cardState.js'
import { storeDeckThumbnail, type DeckRow } from './deckThumbnailStore.js'
import { buildS3Client } from '../media/s3Client.js'
import {
  BACKGROUND_PRIORITY,
  RendererBusyError,
  clearRenderInFlightForTests,
  createRenderService,
  MAX_IN_FLIGHT_PER_USER,
  MAX_WAITING_JOBS,
  pickSlides,
  RENDER_WAIT_MS,
  RENDER_WORK_BASE_MS,
  RENDER_WORK_PER_SLIDE_MS,
} from './render.js'
import { RenderTimeoutError, RenderUnavailableError, type RenderQueue } from '../render/queue.js'
import { SESSION_MAX_MS } from '../render/sessions.js'
import type { ServiceDeps } from './deps.js'
import { ServiceError } from './errors.js'

/** A deck document holding slides with these ids. */
function deckDoc(ids: string[]): Y.Doc {
  const doc = new Y.Doc()
  const slides = doc.getArray<Y.Map<unknown>>('slides')
  for (const id of ids) {
    const slide = new Y.Map<unknown>()
    slide.set('id', id)
    slide.set('objects', new Y.Array())
    slides.push([slide])
  }
  return doc
}

const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as unknown as ServiceDeps['log']
const NOW = 1_800_000_000_000

function setup(run: RenderQueue['run'], waiting = async () => 0) {
  const queue = { run: vi.fn(run), waiting: vi.fn(waiting) }
  const service = createRenderService({
    db: {} as ServiceDeps['db'],
    log,
    renderQueue: queue,
    now: () => NOW,
  })
  return { queue, service }
}

/** An export job (the tests that render PNGs give the worker nothing else). */
function exportJob(data: RenderJobData): RenderExportJob {
  if (data.kind !== 'export') throw new Error(`expected an export job, got ${data.kind}`)
  return data
}

/** What a successful export returns for the slides it was given. */
const rendered = (data: RenderJobData): RenderExportResult => ({
  kind: 'export',
  slides: exportJob(data).uploads.map(({ slideId }, i) => ({
    slideId,
    index: i,
    width: 1920,
    height: 1080,
    sizeBytes: 4,
    failedLoads: 0,
  })),
  failedFonts: [],
})

/** What a successful look returns. */
const looked = (data: RenderJobData): RenderJobResult => {
  if (data.kind !== 'look') throw new Error(`expected a look, got ${data.kind}`)
  const ids = data.look.mode === 'sheet' ? data.look.slideIds : [data.look.slideId]
  return {
    kind: 'look',
    look: {
      width: 1430,
      height: 804,
      sizeBytes: 4,
      slides: ids.map((slideId, i) => ({ slideId, index: i, failedLoads: 0 })),
    },
    failedFonts: [],
  }
}

const ask = (
  service: ReturnType<typeof setup>['service'],
  over: Partial<Parameters<ReturnType<typeof setup>['service']['exportPng']>[0]> = {},
) =>
  service.exportPng({
    userId: 'u1',
    deckId: 'd1',
    slides: 'all',
    delivery: 'url',
    ...over,
  })

async function status(promise: Promise<unknown>): Promise<number> {
  try {
    await promise
    return 200
  } catch (err) {
    if (err instanceof ServiceError) return err.status
    throw err
  }
}

beforeEach(() => {
  clearRenderInFlightForTests()
  vi.mocked(resolveDeckAccess).mockResolvedValue({ role: 'viewer', reason: 'direct' })
  vi.mocked(readDocCopy).mockImplementation(async () => deckDoc(['s1', 's2', 's3']))
})

describe('pickSlides', () => {
  const slides = [{ id: 's1' }, { id: 's2' }, { id: 's3' }]

  it('takes every slide, or the ones asked for in the order asked, each once', () => {
    expect(pickSlides(slides, 'all')).toEqual([
      { id: 's1', index: 0 },
      { id: 's2', index: 1 },
      { id: 's3', index: 2 },
    ])
    expect(pickSlides(slides, [{ id: 's3' }, { index: 0 }, { index: 2 }])).toEqual([
      { id: 's3', index: 2 },
      { id: 's1', index: 0 },
    ])
  })

  it('refuses a slide that does not exist (404)', async () => {
    expect(await status(Promise.resolve().then(() => pickSlides(slides, [{ id: 'zz' }])))).toBe(404)
    expect(await status(Promise.resolve().then(() => pickSlides(slides, [{ index: 3 }])))).toBe(404)
  })
})

describe('RenderService.exportPng', () => {
  it('gives the worker the slides, a deck token, one upload each, the live state, a deadline and a work budget', async () => {
    const { queue, service } = setup(async (data) => rendered(data))
    const out = await ask(service, { slides: [{ index: 1 }] })
    const [job, opts] = queue.run.mock.calls[0]!
    const data = exportJob(job)
    // What the live document held when the job was made: its one writer's clock.
    const vector = Y.decodeStateVector(Buffer.from(data.stateVector, 'base64'))
    expect(vector.size).toBe(1)
    expect([...vector.values()][0]).toBeGreaterThan(0)
    expect(data.deckId).toBe('d1')
    expect(data.deadline).toBe(NOW + RENDER_WAIT_MS)
    expect(data.workBudgetMs).toBe(RENDER_WORK_BASE_MS + RENDER_WORK_PER_SLIDE_MS)
    expect(opts).toEqual({ priority: 1 })
    expect(data.uploads).toHaveLength(1)
    expect(data.uploads[0]!.slideId).toBe('s2')
    expect(data.uploads[0]!.url).toMatch(
      /^https:\/\/storage\.test\/put\/decks\/d1\/exports\/[\w-]{16}\/slide-2\.png\?type=image\/png/,
    )
    // The headers the URL signs travel with it, for the worker to send.
    expect(data.uploads[0]!.headers).toEqual({
      'content-type': 'image/png',
      'cache-control': 'private, no-store',
    })
    expect(data.token).toMatch(/^nrr_/)
    // The token goes on for the render session (the worker keeps its page).
    expect(resolveRenderToken(data.token)).not.toBeNull()
    expect(out).toMatchObject({
      delivery: 'url',
      slides: [{ slideId: 's2', index: 0, width: 1920, height: 1080 }],
      failedFonts: [],
    })
    if (out.delivery === 'url') {
      expect(out.slides[0]!.url).toContain(
        data.uploads[0]!.url.split('?')[0]!.replace('/put/', '/get/'),
      )
    }
  })

  it('keeps every wait under Cloudflare’s 100 s, a one-slide job behind the largest included', () => {
    expect(RENDER_WAIT_MS).toBeLessThan(100_000)
    const work = (slides: number) => RENDER_WORK_BASE_MS + RENDER_WORK_PER_SLIDE_MS * slides
    expect(work(MAX_RENDER_SLIDES) + work(1)).toBeLessThanOrEqual(RENDER_WAIT_MS)
  })

  it('passes on the fonts the worker could not load', async () => {
    const { service } = setup(async (data) => ({ ...rendered(data), failedFonts: ['Proseware Pro'] }))
    expect((await ask(service)).failedFonts).toEqual(['Proseware Pro'])
  })

  it('ranks a job by the slides its caller has in flight: a light user goes ahead of a heavy one', async () => {
    const releases: Array<() => void> = []
    const { queue, service } = setup(
      (data) => new Promise((resolve) => releases.push(() => resolve(rendered(data)))),
    )
    const queued = async (n: number) => {
      for (let i = 0; i < 200 && releases.length < n; i++)
        await new Promise((r) => setTimeout(r, 5))
      expect(releases).toHaveLength(n)
    }
    // u1 asks for all three slides twice; u2 for one.
    const heavy = [ask(service), ask(service)]
    await queued(2)
    const light = ask(service, { userId: 'u2', slides: [{ index: 0 }] })
    await queued(3)
    expect(queue.run.mock.calls.map(([, opts]) => opts.priority)).toEqual([3, 6, 1])
    for (const release of releases.splice(0)) release()
    await Promise.all([...heavy, light])
    // Finished renders no longer weigh on the next one.
    const again = ask(service, { slides: [{ index: 0 }] })
    await queued(1)
    expect(queue.run.mock.calls.at(-1)![1].priority).toBe(1)
    releases.splice(0)[0]!()
    await again
  })

  it('returns the images inline with delivery "base64"', async () => {
    const { service } = setup(async (data) => rendered(data))
    const out = await ask(service, { delivery: 'base64' })
    expect(out.delivery).toBe('base64')
    if (out.delivery === 'base64') {
      expect(out.slides).toHaveLength(3)
      expect(Buffer.from(out.slides[0]!.base64, 'base64').subarray(1, 4).toString()).toBe('PNG')
    }
  })

  it('refuses someone who cannot read the deck, before anything renders (403)', async () => {
    vi.mocked(resolveDeckAccess).mockResolvedValue(null)
    const { queue, service } = setup(async (data) => rendered(data))
    expect(await status(ask(service, { userId: 'x' }))).toBe(403)
    expect(queue.run).not.toHaveBeenCalled()
  })

  it('refuses an empty deck (400) and too many slides (413)', async () => {
    const { service } = setup(async (data) => rendered(data))
    vi.mocked(readDocCopy).mockImplementation(async () => deckDoc([]))
    expect(await status(ask(service))).toBe(400)
    vi.mocked(readDocCopy).mockImplementation(async () =>
      deckDoc(Array.from({ length: MAX_RENDER_SLIDES + 1 }, (_, i) => `s${i}`)),
    )
    expect(await status(ask(service))).toBe(413)
  })

  it(`lets one person have ${MAX_IN_FLIGHT_PER_USER} renders in flight, not more (429)`, async () => {
    const releases: Array<() => void> = []
    const { service } = setup(
      (data) => new Promise((resolve) => releases.push(() => resolve(rendered(data)))),
    )
    /** Until `n` jobs have reached the queue. */
    const queued = async (n: number) => {
      for (let i = 0; i < 200 && releases.length < n; i++)
        await new Promise((r) => setTimeout(r, 5))
      expect(releases).toHaveLength(n)
    }
    const running = Array.from({ length: MAX_IN_FLIGHT_PER_USER }, () => ask(service))
    await queued(MAX_IN_FLIGHT_PER_USER)
    expect(await status(ask(service))).toBe(429)
    // Someone else is not held back by it.
    const other = ask(service, { userId: 'u2' })
    await queued(MAX_IN_FLIGHT_PER_USER + 1)
    for (const release of releases.splice(0)) release()
    await Promise.all([...running, other])
    // Done, so the person may render again.
    const again = ask(service)
    await queued(1)
    releases.splice(0)[0]!()
    expect(await status(again)).toBe(200)
  })

  it('refuses new renders while the queue is full, and when it cannot be reached (503)', async () => {
    expect(
      await status(
        ask(
          setup(
            async (d) => rendered(d),
            async () => MAX_WAITING_JOBS,
          ).service,
        ),
      ),
    ).toBe(503)
    expect(
      await status(
        ask(
          setup(
            async (d) => rendered(d),
            async () => {
              throw new Error('ECONNREFUSED')
            },
          ).service,
        ),
      ),
    ).toBe(503)
  })

  it("maps the worker's failures, and ends the token whatever happened", async () => {
    const tokens: string[] = []
    const failing = (err: Error) =>
      setup(async (data) => {
        tokens.push(data.token)
        throw err
      }).service
    expect(await status(ask(failing(new Error('render failed (slide-not-found): slide s2'))))).toBe(
      404,
    )
    expect(await status(ask(failing(new Error('render failed (browser): net::ERR_FAILED'))))).toBe(
      503,
    )
    expect(await status(ask(failing(new Error('render failed (deadline): too slow'))))).toBe(504)
    expect(await status(ask(failing(new Error('render failed (late): nobody waits'))))).toBe(504)
    expect(await status(ask(failing(new RenderTimeoutError())))).toBe(504)
    expect(await status(ask(failing(new RenderUnavailableError('redis down'))))).toBe(503)
    // A failure of the renderer's own does not end the session.
    for (const token of tokens) expect(resolveRenderToken(token)).not.toBeNull()
  })

  it('answers a refused page with 403 only when the caller really lost access', async () => {
    const refused = () =>
      setup(async () => {
        throw new Error('render failed (access-refused): slide s1')
      }).service
    // Still a reader: the renderer had a token problem, not the caller.
    expect(await status(ask(refused()))).toBe(503)
    // Access went during the job.
    vi.mocked(resolveDeckAccess)
      .mockResolvedValueOnce({ role: 'viewer', reason: 'direct' })
      .mockResolvedValueOnce(null)
    expect(await status(ask(refused()))).toBe(403)
  })

  it('refuses inline images over the 8 MB limit (413)', async () => {
    const { service } = setup(async (data) => ({
      ...rendered(data),
      slides: rendered(data).slides.map((s) => ({ ...s, sizeBytes: 3 * 1024 * 1024 })),
    }))
    expect(await status(ask(service, { delivery: 'base64' }))).toBe(413)
  })
})

describe('render sessions', () => {
  it('reuses one token per person and deck while the session lasts, so the worker keeps its page', async () => {
    const { queue, service } = setup(async (data) => rendered(data))
    await ask(service)
    await ask(service)
    await ask(service, { userId: 'u2' })
    await ask(service, { deckId: 'd2' })
    const [a, b, other, otherDeck] = queue.run.mock.calls.map(([job]) => job.token)
    expect(b).toBe(a)
    expect(other).not.toBe(a)
    expect(otherDeck).not.toBe(a)
  })

  it('ends the session when its person lost access, and starts a new one after', async () => {
    const results: Array<() => Promise<RenderJobResult>> = [
      async () => {
        throw new Error('render failed (access-refused): slide s1')
      },
    ]
    const { queue, service } = setup((data) => (results.shift() ?? (async () => rendered(data)))())
    vi.mocked(resolveDeckAccess)
      .mockResolvedValueOnce({ role: 'viewer', reason: 'direct' })
      .mockResolvedValueOnce(null)
    expect(await status(ask(service))).toBe(403)
    const ended = queue.run.mock.calls[0]![0].token
    expect(resolveRenderToken(ended)).toBeNull()
    await ask(service)
    expect(queue.run.mock.calls[1]![0].token).not.toBe(ended)
  })

  it('starts a new session past SESSION_MAX_MS', async () => {
    let clock = NOW
    const queue = {
      run: vi.fn(async (data: RenderJobData) => rendered(data)),
      waiting: vi.fn(async () => 0),
    }
    const service = createRenderService({
      db: {} as ServiceDeps['db'],
      log,
      renderQueue: queue,
      now: () => clock,
    })
    await ask(service as ReturnType<typeof setup>['service'])
    clock += SESSION_MAX_MS - RENDER_WAIT_MS
    await ask(service as ReturnType<typeof setup>['service'])
    const [first, second] = queue.run.mock.calls.map(([job]) => job.token)
    expect(second).not.toBe(first)
  })
})

describe('RenderService.look', () => {
  const view = (service: ReturnType<typeof setup>['service'], v: RenderView) =>
    service.look({ userId: 'u1', deckId: 'd1', view: v })

  it('asks the worker for one slide, a region of it, or a sheet, and hands back the picture', async () => {
    const { queue, service } = setup(async (data) => looked(data))
    const one = await view(service, { slide: { index: 1 } })
    await view(service, { slide: { id: 's3' }, region: { x: 0, y: 900, width: 1920, height: 180 } })
    await view(service, { sheet: 'all' })
    const specs = queue.run.mock.calls.map(([job]) => (job.kind === 'look' ? job.look : null))
    expect(specs).toEqual([
      { mode: 'slide', slideId: 's2' },
      { mode: 'region', slideId: 's3', region: { x: 0, y: 900, width: 1920, height: 180 } },
      { mode: 'sheet', slideIds: ['s1', 's2', 's3'] },
    ])
    // A sheet weighs as many slides as it shows.
    expect(queue.run.mock.calls.map(([, opts]) => opts.priority)).toEqual([1, 1, 3])
    const job = queue.run.mock.calls[0]![0]
    expect(job.kind === 'look' && job.upload.url).toMatch(/\/exports\/[\w-]{16}\/look\.png\?/)
    expect(one).toMatchObject({
      mode: 'slide',
      width: 1430,
      height: 804,
      slides: [{ slideId: 's2', index: 0, failedLoads: 0 }],
      image: { mimeType: 'image/png' },
    })
    expect(Buffer.from(one.image.base64, 'base64').subarray(1, 4).toString()).toBe('PNG')
  })

  it('does not pass on what the worker stored unless it is a PNG of a sane size (503)', async () => {
    const { service } = setup(async (data) => looked(data))
    const stored = (body: Uint8Array, length = body.byteLength) =>
      ({
        send: vi.fn(async () => ({
          ContentLength: length,
          Body: { transformToByteArray: async () => body },
        })),
      }) as unknown as ReturnType<typeof buildS3Client>
    vi.mocked(buildS3Client).mockReturnValueOnce(stored(new TextEncoder().encode('<html>')))
    expect(await status(view(service, { slide: { index: 0 } }))).toBe(503)
    vi.mocked(buildS3Client).mockReturnValueOnce(stored(new Uint8Array(8), 50_000_000))
    expect(await status(view(service, { slide: { index: 0 } }))).toBe(503)
  })

  it('refuses a missing slide (404) and a sheet over the limit (413) before anything renders', async () => {
    const { queue, service } = setup(async (data) => looked(data))
    expect(await status(view(service, { slide: { id: 'zz' } }))).toBe(404)
    vi.mocked(readDocCopy).mockImplementation(async () =>
      deckDoc(Array.from({ length: MAX_RENDER_SLIDES + 1 }, (_, i) => `s${i}`)),
    )
    expect(await status(view(service, { sheet: 'all' }))).toBe(413)
    expect(queue.run).not.toHaveBeenCalled()
  })
})

describe('deck card pictures', () => {
  const card = { thumbnailKey: 'decks/d1/thumb-abc.png' } as DeckRow

  /** Copies of one live document, as readDocCopy hands them out; `edit` changes it. */
  function liveDoc(ids: string[]) {
    const doc = deckDoc(ids)
    vi.mocked(readDocCopy).mockImplementation(async () => {
      const copy = new Y.Doc()
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc))
      return copy
    })
    return doc
  }

  beforeEach(() => {
    clearCardStateForTests()
    vi.mocked(storeDeckThumbnail).mockReset()
    vi.mocked(storeDeckThumbnail).mockResolvedValue(card)
  })

  it('draws the first slide as a thumbnail look, checks it and stores it as the card (editors)', async () => {
    vi.mocked(resolveDeckAccess).mockResolvedValue({ role: 'editor', reason: 'direct' })
    const { queue, service } = setup(async (data) => looked(data))
    const result = await service.refreshThumbnail({ userId: 'u1', deckId: 'd1' })
    const job = queue.run.mock.calls[0]![0]
    expect(job.kind === 'look' && job.look).toEqual({ mode: 'thumbnail', slideId: 's1' })
    expect(job.kind === 'look' && job.upload.url).toMatch(/\/exports\/[\w-]{16}\/thumb\.png\?/)
    // A person's job keeps its page warm; it is in their own render lane.
    expect(job.keepPage).toBeUndefined()
    expect(resolveRenderToken(job.token)?.lane).toBe('person')
    expect(vi.mocked(storeDeckThumbnail).mock.calls[0]!.slice(1)).toEqual([
      'd1',
      { bytes: expect.any(Uint8Array), mime: 'image/png' },
    ])
    expect(result).toEqual({
      thumbnailUrl: 'https://img.test/decks/d1/thumb-abc.png?v=1',
      updatedAt: '2026-10-11T18:00:00.000Z',
    })
  })

  it('lets only editors redraw the card (403), refuses a deck without slides (400) and says when the deck went away (404)', async () => {
    const { queue, service } = setup(async (data) => looked(data))
    expect(await status(service.refreshThumbnail({ userId: 'u1', deckId: 'd1' }))).toBe(403)
    vi.mocked(resolveDeckAccess).mockResolvedValue({ role: 'owner', reason: 'direct' })
    vi.mocked(readDocCopy).mockImplementation(async () => deckDoc([]))
    expect(await status(service.refreshThumbnail({ userId: 'u1', deckId: 'd1' }))).toBe(400)
    expect(queue.run).not.toHaveBeenCalled()
    vi.mocked(readDocCopy).mockImplementation(async () => deckDoc(['s1']))
    vi.mocked(storeDeckThumbnail).mockResolvedValue(null)
    expect(await status(service.refreshThumbnail({ userId: 'u1', deckId: 'd1' }))).toBe(404)
  })

  it('draws a background card behind everyone, in a lane of its own, outside the owner’s share', async () => {
    const holds: Array<() => void> = []
    const { queue, service } = setup(async (data) => {
      if (data.kind === 'export') await new Promise<void>((r) => holds.push(r))
      return data.kind === 'export' ? rendered(data) : looked(data)
    })
    // The owner's own renders fill their share…
    const busy = Array.from({ length: MAX_IN_FLIGHT_PER_USER }, () => ask(service))
    await vi.waitFor(() => expect(queue.run).toHaveBeenCalledTimes(MAX_IN_FLIGHT_PER_USER))
    // …and the card is drawn all the same, last in line, on a page not kept
    // warm, with a token of the background lane (its own session and budget).
    expect(await service.backgroundThumbnail({ userId: 'u1', deckId: 'd1' })).toEqual({
      status: 'stored',
    })
    const [job, opts] = queue.run.mock.calls.at(-1)!
    expect(opts).toEqual({ priority: BACKGROUND_PRIORITY })
    expect(job.keepPage).toBe(false)
    expect(resolveRenderToken(job.token)).toMatchObject({ requestedBy: 'u1', lane: 'background' })
    expect(job.token).not.toBe(queue.run.mock.calls[0]![0].token)
    for (const release of holds) release()
    await Promise.all(busy)
  })

  it('draws a background card again only when the first slide changed — a deletion included', async () => {
    const { queue, service } = setup(async (data) => looked(data))
    const doc = liveDoc(['s1', 's2'])
    const background = () => service.backgroundThumbnail({ userId: 'u1', deckId: 'd1' })
    expect(await background()).toEqual({ status: 'stored' })
    expect(await background()).toEqual({ status: 'unchanged' })
    // Slide 2 changes: the card does not.
    doc.getArray<Y.Map<unknown>>('slides').get(1).set('name', 'Second')
    expect(await background()).toEqual({ status: 'unchanged' })
    // An object on slide 1 is deleted: a deletion, which leaves the state
    // vector as it was — the card is drawn again.
    const objects = doc.getArray<Y.Map<unknown>>('slides').get(0).get('objects') as Y.Array<unknown>
    const block = new Y.Map<unknown>()
    block.set('id', 'block')
    block.set('type', 'rectangle')
    objects.push([block])
    expect(await background()).toEqual({ status: 'stored' })
    const before = Y.encodeStateVector(doc)
    objects.delete(0, 1)
    expect(Y.encodeStateVector(doc)).toEqual(before)
    expect(await background()).toEqual({ status: 'stored' })
    expect(queue.run).toHaveBeenCalledTimes(3)
  })

  it('counts a card the agent redrew as drawn', async () => {
    vi.mocked(resolveDeckAccess).mockResolvedValue({ role: 'editor', reason: 'direct' })
    const { queue, service } = setup(async (data) => looked(data))
    liveDoc(['s1'])
    await service.refreshThumbnail({ userId: 'u1', deckId: 'd1' })
    expect(await service.backgroundThumbnail({ userId: 'owner', deckId: 'd1' })).toEqual({
      status: 'unchanged',
    })
    expect(queue.run).toHaveBeenCalledTimes(1)
  })

  it('does not store a background card someone opened the deck for meanwhile, nor one for a deck without slides', async () => {
    const { queue, service } = setup(async (data) => looked(data))
    liveDoc(['s1'])
    expect(
      await service.backgroundThumbnail({ userId: 'u1', deckId: 'd1', stillWanted: () => false }),
    ).toEqual({ status: 'superseded' })
    expect(storeDeckThumbnail).not.toHaveBeenCalled()
    // Not stored, so not drawn: the next try draws it.
    expect(await service.backgroundThumbnail({ userId: 'u1', deckId: 'd1' })).toEqual({
      status: 'stored',
    })
    vi.mocked(readDocCopy).mockImplementation(async () => deckDoc([]))
    expect(await service.backgroundThumbnail({ userId: 'u1', deckId: 'd1' })).toEqual({
      status: 'no-slides',
    })
    expect(queue.run).toHaveBeenCalledTimes(2)
  })

  it('tells a busy renderer from a job that failed on its page', async () => {
    const full = setup(
      async (data) => looked(data),
      async () => MAX_WAITING_JOBS,
    )
    await expect(
      full.service.backgroundThumbnail({ userId: 'u1', deckId: 'd1' }),
    ).rejects.toBeInstanceOf(RendererBusyError)
    const late = setup(async () => {
      throw new Error(renderFailureMessage('late', 'nobody waits'))
    })
    await expect(
      late.service.backgroundThumbnail({ userId: 'u1', deckId: 'd1' }),
    ).rejects.toBeInstanceOf(RendererBusyError)
    const queued = setup(async () => {
      throw new RenderTimeoutError(false)
    })
    await expect(queued.service.backgroundThumbnail({ userId: 'u1', deckId: 'd1' })).rejects.toBeInstanceOf(
      RendererBusyError,
    )
    // Started and not finished in time: the slide itself is slow — not busy.
    const slow = setup(async () => {
      throw new RenderTimeoutError(true)
    })
    const slowErr = await slow.service
      .backgroundThumbnail({ userId: 'u1', deckId: 'd1' })
      .catch((e: unknown) => e)
    expect(slowErr).toBeInstanceOf(ServiceError)
    expect(slowErr).not.toBeInstanceOf(RendererBusyError)
    const crashed = setup(async () => {
      throw new Error(renderFailureMessage('browser', 'the page crashed'))
    })
    const err = await crashed.service
      .backgroundThumbnail({ userId: 'u1', deckId: 'd1' })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ServiceError)
    expect(err).not.toBeInstanceOf(RendererBusyError)
  })
})
