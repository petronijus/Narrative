/**
 * processors/transcode.ts
 *
 * Real ffmpeg HLS transcoding pipeline for M12 phase 2.
 *
 * Flow per job:
 *   1. updateTranscodeStatus → 'processing'
 *   2. Download original from MinIO to /tmp/narrative-transcode/<assetId>/input.<ext>
 *   3. ffprobe: get width, height, duration_sec
 *   4. ffmpeg: encode 360p, 720p, 1080p (skipped when source height < variant height)
 *      Each variant produces: variant/playlist.m3u8 + variant/seg_NNN.ts
 *   5. Write master.m3u8 referencing all produced variants
 *   6. ffmpeg: extract poster.jpg at 1 s mark
 *   7. ffmpeg: extract thumb.jpg (400 px wide) at 1 s mark
 *   8. Upload all outputs to MinIO under decks/<deckId>/videos/<assetId>/
 *   9. updateVideoAssetOutputs → sets transcode_status='done'
 *  10. Cleanup /tmp/narrative-transcode/<assetId>/ (always, via finally)
 *
 * Error handling:
 *   - ffmpeg/ffprobe failure → throw; BullMQ retries up to 3×.
 *   - On final failure the worker 'failed' event calls updateTranscodeStatus('failed', err.message).
 *
 * Constraints:
 *   - CPU x264 only (no GPU). M29 polish if needed.
 *   - No audio normalization or colour grading.
 *   - HLS segment duration: 4 s.
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

const TMP_BASE = '/tmp/narrative-transcode'
const HLS_SEGMENT_DURATION = 4 // seconds

interface HlsVariant {
  label: string
  height: number
  videoBitrate: string
  audioBitrate: string
  bandwidth: number // bps for master manifest BANDWIDTH field
}

const VARIANTS: HlsVariant[] = [
  { label: '360p', height: 360, videoBitrate: '800k', audioBitrate: '96k', bandwidth: 928_000 },
  { label: '720p', height: 720, videoBitrate: '2500k', audioBitrate: '128k', bandwidth: 2_688_000 },
  {
    label: '1080p',
    height: 1080,
    videoBitrate: '5000k',
    audioBitrate: '192k',
    bandwidth: 5_248_000,
  },
]

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
}

/** Run ffprobe and extract video stream dimensions + duration. */
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
  }
  type FfprobeOutput = { streams?: FfprobeStream[] }
  const data = JSON.parse(stdout) as FfprobeOutput
  const stream = data.streams?.[0]

  if (!stream) {
    throw new Error(`[transcode] ffprobe found no video stream in ${inputPath}`)
  }

  const width = stream.width ?? 0
  const height = stream.height ?? 0

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

  return { width, height, durationSec }
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
 * Upload a text/string buffer to MinIO (used for .m3u8 manifest files).
 */
async function uploadText(content: string, storageKey: string): Promise<void> {
  const buf = Buffer.from(content, 'utf8')
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: storageKey,
      Body: buf,
      ContentLength: buf.byteLength,
      ContentType: 'application/x-mpegURL',
    }),
  )
}

/**
 * Recursively upload all files under a local directory to MinIO under a key prefix.
 * Preserves the relative directory structure.
 */
