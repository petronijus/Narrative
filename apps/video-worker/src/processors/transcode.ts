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
 *   5. ffmpeg, beside step 4 (started with it, right after the probe): one run
 *      extracts poster.jpg (-q:v 2) and thumb.jpg (400 px wide, -q:v 3) at the
 *      1 s mark; both are uploaded and written to the asset at once
 *      (updateVideoStills, the status still 'processing') — a re-encode takes
 *      minutes, the stills a second — and reported on the job's progress
 *      (`{ stage: 'stills' }`), on which the server warms their imgproxy
 *      variants (apps/server/src/media/videoStillsWarm.ts)
 *   6. Wait for both; a failure of either fails the job (after both ended)
 *   7. Upload playback.mp4 to MinIO under <owner>/videos/<assetId>/ (the
 *      stills went there in step 5), the owner being decks/<deckId> or
 *      components/<componentId> as the upload's storage key says
 *      (videoOutputPrefix, @narrative/shared)
 *   8. updateVideoAssetOutputs → sets transcode_status='done'
 *   9. A source larger than 1920×1080 (as displayed, rotation applied) also
 *      gets present.mp4: libx264 fitted into 1920×1080, aspect kept — what
 *      present mode plays when the slide is shown at 1080p or less
 *      (docs/plans/performance.md, P3: a 4K video decoded 8.3 Mpx a frame
 *      onto a 1920×1080 slide). The original playback stays for larger
 *      screens. Its own ffmpeg run: beside a stream copy (which is I/O), after
 *      a re-encode (both x264 runs at once, or both outputs from one run,
 *      made the playback ~50 % later on two threads: measured 2026-10-19,
 *      4K ProRes 9.9 → 15.0 s to playable). The video is marked done
 *      (playable) before the rendition is stored, so it never waits for it;
 *      a rendition that fails is logged and left out: the video plays from
 *      its playback file as before.
 *  10. Cleanup /tmp/narrative-transcode/<assetId>/ (always, via finally)
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
import {
  S3Client,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import type { Readable } from 'node:stream'
import {
  videoOutputPrefix,
  type VideoTranscodeJobData,
  type VideoTranscodeProgress,
  type VideoTranscodeResult,
} from '../queue.js'

// ---------------------------------------------------------------------------
// DB helpers — imported from the shared assets module path in video-worker
// ---------------------------------------------------------------------------
// The video-worker has its own db client that mirrors apps/server/src/db.
// We import the DB helpers directly so the worker stays stateless per job.

import { createDb } from '../db.js'
import {
  updatePresentRendition,
  updateTranscodeStatus,
  updateVideoAssetOutputs,
  updateVideoStills,
} from '../assets.js'

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
  /** Quarter turns the display matrix asks for (0–3): 1 and 3 swap width and height on screen. */
  quarterTurns: number
}

/** The box present.mp4 is fitted into: the slide at 1×. */
export const PRESENT_MAX_WIDTH = 1920
export const PRESENT_MAX_HEIGHT = 1080

/** The size a probed video is shown at: its coded size, turned by its display matrix. */
export function displaySize(p: Pick<ProbeResult, 'width' | 'height' | 'quarterTurns'>): {
  width: number
  height: number
} {
  return p.quarterTurns % 2 === 1
    ? { width: p.height, height: p.width }
    : { width: p.width, height: p.height }
}

/** Whether a video shown at `size` gets present.mp4: it does not fit 1920×1080. */
export function needsPresentRendition(size: { width: number; height: number }): boolean {
  return size.width > PRESENT_MAX_WIDTH || size.height > PRESENT_MAX_HEIGHT
}

/** The rotation of a probed stream in quarter turns, from its display matrix or `rotate` tag. */
export function quarterTurnsOf(stream: {
  tags?: { rotate?: string }
  side_data_list?: Array<{ rotation?: number | string }>
}): number {
  const fromSideData = stream.side_data_list?.find((d) => d.rotation !== undefined)?.rotation
  const degrees = Number(fromSideData ?? stream.tags?.rotate ?? 0)
  if (!Number.isFinite(degrees)) return 0
  return ((Math.round(degrees / 90) % 4) + 4) % 4
}

/**
 * ffmpeg arguments of present.mp4: fitted into 1920×1080 (aspect kept, even
 * sides), libx264 + aac like the re-encoded playback. ffmpeg turns the frames
 * upright first (its autorotate), so the box applies to the displayed size.
 */
export function presentOutputArgs(videoLabel: string, outputPath: string): string[] {
  return [
    ...['-map', videoLabel, '-map', '0:a:0?'],
    ...['-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p'],
    ...['-movflags', '+faststart'],
    ...['-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2'],
    ...['-y', outputPath],
  ]
}

