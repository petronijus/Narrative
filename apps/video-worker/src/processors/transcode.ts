/**
 * processors/transcode.ts
 *
 * Full-quality video remux pipeline.
 *
 * We no longer downscale to 360/720/1080p HLS variants. The goal is to keep
 * the source quality verbatim and serve a single progressive MP4 (faststart)
 * via a plain <video> element over MinIO byte-range requests.
 *
 * Flow per job:
 *   1. updateTranscodeStatus → 'processing'
 *   2. Download original from MinIO to /tmp/narrative-transcode/<assetId>/input.<ext>
 *   3. ffprobe: get width, height, duration_sec, codec_name
 *   4. Build playback.mp4 (source resolution — no downscale):
 *        - codec already web-playable ({h264, vp9, av1, vp8}) → lossless stream
 *          copy: `ffmpeg -i input -c copy -movflags +faststart playback.mp4`
 *        - otherwise (ProRes, mpeg2, hevc, …) → re-encode at source resolution
 *          with libx264 + aac and faststart.
 *      (H.265/hevc copies fine into MP4 for storage but Chrome playback is
 *      unreliable, so hevc is deliberately re-encoded.)
 *   5. ffmpeg: extract poster.jpg at the 1 s mark (-q:v 2)
 *   6. ffmpeg: extract thumb.jpg (400 px wide) at the 1 s mark (-q:v 3)
 *   7. Upload playback.mp4 + poster.jpg + thumb.jpg to MinIO under
 *      decks/<deckId>/videos/<assetId>/
 *   8. updateVideoAssetOutputs → sets transcode_status='done'
 *   9. Cleanup /tmp/narrative-transcode/<assetId>/ (always, via finally)
 *
 * Error handling:
 *   - ffmpeg/ffprobe failure → throw; BullMQ retries up to 3×.
 *   - On final failure the worker 'failed' event calls updateTranscodeStatus('failed', err.message).
 *
 * Constraints:
 *   - CPU x264 only (no GPU) for the re-encode path. M29 polish if needed.
 *   - No audio normalization or colour grading.
 *   - Poster at the 1 s mark (or 0 s if video is shorter than 1 s).
 */

import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Job } from 'bullmq'
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import type { Readable } from 'node:stream'
import type { VideoTranscodeJobData, VideoTranscodeResult } from '../queue.js'

// ---------------------------------------------------------------------------
// DB helpers — imported from the shared assets module path in video-worker
// ---------------------------------------------------------------------------
// The video-worker has its own db client that mirrors apps/server/src/db.
// We import the DB helpers directly so the worker stays stateless per job.

import { createDb } from '../db.js'
import { updateTranscodeStatus, updateVideoAssetOutputs } from '../assets.js'

// ---------------------------------------------------------------------------
// S3 client
// ---------------------------------------------------------------------------

function buildS3Client(): S3Client {
  const endpoint = process.env['MINIO_ENDPOINT']
  const base = {
    region: 'us-east-1' as const,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env['MINIO_ROOT_USER'] ?? '',
      secretAccessKey: process.env['MINIO_ROOT_PASSWORD'] ?? '',
    },
  }
  return new S3Client(endpoint !== undefined ? { ...base, endpoint } : base)
}

const s3 = buildS3Client()
const BUCKET = process.env['MEDIA_BUCKET'] ?? 'narrative-media'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TMP_BASE = process.env['TRANSCODE_TMP_DIR'] ?? '/tmp/narrative-transcode'

/**
 * Codecs that browsers can play directly inside a progressive MP4, so we can
 * stream-copy them losslessly instead of re-encoding. NOTE: hevc (H.265) is
 * intentionally excluded — it muxes fine but Chrome playback is unreliable,
 * so we force a re-encode for it.
 */
const COPY_ELIGIBLE_CODECS = new Set(['h264', 'vp9', 'av1', 'vp8'])

