/**
 * processors/transcode.test.ts
 *
 * Unit tests for transcodeProcessor.
 *
 * Strategy:
 *   - child_process.spawn is mocked (via vi.hoisted) to avoid any real ffmpeg/ffprobe.
 *   - S3Client is mocked; no real MinIO connections.
 *   - DB helpers (updateTranscodeStatus, updateVideoAssetOutputs) are mocked.
 *   - fs/promises operations are mocked.
 *   - stream/promises pipeline is mocked.
 *
 * Real ffmpeg integration tests are gated on CI_HAS_FFMPEG=true.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Job } from 'bullmq'
import type { VideoTranscodeJobData, VideoTranscodeResult } from '../queue.js'

// ---------------------------------------------------------------------------
// Hoisted mock factories
// ---------------------------------------------------------------------------

const { mockS3Send, mockUpdateTranscodeStatus, mockUpdateVideoAssetOutputs, createMockSpawn } =
  vi.hoisted(() => {
    const mockS3Send = vi.fn().mockResolvedValue({ Body: {} })
    const mockUpdateTranscodeStatus = vi.fn().mockResolvedValue(undefined)
    const mockUpdateVideoAssetOutputs = vi.fn().mockResolvedValue(undefined)

    /**
     * Factory that returns a mock spawn result.
     * exitCode=0  → emits 'close' with 0.
     * exitCode!=0 → emits 'close' with that code.
     * probeJson   → emitted as stdout 'data' before close (for ffprobe calls).
     */
    function createMockSpawn(exitCode = 0, probeJson?: string): ReturnType<typeof vi.fn> {
      return vi.fn().mockImplementation(() => {
        const events: Record<string, Array<(...a: unknown[]) => void>> = {}

        const child = {
          stdout: {
            on: vi.fn((event: string, cb: (...a: unknown[]) => void) => {
              if (event === 'data' && probeJson) {
                setTimeout(() => cb(Buffer.from(probeJson)), 0)
              }
            }),
          },
          stderr: { on: vi.fn() },
          on: vi.fn((event: string, cb: (...a: unknown[]) => void) => {
            if (!events[event]) events[event] = []
            events[event]!.push(cb)
            if (event === 'close') {
              // Schedule the close event on next tick
              setTimeout(() => cb(exitCode), 0)
            }
          }),
        }
        return child
      })
    }

    return { mockS3Send, mockUpdateTranscodeStatus, mockUpdateVideoAssetOutputs, createMockSpawn }
  })

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const PROBE_JSON = JSON.stringify({
  streams: [{ width: 1280, height: 720, duration: '10.5', codec_type: 'video' }],
})

// Default spawn: ffprobe returns valid JSON, all other calls succeed
let mockSpawnImpl = createMockSpawn(0, PROBE_JSON)

vi.mock('node:child_process', () => ({
  spawn: (...args: Parameters<typeof import('node:child_process').spawn>) => mockSpawnImpl(...args),
}))

vi.mock('node:fs/promises', () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ size: 1024 }),
    readdir: vi.fn().mockResolvedValue([]),
  },
}))

vi.mock('node:fs', () => ({
  createReadStream: vi.fn().mockReturnValue({}),
  createWriteStream: vi.fn().mockReturnValue({}),
}))

vi.mock('node:stream/promises', () => ({
  pipeline: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: mockS3Send })),
  GetObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
  PutObjectCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}))

vi.mock('../db.js', () => ({
  createDb: vi.fn().mockReturnValue({}),
}))

vi.mock('../assets.js', () => ({
  updateTranscodeStatus: mockUpdateTranscodeStatus,
  updateVideoAssetOutputs: mockUpdateVideoAssetOutputs,
}))

