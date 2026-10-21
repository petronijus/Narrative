/**
 * perf/render.ts — the render worker's latency, measured end to end
 * (docs/plans/performance.md, R1 / G7).
 *
 * Drives a running stack through its command API (BYPASS_AUTH: two synthetic
 * people, `narrative_dev_as`), watches the `render` queue on the media Redis
 * for when each job was added, started and finished, and reports p50/p95 of:
 *
 *   - cold browser   the first job after the worker started (or its Chromium
 *                    quit after RENDER_IDLE_MS): browser start + page load;
 *   - cold page      a one-slide PNG of a deck the worker has not rendered
 *                    before (a new render session: a new token, no warm page
 *                    of its own);
 *   - warm page      the next one-slide PNGs of that deck (the session's
 *                    page, slides switched in place);
 *   - PDF            a `PERF_PDF_SLIDES`-slide PDF through the job API
 *                    (`POST /decks/:id/export.pdf` → 202 and a job id, then
 *                    `GET /decks/:id/export.pdf/:jobId?waitMs=` until it is
 *                    done): how long the request took to be accepted, the
 *                    first page, the whole file (wall time from the POST to
 *                    the `done` answer, link included), pages per second, and
 *                    the peak resident memory of the render worker and the
 *                    server while it ran (perf/rss.ts);
 *   - PNG behind PDF one person's one-slide PNG asked for while another
 *                    person's PDF is rendering: its queue wait (added →
 *                    started) is what R1's concurrency is about; that PDF's
 *                    own times come with it.
 *
 * Every deck is seeded through the API and deleted afterwards. Slides carry a
 * full-bleed photo of noise (incompressible, like A3's reference deck), a
 * title and two shapes. After seeding the driver waits until the queue has
 * been quiet for a while: the server draws background card pictures of
 * decks that were just stored, and those must not land inside a measurement.
 *
 * Run (the stack must be up, its render worker included):
 *
 *   node --import tsx apps/render-worker/perf/render.ts
 *
 *   PERF_API          the API origin (default http://localhost:3001)
 *   PERF_ORIGIN       the Origin the API admits (default http://localhost:5173)
 *   MEDIA_REDIS_URL   the media Redis the stack's queue is on
 *                     (default redis://127.0.0.1:6380)
 *   PERF_RUNS         samples per scenario (default 5)
 *   PERF_PDF_SLIDES   slides of the PDF (default 30)
 *   PERF_PDF_RUNS     PDFs per PDF scenario (default 3)
 *   PERF_SCENARIOS    which to run, of `png` (first job, cold and warm
 *                     page), `pdf` (a PDF alone) and `behind` (a PDF with a
 *                     PNG behind it); default all three
 *   PERF_RSS          what to sample: `name=pid` (a process tree) or
 *                     `name=container:<name>` (`docker stats`), comma-separated;
 *                     `off`; default the dev stack's render worker and server
 *   PERF_JSON         write the results there as JSON too
 *
 * Numbers mean nothing without the machine, the build (dev server or the
 * production bundle) and the worker's settings beside them: the driver
 * prints what it can see of those and leaves the rest to the log entry.
 */

import { writeFileSync } from 'node:fs'
import { deflateSync, crc32 } from 'node:zlib'
import { randomBytes } from 'node:crypto'
import bullmq from 'bullmq'
import IORedisModule from 'ioredis'
import { quantile, summarize } from '@narrative/perf/stats'
import { RENDER_QUEUE, type RenderJobData } from '@narrative/shared'
import { mib, rssTargetsFromEnv, sampleRss, type RssTarget } from './rss.js'

const { Queue, QueueEvents } = bullmq
const IORedis =
  (IORedisModule as unknown as { default?: typeof IORedisModule }).default ?? IORedisModule

const API = process.env['PERF_API'] ?? 'http://localhost:3001'
const ORIGIN = process.env['PERF_ORIGIN'] ?? 'http://localhost:5173'
const REDIS_URL = process.env['MEDIA_REDIS_URL'] ?? 'redis://127.0.0.1:6380'
const RUNS = Number(process.env['PERF_RUNS'] ?? 5)
const PDF_SLIDES = Number(process.env['PERF_PDF_SLIDES'] ?? 30)
const PDF_RUNS = Number(process.env['PERF_PDF_RUNS'] ?? 3)
const SCENARIOS = new Set(
  (process.env['PERF_SCENARIOS'] ?? 'png,pdf,behind').split(',').map((s) => s.trim()),
)
/** How long one status read may wait for the job to end (the route caps it at 25 s). */
const PDF_POLL_WAIT_MS = 2_000
/** How long the queue must be quiet before a measurement starts. */
const QUIET_MS = 15_000

