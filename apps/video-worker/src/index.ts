import { Worker } from 'bullmq'
import IORedis from 'ioredis'
import { VIDEO_TRANSCODE_QUEUE } from './queue.js'
import { transcodeProcessor } from './processors/transcode.js'
import { createDb } from './db.js'
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

worker.on('failed', (job, err) => {
  console.error(`[video-worker] job=${job?.id} failed:`, err)
  if (job?.data.assetId) {
    // Update DB so the UI can display the error state.
    // createDb() may fail if POSTGRES_URL is not set — log and swallow.
    try {
      const db = createDb()
      const message = err instanceof Error ? err.message : String(err)
      void updateTranscodeStatus(db, job.data.assetId, 'failed', message.slice(0, 1000))
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
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
