/**
 * queue.ts
 *
 * Re-exports from @narrative/shared so existing imports within the video-worker
 * package continue to resolve without changes.
 *
 * Source of truth has moved to packages/shared/src/video-queue.ts so that
 * apps/server can also import these types without a cross-app dependency.
 */

export {
  VIDEO_TRANSCODE_QUEUE,
  type VideoTranscodeJobData,
  type VideoTranscodeResult,
} from '@narrative/shared'