// ── stats ──────────────────────────────────────────────────────────────────

interface Summary {
  n: number
  p50: number
  p95: number
  min: number
  max: number
}

/** `@narrative/perf`'s summary (R type 7 quantiles) with the p95 the report prints; NaN for none. */
function summary(values: readonly number[]): Summary {
  if (values.length === 0) return { n: 0, p50: NaN, p95: NaN, min: NaN, max: NaN }
  const s = summarize(values)
  return { n: s.n, p50: s.median, p95: quantile(values, 0.95), min: s.min, max: s.max }
}

// ── a photo of noise ───────────────────────────────────────────────────────

/** An RGB PNG of random pixels: nothing compresses it, as with a real photo. */
function noisePng(width: number, height: number): Buffer {
  const row = width * 3 + 1
  const raw = Buffer.alloc(row * height)
  const noise = randomBytes(width * 3 * height)
  for (let y = 0; y < height; y++) {
    raw[y * row] = 0
    noise.copy(raw, y * row + 1, y * width * 3, (y + 1) * width * 3)
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.byteLength, 0)
    head.write(type, 4, 'latin1')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0)
    return Buffer.concat([head, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 1 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ── the API ────────────────────────────────────────────────────────────────

const PEOPLE = { a: 'dev-perf-render-a', b: 'dev-perf-render-b' } as const
type Person = keyof typeof PEOPLE

async function api<T>(person: Person, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Origin: ORIGIN,
      Cookie: `narrative_dev_as=${PEOPLE[person]}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 300)}`)
  return (text === '' ? undefined : JSON.parse(text)) as T
}

async function command<T>(person: Person, deckId: string, id: string, input: unknown): Promise<T> {
  const body = await api<{ ok: boolean; result: T; error?: { message: string } }>(
    person,
    'POST',
    '/commands',
    { target: { deckId }, command: id, input },
  )
  if (!body.ok) throw new Error(`${id}: ${body.error?.message}`)
  return body.result
}

/** A deck of `slides` slides, each a full-bleed photo, a title and two shapes. */
async function seedDeck(person: Person, title: string, slides: number): Promise<string> {
  const { id: deckId } = await api<{ id: string }>(person, 'POST', '/decks', { title })
  const photos: string[] = []
  for (let i = 0; i < Math.min(3, slides); i++) {
    const { assetId } = await command<{ assetId: string }>(person, deckId, 'media.upload', {
      file: { base64: noisePng(1200, 800).toString('base64'), filename: `photo-${i}.png` },
    })
    photos.push(assetId)
  }
  for (let s = 0; s < slides; s++) {
    if (s > 0) await command(person, deckId, 'slide.add', {})
    const slide = { index: s }
    await command(person, deckId, 'object.create', {
      slide,
      object: {
        type: 'image',
        assetId: photos[s % photos.length],
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
      },
    })
    await command(person, deckId, 'object.create', {
      slide,
      object: { type: 'rectangle', x: 120, y: 760, width: 1680, height: 220, fill: '#101820' },
    })
    await command(person, deckId, 'object.create', {
      slide,
      object: { type: 'ellipse', x: 1600, y: 80, width: 200, height: 200, fill: '#E53935' },
    })
    await command(person, deckId, 'object.create', {
      slide,
      object: {
        type: 'text',
        x: 160,
        y: 790,
        width: 1600,
        height: 160,
        text: `${title}, slide ${s + 1}`,
        fontSize: 72,
        color: '#FFFFFF',
      },
    })
  }
  return deckId
}

// ── the queue, watched ─────────────────────────────────────────────────────

interface JobTimes {
  deckId: string | null
  kind: string
  slides: number
  added: number
  active?: number
  done?: number
  failed?: string
}

const jobs = new Map<string, JobTimes>()
const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null })
const queue = new Queue<RenderJobData>(RENDER_QUEUE, { connection })
const eventsConnection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null })
const events = new QueueEvents(RENDER_QUEUE, { connection: eventsConnection })
let lastEvent = Date.now()

