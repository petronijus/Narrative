/**
 * apps/render-worker — renders slides of live decks to PNG on the real web
 * app, in headless Chromium (agentic A3, docs/plans/a3-render-worker.md).
 *
 * Consumes the BullMQ queue `render` (RENDER_QUEUE, @narrative/shared) on the
 * media Redis, RENDER_CONCURRENCY jobs at a time (default 2): one person's
 * single slide no longer waits behind another's 20-slide export. The VM has
 * little memory to spare, so a second job opens its page only while the
 * container has room for it (memory.ts); a job renders its slides one after
 * another in one page. The server enqueues a job with its render session's
 * token and waits for its result (apps/server/src/services/render.ts).
 */

// bullmq and ioredis are CJS without an exports map; see apps/video-worker/src/index.ts.
import bullmq from 'bullmq'
import IORedisModule from 'ioredis'
import {
  RENDER_QUEUE,
  renderPageName,
  type RenderJobData,
  type RenderJobResult,
} from '@narrative/shared'
import { readConfig } from './config.js'
import { BrowserHolder } from './browser.js'
import { WarmPages } from './warmPages.js'
import { cgroupAvailableBytes, MemoryGate } from './memory.js'
import { left, maskTokens, refuseLate, renderJob, RenderJobError } from './render.js'

const { Worker } = bullmq
const IORedis =
  (IORedisModule as unknown as { default?: typeof IORedisModule }).default ?? IORedisModule

const log = (message: string): void => console.log(`[render-worker] ${message}`)

const config = readConfig()
const holder = new BrowserHolder({
  idleMs: config.idleMs,
  chromeExecutable: config.chromeExecutable,
  requireSandbox: config.requireSandbox,
  log,
})
/** Pages kept between jobs (they go with the browser). */
const warm = new WarmPages({ max: config.warmPages, idleMs: config.idleMs, log })
/** A job beside another opens its page only with memory for it. */
const gate = new MemoryGate({
  reserveBytes: config.pageReserveBytes,
  available: () => cgroupAvailableBytes(),
  evictIdle: () => warm.evictOldest('memory for a job'),
  log,
})

/**
 * Run one job; after a browser-side fault the next job gets a fresh Chromium
 * (the faulty one closes once the other jobs in it are done). A job nobody
 * waits for is dropped before it can start (or wait for) one.
 */
async function processJob(data: RenderJobData): Promise<RenderJobResult> {
  refuseLate(data)
  try {
    return await holder.use((browser) => renderJob(browser, data, { config, log, warm, gate }), {
      launchTimeoutMs: left(data.deadline),
    })
  } catch (err) {
    if (!(err instanceof RenderJobError) || err.browserSuspect) {
      warm.closeAll('failed job')
      holder.retire('failed job')
    }
    throw err
  }
}

// maxRetriesPerRequest: null is required by BullMQ — it manages retries itself.
const connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null })

const worker = new Worker<RenderJobData, RenderJobResult>(
  RENDER_QUEUE,
  (job) => processJob(job.data),
  {
    connection,
    concurrency: config.concurrency,
    // A job whose worker died (OOM, restart) is not run again: its caller has
    // stopped waiting, and its token and upload URLs are expiring.
    maxStalledCount: 0,
    // A result is read once by the waiting server; keep a short tail for
    // inspection. The data holds a render token, which is dead minutes later.
    removeOnComplete: { age: 600, count: 50 },
    removeOnFail: { age: 3600, count: 100 },
  },
)

worker.on('ready', () => {
  const via = config.upstream !== null ? ` via ${config.upstream}` : ''
  const sandbox = config.requireSandbox ? ' sandbox=required' : ''
  const memory = cgroupAvailableBytes()
  const limits =
    ` concurrency=${config.concurrency} warm=${config.warmPages}` +
    (memory !== null ? ` free=${Math.round(memory / 1048576)}MB` : ' (no memory limit seen)')
  log(`ready — queue="${RENDER_QUEUE}" app=${config.appOrigin}${via}${sandbox}${limits}`)
})
worker.on('active', (job) => {
  const what =
    job.data.kind === 'export'
      ? `export of ${job.data.uploads.length} slide(s)`
      : `look (${job.data.look.mode})`
  log(`job=${job.id} ${renderPageName(job.data.page)} ${what} started`)
})
worker.on('completed', (job, result) => {
  const done = result.kind === 'export' ? `${result.slides.length} slide(s)` : 'look'
  log(`job=${job.id} ${renderPageName(job.data.page)} rendered ${done} (warm pages: ${warm.size})`)
})
worker.on('failed', (job, err) => {
  const page = job === undefined ? 'unknown' : renderPageName(job.data.page)
  log(`job=${job?.id} ${page} failed: ${maskTokens(err.message)}`)
})
worker.on('error', (err) => {
  log(`worker error: ${maskTokens(err.message)}`)
})

async function shutdown(signal: string): Promise<void> {
  log(`${signal} — closing`)
  await worker.close()
  warm.closeAll('shutdown')
  await holder.close('shutdown')
  await connection.quit()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