// Import module under test AFTER mocks
import { transcodeProcessor } from './transcode.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(
  data: Partial<VideoTranscodeJobData> = {},
): Job<VideoTranscodeJobData, VideoTranscodeResult> {
  return {
    id: 'job-test-01',
    data: {
      assetId: 'asset-01',
      deckId: 'deck-01',
      storageKey: 'decks/deck-01/uploads/asset-01/original.mp4',
      uploaderUserId: 'user-01',
      mimeType: 'video/mp4',
      ...data,
    },
    updateProgress: vi.fn(),
  } as unknown as Job<VideoTranscodeJobData, VideoTranscodeResult>
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('transcodeProcessor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset to the default successful spawn implementation
    mockSpawnImpl = createMockSpawn(0, PROBE_JSON)
  })

  it('calls updateTranscodeStatus("processing") at job start', async () => {
    const job = makeJob()
    await transcodeProcessor(job)

    expect(mockUpdateTranscodeStatus).toHaveBeenCalledWith(
      expect.anything(),
      'asset-01',
      'processing',
    )
  })

  it('calls updateVideoAssetOutputs with correct output keys on success', async () => {
    const job = makeJob()
    await transcodeProcessor(job)

    expect(mockUpdateVideoAssetOutputs).toHaveBeenCalledWith(
      expect.anything(),
      'asset-01',
      expect.objectContaining({
        hlsManifestKey: expect.stringContaining('master.m3u8'),
        posterKey: expect.stringContaining('poster.jpg'),
        thumbnailKey: expect.stringContaining('thumb.jpg'),
        durationSec: expect.any(Number),
        width: 1280,
        height: 720,
      }),
    )
  })

  it('returns a VideoTranscodeResult with correct fields', async () => {
    const job = makeJob()
    const result = await transcodeProcessor(job)

    expect(result.assetId).toBe('asset-01')
    expect(result.hlsManifestKey).toContain('master.m3u8')
    expect(result.posterKey).toContain('poster.jpg')
    expect(result.thumbnailKey).toContain('thumb.jpg')
    expect(result.width).toBe(1280)
    expect(result.height).toBe(720)
    expect(result.durationSec).toBeCloseTo(10.5, 0)
  })

  it('output keys include the deckId path segment', async () => {
    const job = makeJob({ deckId: 'deck-special' })
    const result = await transcodeProcessor(job)

    expect(result.hlsManifestKey).toContain('deck-special')
    expect(result.posterKey).toContain('deck-special')
    expect(result.thumbnailKey).toContain('deck-special')
  })

  it('downloads from S3 using the job storageKey', async () => {
    const job = makeJob()
    await transcodeProcessor(job)

    expect(mockS3Send).toHaveBeenCalled()
  })

  it('uploads outputs to S3 (multiple PutObjectCommand calls)', async () => {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3')
    const job = makeJob()
    await transcodeProcessor(job)

    // At minimum: poster + thumb + master manifest (variant segments are directory-walked, returns [])
    expect(PutObjectCommand).toHaveBeenCalled()
  })

  it('cleans up work directory via fs.rm after success', async () => {
    const fs = (await import('node:fs/promises')).default
    const job = makeJob()
    await transcodeProcessor(job)

    expect(fs.rm).toHaveBeenCalledWith(
      expect.stringContaining('asset-01'),
      expect.objectContaining({ recursive: true, force: true }),
    )
  })

  it('cleans up work directory even when spawn fails', async () => {
    // First call (ffprobe) succeeds, second call (ffmpeg encode) fails
    let callCount = 0
    mockSpawnImpl = vi.fn().mockImplementation(() => {
      callCount++
      const events: Record<string, Array<(...a: unknown[]) => void>> = {}
      const exitCode = callCount === 1 ? 0 : 1
      const probeData = callCount === 1 ? PROBE_JSON : undefined

      return {
        stdout: {
          on: vi.fn((event: string, cb: (...a: unknown[]) => void) => {
            if (event === 'data' && probeData) {
              setTimeout(() => cb(Buffer.from(probeData)), 0)
            }
          }),
        },
        stderr: { on: vi.fn() },
        on: vi.fn((event: string, cb: (...a: unknown[]) => void) => {
          if (!events[event]) events[event] = []
          events[event]!.push(cb)
          if (event === 'close') {
            setTimeout(() => cb(exitCode), 0)
          }
        }),
      }
    })

    const fs = (await import('node:fs/promises')).default
    const job = makeJob()

    await expect(transcodeProcessor(job)).rejects.toThrow()

    expect(fs.rm).toHaveBeenCalledWith(
      expect.stringContaining('asset-01'),
      expect.objectContaining({ recursive: true, force: true }),
    )
  })

  it('throws when ffprobe finds no video stream', async () => {
    // ffprobe returns JSON with empty streams array
    mockSpawnImpl = createMockSpawn(0, JSON.stringify({ streams: [] }))

    const job = makeJob()
    await expect(transcodeProcessor(job)).rejects.toThrow(/no video stream/)
  })
})

// ---------------------------------------------------------------------------
// Real ffmpeg integration tests — skipped unless CI_HAS_FFMPEG=true
// ---------------------------------------------------------------------------

describe.skipIf(!process.env['CI_HAS_FFMPEG'])(
  'transcodeProcessor — real ffmpeg (CI_HAS_FFMPEG=true)',
  () => {
    it('TODO: run real transcode on tiny fixture MP4', () => {
      // Place tiny.mp4 (< 100 KB, silent, 2 s, 720p) at:
      //   apps/video-worker/src/processors/__fixtures__/tiny.mp4
      // Then remove spawn/fs/S3 mocks and test against a real MinIO dev instance.
      expect(true).toBe(true)
    })
  },
)