// Cap ffmpeg's per-process worker threads. Without -threads, libx264 spawns
// (cpu_count * 1.5) threads, so two concurrent jobs saturate the box (and
// slow each other down through context switching). Default to 2; tune via
// FFMPEG_THREADS to match host CPUs / WORKER_CONCURRENCY.
const FFMPEG_THREADS = (() => {
  const raw = process.env['FFMPEG_THREADS']
  if (!raw) return 2
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : 2
})()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Runs a child process. Resolves with stdout string, rejects on non-zero exit.
 */
function run(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.on('error', (err) => {
      reject(new Error(`[transcode] Failed to start ${cmd}: ${err.message}`))
    })

    child.on('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(`[transcode] ${cmd} exited with code ${code}\nstderr: ${stderr.slice(-2000)}`),
        )
      } else {
        resolve(stdout)
      }
    })
  })
}

interface ProbeResult {
  width: number
  height: number
  durationSec: number
  codecName: string
}

/** Run ffprobe and extract video stream dimensions, duration + codec name. */
async function ffprobe(inputPath: string): Promise<ProbeResult> {
  const stdout = await run('ffprobe', [
    '-v',
    'quiet',
    '-print_format',
    'json',
    '-show_streams',
    '-select_streams',
    'v:0',
    inputPath,
  ])

  type FfprobeStream = {
    width?: number
    height?: number
    duration?: string
    tags?: { DURATION?: string }
    codec_type?: string
    codec_name?: string
  }
  type FfprobeOutput = { streams?: FfprobeStream[] }
  const data = JSON.parse(stdout) as FfprobeOutput
  const stream = data.streams?.[0]

  if (!stream) {
    throw new Error(`[transcode] ffprobe found no video stream in ${inputPath}`)
  }

  const width = stream.width ?? 0
  const height = stream.height ?? 0
  const codecName = (stream.codec_name ?? '').toLowerCase()

  // Duration can be in the stream or as a tag (some containers).
  let durationSec = stream.duration !== undefined ? parseFloat(stream.duration) : NaN
  if (isNaN(durationSec) && stream.tags?.DURATION) {
    // HH:MM:SS.mmm format
    const parts = stream.tags.DURATION.split(':')
    if (parts.length === 3) {
      durationSec =
        parseInt(parts[0]!, 10) * 3600 + parseInt(parts[1]!, 10) * 60 + parseFloat(parts[2]!)
    }
  }

  if (isNaN(durationSec) || durationSec <= 0) {
    // Fallback: use format-level duration via a second probe
    const fmtOut = await run('ffprobe', [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_format',
      inputPath,
    ])
    type FfprobeFmt = { format?: { duration?: string } }
    const fmtData = JSON.parse(fmtOut) as FfprobeFmt
    durationSec = parseFloat(fmtData.format?.duration ?? '0')
  }

  return { width, height, durationSec, codecName }
}

/**
 * Upload a local file to MinIO.
 * Returns the storageKey used.
 */
async function uploadFile(
  localPath: string,
  storageKey: string,
  contentType: string,
): Promise<void> {
  const body = createReadStream(localPath)
  const stat = await fs.stat(localPath)
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: storageKey,
      Body: body,
      ContentLength: stat.size,
      ContentType: contentType,
    }),
  )
}

// ---------------------------------------------------------------------------
// Main processor
// ---------------------------------------------------------------------------