async function uploadDirectory(localDir: string, s3Prefix: string): Promise<void> {
  const entries = await fs.readdir(localDir, { withFileTypes: true })
  await Promise.all(
    entries.map(async (entry) => {
      const localPath = path.join(localDir, entry.name)
      const s3Key = `${s3Prefix}/${entry.name}`
      if (entry.isDirectory()) {
        await uploadDirectory(localPath, s3Key)
      } else {
        const ext = path.extname(entry.name).toLowerCase()
        const contentType =
          ext === '.m3u8'
            ? 'application/x-mpegURL'
            : ext === '.ts'
              ? 'video/MP2T'
              : 'application/octet-stream'
        await uploadFile(localPath, s3Key, contentType)
      }
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
    const { width, height, durationSec } = await ffprobe(inputPath)
    console.log(`[transcode] probe: ${width}x${height} duration=${durationSec.toFixed(2)}s`)

    // 4. HLS transcode — only produce variants whose height <= source height
    const outputDir = path.join(workDir, 'output')
    await fs.mkdir(outputDir, { recursive: true })

    const producedVariants: HlsVariant[] = []

    for (const variant of VARIANTS) {
      if (height < variant.height) {
        console.log(
          `[transcode] skipping ${variant.label} (source ${height}p < ${variant.height}p)`,
        )
        continue
      }

      const variantDir = path.join(outputDir, variant.label)
      await fs.mkdir(variantDir, { recursive: true })

      const segmentPattern = path.join(variantDir, 'seg_%03d.ts')
      const playlistPath = path.join(variantDir, 'playlist.m3u8')

      await run(
        'ffmpeg',
        [
          '-i',
          inputPath,
          '-vf',
          `scale=-2:${variant.height}`,
          '-c:v',
          'libx264',
          '-preset',
          'fast',
          '-crf',
          '23',
          '-b:v',
          variant.videoBitrate,
          '-maxrate',
          variant.videoBitrate,
          '-bufsize',
          `${parseInt(variant.videoBitrate, 10) * 2}k`,
          '-c:a',
          'aac',
          '-ar',
          '48000',
          '-ac',
          '2',
          '-b:a',
          variant.audioBitrate,
          '-hls_time',
          String(HLS_SEGMENT_DURATION),
          '-hls_playlist_type',
          'vod',
          '-hls_segment_filename',
          segmentPattern,
          playlistPath,
        ],
        { cwd: workDir },
      )

      producedVariants.push(variant)
      console.log(`[transcode] encoded ${variant.label}`)
    }

    if (producedVariants.length === 0) {
      throw new Error(
        `[transcode] No variants produced — source height=${height} is below minimum (360p)`,
      )
    }

    // 5. Write master.m3u8
    const masterLines: string[] = ['#EXTM3U', '#EXT-X-VERSION:3']
    for (const v of producedVariants) {
      // Resolution field: use the actual output height; width calculated from -2:height scaling
      const scaledWidth = Math.round((width / height) * v.height)
      const safeWidth = scaledWidth % 2 === 0 ? scaledWidth : scaledWidth + 1
      masterLines.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${v.bandwidth},RESOLUTION=${safeWidth}x${v.height},CODECS="avc1.42e01e,mp4a.40.2"`,
        `${v.label}/playlist.m3u8`,
      )
    }
    const masterContent = masterLines.join('\n') + '\n'
    const masterLocalPath = path.join(outputDir, 'master.m3u8')
    await fs.writeFile(masterLocalPath, masterContent, 'utf8')

    // 6 & 7. Poster frame + thumbnail
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

    // 8. Upload all outputs to MinIO
    const s3VideoPrefix = `decks/${deckId}/videos/${assetId}`

    // Upload variant dirs (segments + playlists)
    for (const v of producedVariants) {
      await uploadDirectory(path.join(outputDir, v.label), `${s3VideoPrefix}/${v.label}`)
    }

    const hlsManifestKey = `${s3VideoPrefix}/master.m3u8`
    await uploadText(masterContent, hlsManifestKey)

    const posterKey = `${s3VideoPrefix}/poster.jpg`
    await uploadFile(posterPath, posterKey, 'image/jpeg')

    const thumbnailKey = `${s3VideoPrefix}/thumb.jpg`
    await uploadFile(thumbPath, thumbnailKey, 'image/jpeg')

    console.log(`[transcode] uploads complete, assetId=${assetId}`)

    // 9. Update DB
    await updateVideoAssetOutputs(db, assetId, {
      hlsManifestKey,
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
      hlsManifestKey,
      durationSec,
      width,
      height,
    }
  } finally {
    // 10. Cleanup working directory regardless of success or failure
    try {
      await fs.rm(workDir, { recursive: true, force: true })
    } catch (cleanErr) {
      console.warn(`[transcode] cleanup failed for ${workDir}:`, cleanErr)
    }
  }
}