function note(jobId: string): JobTimes {
  let entry = jobs.get(jobId)
  if (entry === undefined) {
    entry = { deckId: null, kind: '?', slides: 0, added: Date.now() }
    jobs.set(jobId, entry)
    // The record is there until the server reads the result.
    void queue.getJob(jobId).then((job) => {
      if (job === undefined || entry === undefined) return
      const data = job.data
      entry.deckId = data.page.kind === 'deck' ? data.page.deckId : null
      entry.kind = data.kind === 'export' ? 'export' : `look:${data.look.mode}`
      entry.slides = data.kind === 'export' ? data.uploads.length : 1
    })
  }
  lastEvent = Date.now()
  return entry
}
events.on('added', ({ jobId }) => void note(jobId))
events.on('waiting', ({ jobId }) => void note(jobId))
events.on('active', ({ jobId }) => {
  note(jobId).active = Date.now()
})
events.on('completed', ({ jobId }) => {
  note(jobId).done = Date.now()
})
events.on('failed', ({ jobId, failedReason }) => {
  const entry = note(jobId)
  entry.done = Date.now()
  entry.failed = failedReason
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Until nothing has been added, started or finished for `QUIET_MS`, and nothing runs. */
async function untilQuiet(): Promise<void> {
  for (;;) {
    const busy = await queue.getJobCountByTypes('active', 'waiting', 'prioritized')
    if (busy === 0 && Date.now() - lastEvent >= QUIET_MS) return
    await sleep(500)
  }
}

/** The jobs of `deckId` added since `since`, oldest first. */
function jobsOf(deckId: string, since: number): JobTimes[] {
  return [...jobs.values()]
    .filter((j) => j.deckId === deckId && j.added >= since)
    .sort((a, b) => a.added - b.added)
}

async function untilJobStarted(deckId: string, since: number, timeoutMs: number): Promise<void> {
  const stop = Date.now() + timeoutMs
  while (Date.now() < stop) {
    if (jobsOf(deckId, since).some((j) => j.active !== undefined)) return
    await sleep(25)
  }
  throw new Error(`no job of ${deckId} started within ${timeoutMs} ms`)
}

/** A one-slide PNG of `deckId`: its wall time, and its job's wait and run times. */
async function onePng(
  person: Person,
  deckId: string,
  index: number,
): Promise<{ total: number; wait: number; run: number }> {
  const since = Date.now()
  await command(person, deckId, 'deck.exportPng', { slides: [{ index }] })
  const total = Date.now() - since
  // The completed event can trail the HTTP answer by a moment.
  for (let i = 0; i < 40; i++) {
    const job = jobsOf(deckId, since).at(-1)
    if (job?.active !== undefined && job.done !== undefined) {
      return { total, wait: job.active - job.added, run: job.done - job.active }
    }
    await sleep(25)
  }
  throw new Error(`the job of ${deckId} was not seen on the queue`)
}

/** What `GET /decks/:id/export.pdf/:jobId` answers (the fields used). */
interface PdfJobStatus {
  jobId: string
  status: 'queued' | 'running' | 'done' | 'failed'
  done: number
  total: number
  result?: { pages: number; sizeBytes: number; failedLoads: number; url?: string }
  error?: { code: string; status: number; message: string }
}

interface PdfRun {
  /** POST → its 202. */
  accepted: number
  /** POST → the first status read that saw a page done. */
  firstPage: number | null
  /** POST → the `done` answer (the link with it). */
  total: number
  pages: number
  sizeBytes: number
  failedLoads: number
  /** Peak resident memory per sampled target while the job ran. */
  peaks: Record<string, number | null>
}

/**
 * One PDF of `deckId` through the job API, polled until it ends; throws with
 * the job's reason when it fails. `onAccepted` runs once the 202 is in.
 */
async function pdfJob(
  person: Person,
  deckId: string,
  rss: () => Promise<RssTarget[]>,
  onAccepted?: () => void,
): Promise<PdfRun> {
  // Found again per run: a dev process restarted by its watcher has a new pid.
  const sampler = sampleRss(await rss())
  const since = Date.now()
  let peaks: Record<string, number | null> | null = null
  try {
    const started = await api<PdfJobStatus>(person, 'POST', `/decks/${deckId}/export.pdf`, {})
    const accepted = Date.now() - since
    onAccepted?.()
    let firstPage: number | null = null
    let status = started
    while (status.status === 'queued' || status.status === 'running') {
      status = await api<PdfJobStatus>(
        person,
        'GET',
        `/decks/${deckId}/export.pdf/${started.jobId}?waitMs=${PDF_POLL_WAIT_MS}`,
      )
      if (firstPage === null && status.done > 0) firstPage = Date.now() - since
    }
    const total = Date.now() - since
    peaks = await sampler.stop()
    if (status.status === 'failed' || status.result === undefined) {
      throw new Error(
        `the PDF job failed after ${total} ms: ${status.error?.code} ${status.error?.status} ${status.error?.message}`,
      )
    }
    return {
      accepted,
      firstPage,
      total,
      pages: status.result.pages,
      sizeBytes: status.result.sizeBytes,
      failedLoads: status.result.failedLoads,
      peaks,
    }
  } finally {
    if (peaks === null) await sampler.stop()
  }
}

/** A failure as one line of the report. */
const failureText = (since: number, err: unknown): string =>
  `after ${Date.now() - since} ms: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`

/** The PDF runs' summaries, under `label`. */
function reportPdf(
  results: Record<string, Summary | Record<string, unknown>>,
  label: string,
  runs: readonly PdfRun[],
  failures: readonly string[],
): void {
  if (runs.length > 0) {
    results[`${label}: accepted`] = summary(runs.map((r) => r.accepted))
    const first = runs.flatMap((r) => (r.firstPage === null ? [] : [r.firstPage]))
    if (first.length > 0) results[`${label}: first page`] = summary(first)
    results[`${label}: total`] = summary(runs.map((r) => r.total))
    results[`${label}: pages/min`] = summary(runs.map((r) => (r.pages * 60_000) / r.total))
    const names = Object.keys(runs[0]!.peaks)
    const peaks: Record<string, string> = {}
    for (const name of names) {
      const values = runs.flatMap((r) => (r.peaks[name] == null ? [] : [r.peaks[name]!]))
      peaks[name] = values.length === 0 ? 'n/a' : mib(Math.max(...values))
    }
    results[`${label}: peak RSS`] = peaks
    results[`${label}: file`] = {
      pages: runs.map((r) => r.pages),
      sizeMB: runs.map((r) => Math.round(r.sizeBytes / 1e5) / 10),
      failedLoads: runs.map((r) => r.failedLoads),
    }
  }
  results[`${label}: outcome`] = {
    finished: runs.length,
    failed: failures.length,
    ...(failures.length > 0 ? { failures } : {}),
  }
}

// ── the scenarios ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const health = await fetch(`${API}/health`).then((r) => r.status)
  console.log(`[perf] api=${API} (health ${health}) redis=${REDIS_URL} queue=${RENDER_QUEUE}`)
  const created: Array<{ person: Person; deckId: string }> = []
  const results: Record<string, Summary | Record<string, unknown>> = {}
  const rss = () => rssTargetsFromEnv(process.env['PERF_RSS'])
  console.log(
    `[perf] scenarios=${[...SCENARIOS].join(',')} rss=${
      (await rss()).map((t) => `${t.name}:${'pid' in t ? t.pid : t.container}`).join(',') || 'none'
    }`,
  )
  try {
    const png = SCENARIOS.has('png')
    const needsPdf = SCENARIOS.has('pdf') || SCENARIOS.has('behind')
    const smallDecks = png ? RUNS + 1 : SCENARIOS.has('behind') ? 1 : 0
    console.log(
      `[perf] seeding ${smallDecks} decks of 3 slides${needsPdf ? ` and one of ${PDF_SLIDES}` : ''}…`,
    )
    const small: string[] = []
    for (let i = 0; i < smallDecks; i++) {
      const deckId = await seedDeck('a', `perf render ${i}`, 3)
      created.push({ person: 'a', deckId })
      small.push(deckId)
    }
    let pdfDeck: string | null = null
    if (needsPdf) {
      pdfDeck = await seedDeck('b', 'perf render pdf', PDF_SLIDES)
      created.push({ person: 'b', deckId: pdfDeck })
    }
    console.log('[perf] waiting for the queue to be quiet (background card pictures)…')
    await untilQuiet()

    if (png) {
      // The first job: the worker may have to start Chromium. Only a real
      // cold start if the worker's browser had quit (RENDER_IDLE_MS) — the
      // driver says which it saw.
      const first = await onePng('a', small[0]!, 0)
      results['first job'] = { ...first }
      console.log(`[perf] first job: ${JSON.stringify(first)}`)

      const cold: Array<{ total: number; wait: number; run: number }> = []
      for (let i = 1; i <= RUNS; i++) cold.push(await onePng('a', small[i]!, 0))
      const warm: Array<{ total: number; wait: number; run: number }> = []
      for (let i = 0; i < RUNS; i++) warm.push(await onePng('a', small.at(-1)!, (i + 1) % 3))
      results['cold page: total'] = summary(cold.map((c) => c.total))
      results['cold page: job run'] = summary(cold.map((c) => c.run))
      results['warm page: total'] = summary(warm.map((c) => c.total))
      results['warm page: job run'] = summary(warm.map((c) => c.run))
    }

    if (SCENARIOS.has('pdf') && pdfDeck !== null) {
      // The PDF alone: nothing else in the queue.
      const runs: PdfRun[] = []
      const failures: string[] = []
      for (let i = 0; i < PDF_RUNS; i++) {
        await untilQuiet()
        const since = Date.now()
        try {
          const run = await pdfJob('b', pdfDeck, rss)
          runs.push(run)
          console.log(`[perf] PDF ${i + 1}/${PDF_RUNS}: ${JSON.stringify(run)}`)
        } catch (err) {
          failures.push(failureText(since, err))
          console.log(`[perf] PDF ${i + 1}/${PDF_RUNS} failed: ${failures.at(-1)}`)
        }
      }
      reportPdf(results, `PDF of ${PDF_SLIDES}`, runs, failures)
    }

    if (SCENARIOS.has('behind') && pdfDeck !== null) {
      // A PNG behind a PDF: person B's PDF starts, then person A asks for one
      // slide of a deck whose page is warm.
      const behind: Array<{ total: number; wait: number; run: number }> = []
      const behindFailures: string[] = []
      const runs: PdfRun[] = []
      const pdfFailures: string[] = []
      for (let i = 0; i < PDF_RUNS; i++) {
        await untilQuiet()
        const since = Date.now()
        const pdf = pdfJob('b', pdfDeck, rss).then(
          (run) => void runs.push(run),
          (err: unknown) => void pdfFailures.push(failureText(since, err)),
        )
        await untilJobStarted(pdfDeck, since, 60_000)
        // Well inside the PDF's first render job.
        await sleep(1_500)
        const pngSince = Date.now()
        try {
          behind.push(await onePng('a', small.at(-1)!, i % 3))
        } catch (err) {
          behindFailures.push(failureText(pngSince, err))
        }
        await pdf
      }
      if (behind.length > 0) {
        results['PNG behind PDF: queue wait'] = summary(behind.map((b) => b.wait))
        results['PNG behind PDF: total'] = summary(behind.map((b) => b.total))
      }
      results['PNG behind PDF: outcome'] = {
        finished: behind.length,
        failed: behindFailures.length,
        ...(behindFailures.length > 0 ? { failures: behindFailures } : {}),
      }
      reportPdf(results, `PDF of ${PDF_SLIDES} with a PNG`, runs, pdfFailures)
    }
  } finally {
    for (const { person, deckId } of created) {
      await api(person, 'DELETE', `/decks/${deckId}`).catch(() => undefined)
    }
    await events.close()
    await queue.close()
    await Promise.all([connection.quit(), eventsConnection.quit()])
  }

  console.log('\n[perf] results (ms unless named)')
  for (const [name, value] of Object.entries(results)) {
    if ('p50' in value) {
      const s = value as Summary
      console.log(
        `  ${name.padEnd(36)} n=${s.n} p50=${Math.round(s.p50)} p95=${Math.round(s.p95)} min=${Math.round(s.min)} max=${Math.round(s.max)}`,
      )
    } else console.log(`  ${name.padEnd(36)} ${JSON.stringify(value)}`)
  }
  const out = process.env['PERF_JSON']
  if (out)
    writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), api: API, results }, null, 2))
}

main().then(
  // BullMQ's blocking reads can hold the loop open a while after close.
  () => process.exit(0),
  (err: unknown) => {
    console.error(err)
    process.exit(1)
  },
)
