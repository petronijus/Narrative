// bullmq is published as CJS without an `exports` map. Node 25's stricter ESM
// named-import resolution refuses to extract `Worker` from the CJS module-namespace,
// so we default-import the whole module and destructure. Functionally identical
// to `import { Worker } from 'bullmq'` once Node/bullmq ship with an exports map.
import bullmq from 'bullmq'
const { Worker } = bullmq
// ioredis is published as CJS with `module.exports = Redis`. Different Node
// versions disagree on how that becomes an ESM default import:
//  - Node 22 ESM-default-import gives the bare Redis class.
//  - Node 25 ESM-default-import gives a namespace { default: Redis, Redis, ... }.
// Normalise by accepting either shape.
import IORedisModule from 'ioredis'
const IORedis =
  (IORedisModule as unknown as { default?: typeof IORedisModule }).default ?? IORedisModule
import { VIDEO_TRANSCODE_QUEUE } from './queue.js'
import { transcodeProcessor } from './processors/transcode.js'
import { createDb, closeDb } from './db.js'
import { updateTranscodeStatus } from './assets.js'

// MEDIA_REDIS_URL is the dedicated Redis for the media pipeline (separate from Hocuspocus Redis).
const redisUrl = process.env['MEDIA_REDIS_URL'] ?? process.env['REDIS_URL']
if (!redisUrl) throw new Error('MEDIA_REDIS_URL (or REDIS_URL) is required')

// maxRetriesPerRequest: null is required by BullMQ — it manages retries itself.
const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null })

const concurrency = Number(process.env['WORKER_CONCURRENCY'] ?? 2)

const worker = new Worker(VIDEO_TRANSCODE_QUEUE, transcodeProcessor, {
  connection,
  concurrency,
  // Keep completed jobs 1 hour (for observability) but cap at 100 entries.
  // Keep failed jobs 24 hours for post-mortem inspection.
  removeOnComplete: { age: 3600, count: 100 },
  removeOnFail: { age: 86400 },
})

worker.on('ready', () => {
  console.log(`[video-worker] Ready — queue="${VIDEO_TRANSCODE_QUEUE}" concurrency=${concurrency}`)
})

worker.on('active', (job) => {
  console.log(`[video-worker] job=${job.id} started assetId=${job.data.assetId}`)
})

worker.on('completed', (job, result) => {
  console.log(`[video-worker] job=${job.id} completed assetId=${result.assetId}`)
})

worker.on('failed', async (job, err) => {
  console.error(`[video-worker] job=${job?.id} failed:`, err)
  if (job?.data.assetId) {
    // Update DB so the UI can display the error state. AWAIT the write (was
    // `void`-floated): a floated rejection here escapes the try/catch and
    // surfaces as an unhandledRejection, which would crash the worker process.
    // createDb() may fail if POSTGRES_URL is not set — log and swallow.
    try {
      const db = createDb()
      const message = err instanceof Error ? err.message : String(err)
      await updateTranscodeStatus(db, job.data.assetId, 'failed', message.slice(0, 1000))
    } catch (dbErr) {
      console.error('[video-worker] Failed to update transcode status in DB:', dbErr)
    }
  }
})

worker.on('error', (err) => {
  console.error('[video-worker] worker error:', err)
})

async function shutdown(signal: string) {
  console.log(`[video-worker] ${signal} received — shutting down gracefully`)
  await worker.close()
  await connection.quit()
  await closeDb()
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

// Last-resort process guards. Without these, a stray unhandled rejection
// (e.g. a floated DB/S3 write that rejects) or uncaught exception in a worker
// callback prints a warning and—on recent Node defaults—can terminate the
// process, silently stopping all transcoding. We log loudly and keep running;
// BullMQ will retry in-flight jobs, and a genuinely fatal state still surfaces
// via the failed-job handler. (Mirrors the server's process guards.)
process.on('unhandledRejection', (reason) => {
  console.error('[video-worker] unhandledRejection:', reason)
})
process.on('uncaughtException', (err) => {
  console.error('[video-worker] uncaughtException:', err)
})
