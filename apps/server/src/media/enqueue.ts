/**
 * media/enqueue.ts
 *
 * BullMQ queue client used by the server to enqueue video transcode jobs.
 * The worker side (apps/video-worker) consumes from the same queue name.
 *
 * Design:
 *   - Lazy singleton Queue instance — created on first call, reused after.
 *   - MEDIA_REDIS_URL (default redis://127.0.0.1:6380) points at the dedicated
 *     media-redis service (separate from the Hocuspocus Redis if used).
 *   - closeQueueConnection() is called from the SIGTERM handler in apps/server/src/index.ts.
 *
 * Job options:
 *   - 3 attempts with exponential backoff starting at 5 s.
 *   - Completed jobs retained 1 hour (capped at 100) for observability.
 *   - Failed jobs retained 24 hours for post-mortem.
 */

import { Queue } from 'bullmq'
import { Redis as IORedis, type Redis as RedisInstance } from 'ioredis'
import { VIDEO_TRANSCODE_QUEUE, type VideoTranscodeJobData } from '@narrative/shared'

const redisUrl = process.env['MEDIA_REDIS_URL'] ?? 'redis://127.0.0.1:6380'

let queue: Queue<VideoTranscodeJobData> | null = null

function getQueue(): Queue<VideoTranscodeJobData> {
  if (queue !== null) return queue
  const connection: RedisInstance = new IORedis(redisUrl, { maxRetriesPerRequest: null })
  queue = new Queue<VideoTranscodeJobData>(VIDEO_TRANSCODE_QUEUE, { connection })
  return queue
}

/**
 * Adds a video transcode job to the BullMQ queue.
 * Called by onUploadFinish when the uploaded MIME type is video/*.
 */
export async function enqueueVideoTranscode(data: VideoTranscodeJobData): Promise<void> {
  await getQueue().add('transcode', data, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { age: 3600, count: 100 },
    removeOnFail: { age: 86400 },
  })
}

/**
 * Closes the queue connection.
 * Must be called during graceful shutdown (SIGTERM handler in apps/server/src/index.ts).
 */
export async function closeQueueConnection(): Promise<void> {
  if (queue !== null) {
    await queue.close()
    queue = null
  }
}
