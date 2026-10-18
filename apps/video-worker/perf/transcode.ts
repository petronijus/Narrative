/**
 * perf/transcode.ts — the video worker's time to poster and time to playable
 * (docs/plans/performance.md, R2).
 *
 * Runs the real `transcodeProcessor` (real ffmpeg, the real MinIO) on sources
 * ffmpeg generates (`testsrc2` with a tone), outside the queue: nothing goes
 * through BullMQ, so a worker of a running stack never sees these jobs. The
 * asset id is random and has no `media_assets` row, so the processor's status
 * writes change nothing in the database it is pointed at.
 *
 *   time to poster   job start → `poster.jpg` is in the bucket (polled every
 *                    50 ms with HeadObject: the moment a reader could have it)
 *   time to playable job start → the processor returns (playback.mp4 stored,
 *                    the asset marked done)
 *
 * Cases: 1080p and 4K, each as H.264 (web-playable: the lossless stream copy)
 * and as ProRes (re-encoded with libx264). Everything it uploads (sources and
 * outputs) is deleted afterwards.
 *
 * Run with the stack's environment (MinIO credentials, POSTGRES_URL):
 *
 *   node --env-file=.env --import tsx apps/video-worker/perf/transcode.ts
 *
 *   PERF_SECONDS   length of each source (default 10)
 *   PERF_RUNS      runs per stream-copy case (default 3; re-encodes run 2)
 *   PERF_CASES     comma list to run a subset: 1080p-h264,4k-h264,1080p-prores,4k-prores
 *   FFMPEG_THREADS as the worker reads it (default 2, the production setting)
 *   PERF_PROCESSOR a module path to time instead of src/processors/transcode.ts
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir, cpus } from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3'
import type { Job } from 'bullmq'
import { median, quantile } from '@narrative/perf/stats'
import type { VideoTranscodeJobData, VideoTranscodeResult } from '../src/queue.js'
import type { transcodeProcessor as TranscodeProcessor } from '../src/processors/transcode.js'

const SECONDS = Number(process.env['PERF_SECONDS'] ?? 10)
const RUNS = Number(process.env['PERF_RUNS'] ?? 3)
const BUCKET = process.env['MEDIA_BUCKET'] ?? 'narrative-media'

interface Case {
  name: string
  size: string
  ext: string
  mime: string
  codec: string[]
  runs: number
}

const CASES: Case[] = [
  {
    name: '1080p-h264',
    size: '1920x1080',
    ext: 'mp4',
    mime: 'video/mp4',
    codec: ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac'],
    runs: RUNS,
  },
  {
    name: '4k-h264',
    size: '3840x2160',
    ext: 'mp4',
    mime: 'video/mp4',
    codec: ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac'],
    runs: RUNS,
  },
  {
    name: '1080p-prores',
    size: '1920x1080',
    ext: 'mov',
    mime: 'video/quicktime',
    codec: ['-c:v', 'prores_ks', '-profile:v', '2', '-c:a', 'pcm_s16le'],
    runs: Math.min(RUNS, 2),
  },
  {
    name: '4k-prores',
    size: '3840x2160',
    ext: 'mov',
    mime: 'video/quicktime',
    codec: ['-c:v', 'prores_ks', '-profile:v', '2', '-c:a', 'pcm_s16le'],
    runs: Math.min(RUNS, 2),
  },
]

function s3Client(): S3Client {
  const endpoint = process.env['MINIO_ENDPOINT']
  return new S3Client({
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env['MINIO_ROOT_USER'] ?? '',
      secretAccessKey: process.env['MINIO_ROOT_PASSWORD'] ?? '',
    },
    ...(endpoint !== undefined ? { endpoint } : {}),
  })
}

async function exists(s3: S3Client, key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }))
    return true
  } catch {
    return false
  }
}

async function deletePrefix(s3: S3Client, prefix: string): Promise<void> {
  const listed = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }))
  const keys = (listed.Contents ?? []).map((o) => ({ Key: o.Key! }))
  if (keys.length > 0) {
    await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: keys } }))
  }
}

async function main(): Promise<void> {
  // The processor builds its S3 client from the environment when imported.
  // PERF_PROCESSOR: another module with the same export (an older revision
  // copied beside it), for an A/B under the same machine load.
  const { transcodeProcessor } = (await import(
    process.env['PERF_PROCESSOR'] ?? '../src/processors/transcode.js'
  )) as { transcodeProcessor: typeof TranscodeProcessor }
  const s3 = s3Client()
  const only = process.env['PERF_CASES']?.split(',')
  const work = mkdtempSync(path.join(tmpdir(), 'narrative-perf-video-'))
  const deckId = `perf-video-${randomBytes(4).toString('hex')}`
  console.log(
    `[perf] ${cpus().length} CPUs, FFMPEG_THREADS=${process.env['FFMPEG_THREADS'] ?? '2 (default)'}, ` +
      `${SECONDS} s sources, deck prefix decks/${deckId}/`,
  )
  const rows: string[] = []
  try {
    for (const c of CASES.filter((c) => only === undefined || only.includes(c.name))) {
      const source = path.join(work, `${c.name}.${c.ext}`)
      execFileSync(
        'ffmpeg',
        [
          ...['-hide_banner', '-loglevel', 'error', '-y'],
          ...['-f', 'lavfi', '-i', `testsrc2=size=${c.size}:rate=30:duration=${SECONDS}`],
          ...['-f', 'lavfi', '-i', `sine=frequency=440:duration=${SECONDS}`],
          ...c.codec,
          '-shortest',
          source,
        ],
        { stdio: 'inherit' },
      )
      const bytes = readFileSync(source)
      const poster: number[] = []
      const playable: number[] = []
      for (let run = 0; run < c.runs; run++) {
        const assetId = `perf${randomBytes(6).toString('hex')}`
        const storageKey = `decks/${deckId}/uploads/${assetId}/original.${c.ext}`
        await s3.send(
          new PutObjectCommand({
            Bucket: BUCKET,
            Key: storageKey,
            Body: bytes,
            ContentType: c.mime,
          }),
        )
        const posterKey = `decks/${deckId}/videos/${assetId}/poster.jpg`
        const job = {
          id: `perf-${run}`,
          data: { assetId, deckId, storageKey, uploaderUserId: 'perf', mimeType: c.mime },
          updateProgress: async () => undefined,
        } as unknown as Job<VideoTranscodeJobData, VideoTranscodeResult>
        const start = Date.now()
        let posterAt: number | null = null
        let polling = true
        const poll = (async () => {
          while (polling && posterAt === null) {
            if (await exists(s3, posterKey)) posterAt = Date.now()
            else await new Promise((r) => setTimeout(r, 50))
          }
        })()
        await transcodeProcessor(job)
        const doneAt = Date.now()
        polling = false
        await poll
        poster.push((posterAt ?? doneAt) - start)
        playable.push(doneAt - start)
      }
      const fmt = (v: number[]) =>
        `p50=${Math.round(median(v))} p95=${Math.round(quantile(v, 0.95))} (n=${v.length})`
      const row = `${c.name.padEnd(13)} ${(bytes.byteLength / 1e6).toFixed(1).padStart(6)} MB  poster ${fmt(poster)}  playable ${fmt(playable)}`
      rows.push(row)
      console.log(`[perf] ${row}`)
    }
  } finally {
    await deletePrefix(s3, `decks/${deckId}/`).catch((err: unknown) => {
      console.error(`[perf] cleanup of decks/${deckId}/ failed:`, err)
    })
    rmSync(work, { recursive: true, force: true })
  }
  console.log('\n[perf] results (ms)')
  for (const row of rows) console.log(`  ${row}`)
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err)
    process.exit(1)
  },
)
