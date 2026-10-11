/**
 * apps/render-worker — renders slides of live decks to PNG on the real web
 * app, in headless Chromium (agentic A3, docs/plans/a3-render-worker.md).
 *
 * Consumes the BullMQ queue `render` (RENDER_QUEUE, @narrative/shared) on the
 * media Redis, one job at a time: the VM has little memory to spare, and a
 * job renders its slides one after another in one page anyway. The server
 * enqueues a job with a fresh render token and waits for its result
 * (apps/server/src/services/render.ts).
 */

// bullmq and ioredis are CJS without an exports map; see apps/video-worker/src/index.ts.
import bullmq from 'bullmq'
import IORedisModule from 'ioredis'
import { RENDER_QUEUE, type RenderJobData, type RenderJobResult } from '@narrative/shared'
import { readConfig } from './config.js'
import { BrowserHolder } from './browser.js'
import { WarmPages } from './warmPages.js'
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
/** Pages kept for render sessions (they go with the browser). */
const warm = new WarmPages({ max: config.warmPages, idleMs: config.idleMs, log })

/**
 * Run one job; after a browser-side fault the next job gets a fresh Chromium.
 * A job nobody waits for is dropped before it can start (or wait for) one.
 */
async function processJob(data: RenderJobData): Promise<RenderJobResult> {
  refuseLate(data)
  try {
    return await holder.use((browser) => renderJob(browser, data, { config, log, warm }), {
      launchTimeoutMs: left(data.deadline),
    })
  } catch (err) {
    if (!(err instanceof RenderJobError) || err.browserSuspect) {
      warm.closeAll('failed job')
      await holder.close('failed job')
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
    concurrency: 1,
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
  log(`ready — queue="${RENDER_QUEUE}" app=${config.appOrigin}${via}${sandbox}`)
})
worker.on('active', (job) => {
  const what =
    job.data.kind === 'export'
      ? `export of ${job.data.uploads.length} slide(s)`
      : `look (${job.data.look.mode})`
  log(`job=${job.id} deck=${job.data.deckId} ${what} started`)
})
worker.on('completed', (job, result) => {
  const done = result.kind === 'export' ? `${result.slides.length} slide(s)` : 'look'
  log(`job=${job.id} deck=${job.data.deckId} rendered ${done} (warm pages: ${warm.size})`)
})
worker.on('failed', (job, err) => {
  log(`job=${job?.id} deck=${job?.data.deckId} failed: ${maskTokens(err.message)}`)
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