export async function transcodeProcessor(
  job: Job<VideoTranscodeJobData, VideoTranscodeResult>,
): Promise<VideoTranscodeResult> {
  const { assetId, deckId, storageKey } = job.data
  const db = createDb()

  // 1. Mark as processing
  await updateTranscodeStatus(db, assetId, 'processing')
  console.log(`[transcode] job=${job.id} assetId=${assetId} → processing`)

  const workDir = path.join(TMP_BASE, assetId)
  await fs.mkdir(workDir, { recursive: true })

  try {
    // 2. Determine extension from MIME or original key
    const origExt = path.extname(storageKey).replace('.', '') || 'mp4'
    const inputPath = path.join(workDir, `input.${origExt}`)

    // Download original from MinIO
    console.log(`[transcode] downloading ${storageKey}`)
    const getResp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: storageKey }))
    if (!getResp.Body) throw new Error('[transcode] Empty response body from MinIO')
    await pipeline(getResp.Body as Readable, createWriteStream(inputPath))
    console.log(`[transcode] downloaded to ${inputPath}`)

    // 3. ffprobe
    const { width, height, durationSec, codecName } = await ffprobe(inputPath)
    console.log(
      `[transcode] probe: ${width}x${height} duration=${durationSec.toFixed(2)}s codec=${codecName}`,
    )

    const outputDir = path.join(workDir, 'output')
    await fs.mkdir(outputDir, { recursive: true })

    // 4. Build playback.mp4 — keep full source resolution. Stream-copy when the
    //    source codec is web-playable, otherwise re-encode with libx264.
    const playbackPath = path.join(outputDir, 'playback.mp4')
    const canCopy = COPY_ELIGIBLE_CODECS.has(codecName)

    if (canCopy) {
      console.log(`[transcode] codec=${codecName} is web-playable → lossless stream copy`)
      await run(
        'ffmpeg',
        ['-i', inputPath, '-c', 'copy', '-movflags', '+faststart', '-y', playbackPath],
        { cwd: workDir },
      )
    } else {
      console.log(`[transcode] codec=${codecName} not web-safe → re-encode (libx264, source res)`)
      await run(
        'ffmpeg',
        [
          '-threads',
          String(FFMPEG_THREADS),
          '-i',
          inputPath,
          '-c:v',
          'libx264',
          '-preset',
          'fast',
          '-crf',
          '20',
          '-pix_fmt',
          'yuv420p',
          '-movflags',
          '+faststart',
          '-c:a',
          'aac',
          '-b:a',
          '192k',
          '-ar',
          '48000',
          '-ac',
          '2',
          '-y',
          playbackPath,
        ],
        { cwd: workDir },
      )
    }
    console.log(`[transcode] playback.mp4 ready`)

    // 5 & 6. Poster frame + thumbnail
    const seekTime = durationSec >= 1 ? '1' : '0'

    const posterPath = path.join(outputDir, 'poster.jpg')
    await run('ffmpeg', [
      '-ss',
      seekTime,
      '-i',
      inputPath,
      '-vframes',
      '1',
      '-q:v',
      '2',
      '-y',
      posterPath,
    ])

    const thumbPath = path.join(outputDir, 'thumb.jpg')
    await run('ffmpeg', [
      '-ss',
      seekTime,
      '-i',
      inputPath,
      '-vframes',
      '1',
      '-vf',
      'scale=400:-2',
      '-q:v',
      '3',
      '-y',
      thumbPath,
    ])

    // 7. Upload all outputs to MinIO
    const s3VideoPrefix = `decks/${deckId}/videos/${assetId}`

    const playbackKey = `${s3VideoPrefix}/playback.mp4`
    const posterKey = `${s3VideoPrefix}/poster.jpg`
    const thumbnailKey = `${s3VideoPrefix}/thumb.jpg`

    await Promise.all([
      uploadFile(playbackPath, playbackKey, 'video/mp4'),
      uploadFile(posterPath, posterKey, 'image/jpeg'),
      uploadFile(thumbPath, thumbnailKey, 'image/jpeg'),
    ])

    console.log(`[transcode] uploads complete, assetId=${assetId}`)

    // 8. Update DB
    await updateVideoAssetOutputs(db, assetId, {
      playbackKey,
      posterKey,
      thumbnailKey,
      durationSec,
      width,
      height,
    })

    console.log(`[transcode] job=${job.id} assetId=${assetId} → done`)

    return {
      assetId,
      posterKey,
      thumbnailKey,
      playbackKey,
      durationSec,
      width,
      height,
    }
  } finally {
    // 9. Cleanup working directory regardless of success or failure
    try {
      await fs.rm(workDir, { recursive: true, force: true })
    } catch (cleanErr) {
      console.warn(`[transcode] cleanup failed for ${workDir}:`, cleanErr)
    }
  }
}