const PRESENT_SCALE =
  `scale=${PRESENT_MAX_WIDTH}:${PRESENT_MAX_HEIGHT}` +
  ':force_original_aspect_ratio=decrease:force_divisible_by=2'

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
    tags?: { DURATION?: string; rotate?: string }
    side_data_list?: Array<{ rotation?: number | string }>
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

  return { width, height, durationSec, codecName, quarterTurns: quarterTurnsOf(stream) }
}

/** The size of a file ffmpeg wrote (upright, no display matrix). */
async function probeSize(filePath: string): Promise<{ width: number; height: number }> {
  const out = JSON.parse(
    await run('ffprobe', [
      ...['-v', 'quiet', '-print_format', 'json', '-select_streams', 'v:0'],
      ...['-show_entries', 'stream=width,height', filePath],
    ]),
  ) as { streams?: Array<{ width?: number; height?: number }> }
  const s = out.streams?.[0]
  if (s?.width === undefined || s.height === undefined)
    throw new Error(`[transcode] ffprobe found no video stream in ${filePath}`)
  return { width: s.width, height: s.height }
}

/** Remove an object this job stored (best effort: logged, never thrown). */
async function removeObject(key: string): Promise<void> {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }))
  } catch (err) {
    console.warn(`[transcode] could not remove ${key}:`, err)
  }
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

/**
 * playback.mp4 at the source's resolution: a lossless stream copy when the
 * codec is web-playable, else a libx264 + aac re-encode.
 */
function buildPlayback(
  inputPath: string,
  codecName: string,
  playbackPath: string,
  workDir: string,
): Promise<string> {
  if (COPY_ELIGIBLE_CODECS.has(codecName)) {
    console.log(`[transcode] codec=${codecName} is web-playable → lossless stream copy`)
    return run(
      'ffmpeg',
      ['-i', inputPath, '-c', 'copy', '-movflags', '+faststart', '-y', playbackPath],
      { cwd: workDir },
    )
  }
  console.log(`[transcode] codec=${codecName} not web-safe → re-encode (libx264, source res)`)
  return run(
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

/** present.mp4, from the source. */
function buildPresent(inputPath: string, presentPath: string, workDir: string): Promise<string> {
  return run(
    'ffmpeg',
    [
      ...['-threads', String(FFMPEG_THREADS), '-i', inputPath],
      ...['-filter_complex', `[0:v:0]${PRESENT_SCALE}[present]`],
      ...presentOutputArgs('[present]', presentPath),
    ],
    { cwd: workDir },
  )
}

/**
 * The poster (full size, -q:v 2) and the thumbnail (400 px wide, -q:v 3) at
 * the 1 s mark (0 s for a shorter video), from one ffmpeg run: the frame is
 * sought and decoded once for both outputs.
 */
function extractStills(
  inputPath: string,
  durationSec: number,
  posterPath: string,
  thumbPath: string,
): Promise<string> {
  const seekTime = durationSec >= 1 ? '1' : '0'
  return run('ffmpeg', [
    ...['-ss', seekTime, '-i', inputPath],
    ...['-map', '0:v:0', '-frames:v', '1', '-q:v', '2', '-y', posterPath],
    ...['-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=400:-2', '-q:v', '3', '-y', thumbPath],
  ])
}

// ---------------------------------------------------------------------------
// Main processor
// ---------------------------------------------------------------------------

export async function transcodeProcessor(
  job: Job<VideoTranscodeJobData, VideoTranscodeResult>,
): Promise<VideoTranscodeResult> {
  const { assetId, storageKey } = job.data
  // Where the outputs go follows the upload's owner (a deck or a component
  // master), read from its storage key. Resolved before any work: a key
  // that names no owner fails the job instead of writing outputs somewhere
  // no cleanup will ever look.
  const s3VideoPrefix = videoOutputPrefix(job.data)
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
    const { width, height, durationSec, codecName, quarterTurns } = await ffprobe(inputPath)
    console.log(
      `[transcode] probe: ${width}x${height} duration=${durationSec.toFixed(2)}s codec=${codecName}`,
    )

    const outputDir = path.join(workDir, 'output')
    await fs.mkdir(outputDir, { recursive: true })

    const playbackKey = `${s3VideoPrefix}/playback.mp4`
    const posterKey = `${s3VideoPrefix}/poster.jpg`
    const thumbnailKey = `${s3VideoPrefix}/thumb.jpg`

    // 5 & 6 first, beside 4: the poster and the thumbnail come from one
    // decoded frame, uploaded and on the asset as soon as they exist — a
    // re-encode takes minutes, the stills a second.
    const stills = (async () => {
      const posterPath = path.join(outputDir, 'poster.jpg')
      const thumbPath = path.join(outputDir, 'thumb.jpg')
      await extractStills(inputPath, durationSec, posterPath, thumbPath)
      await Promise.all([
        uploadFile(posterPath, posterKey, 'image/jpeg'),
        uploadFile(thumbPath, thumbnailKey, 'image/jpeg'),
      ])
      await updateVideoStills(db, assetId, { posterKey, thumbnailKey, durationSec, width, height })
      console.log(`[transcode] poster + thumbnail ready, assetId=${assetId}`)
      // The server warms their imgproxy variants on this (media/videoStillsWarm.ts).
      // Best effort: a lost report only means the first viewer encodes them.
      const report: VideoTranscodeProgress = { stage: 'stills', assetId }
      await Promise.resolve(job.updateProgress(report)).catch((err: unknown) =>
        console.warn(`[transcode] stills report failed, assetId=${assetId}:`, err),
      )
    })()

    // 4. Build playback.mp4 — keep full source resolution. Stream-copy when the
    //    source codec is web-playable, otherwise re-encode with libx264.
    //    9. present.mp4 for a source larger than 1080p: beside a stream
    //    copy, after a re-encode (the playback first).
    const playbackPath = path.join(outputDir, 'playback.mp4')
    const presentPath = path.join(outputDir, 'present.mp4')
    const presentKey = `${s3VideoPrefix}/present.mp4`
    const shown = displaySize({ width, height, quarterTurns })
    const wantPresent = needsPresentRendition(shown)
    const copied = COPY_ELIGIBLE_CODECS.has(codecName)
    const playback = buildPlayback(inputPath, codecName, playbackPath, workDir)
    // Awaited after the video is marked playable.
    const present = wantPresent
      ? (copied ? Promise.resolve() : playback.then(() => undefined))
          .then(() => buildPresent(inputPath, presentPath, workDir))
          .then(() => probeSize(presentPath))
      : null
    // Not left unhandled while the playback is stored; settled below.
    present?.catch(() => undefined)

    // Both run to their end before anything fails the job: a failed one
    // must not leave the other's ffmpeg writing into a work dir being removed.
    const [stillsDone, playbackDone] = await Promise.allSettled([stills, playback])
    if (stillsDone.status === 'rejected') {
      await present?.catch(() => undefined)
      throw stillsDone.reason
    }
    if (playbackDone.status === 'rejected') {
      await present?.catch(() => undefined)
      throw playbackDone.reason
    }
    console.log(`[transcode] playback.mp4 ready`)

    // 7. Upload the playback (the stills are up already)
    await uploadFile(playbackPath, playbackKey, 'video/mp4')

    console.log(`[transcode] uploads complete, assetId=${assetId}`)

    // 8. Update DB: playable from here on.
    await updateVideoAssetOutputs(db, assetId, {
      playbackKey,
      posterKey,
      thumbnailKey,
      durationSec,
      width,
      height,
    })

    console.log(`[transcode] job=${job.id} assetId=${assetId} → done`)

    // 9. The 1080p rendition, once it is made. Its failure costs nothing
    //    but the rendition: the video already plays from playback.mp4.
    let presentResult: { presentKey: string; presentWidth: number; presentHeight: number } | null =
      null
    if (present !== null) {
      try {
        const size = await present
        await uploadFile(presentPath, presentKey, 'video/mp4')
        const kept = await updatePresentRendition(db, assetId, {
          presentKey,
          width: size.width,
          height: size.height,
        })
        if (!kept) {
          // Deleted while the rendition was made: its deletion read the
          // row's keys before this file existed, so nothing else removes it.
          await removeObject(presentKey)
          console.log(`[transcode] asset ${assetId} was deleted meanwhile; present.mp4 removed`)
          return {
            assetId,
            posterKey,
            thumbnailKey,
            playbackKey,
            durationSec,
            width,
            height,
          }
        }
        presentResult = { presentKey, presentWidth: size.width, presentHeight: size.height }
        console.log(
          `[transcode] present.mp4 ${size.width}x${size.height} ready, assetId=${assetId}`,
        )
      } catch (err) {
        console.warn(`[transcode] present.mp4 failed, assetId=${assetId}; playback only:`, err)
      }
    }

    return {
      assetId,
      posterKey,
      thumbnailKey,
      playbackKey,
      durationSec,
      width,
      height,
      ...(presentResult !== null ? presentResult : {}),
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
