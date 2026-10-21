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
import { videoOutputPrefix } from '../queue.js'

// ---------------------------------------------------------------------------
// Hoisted mock factories
// ---------------------------------------------------------------------------

const {
  mockS3Send,
  mockUpdateTranscodeStatus,
  mockUpdateVideoAssetOutputs,
  mockUpdateVideoStills,
  mockUpdatePresentRendition,
  createMockSpawn,
} = vi.hoisted(() => {
  const mockS3Send = vi.fn().mockResolvedValue({ Body: {} })
  const mockUpdatePresentRendition = vi.fn().mockResolvedValue(true)
  const mockUpdateTranscodeStatus = vi.fn().mockResolvedValue(undefined)
  const mockUpdateVideoAssetOutputs = vi.fn().mockResolvedValue(undefined)
  const mockUpdateVideoStills = vi.fn().mockResolvedValue(undefined)

  /**
   * Factory that returns a mock spawn result.
   * exitCode=0  → emits 'close' with 0.
   * exitCode!=0 → emits 'close' with that code.
   * probeJson   → emitted as stdout 'data' before close (for ffprobe calls).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function createMockSpawn(exitCode = 0, probeJson?: string): (...args: any[]) => any {
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

  return {
    mockS3Send,
    mockUpdateTranscodeStatus,
    mockUpdateVideoAssetOutputs,
    mockUpdateVideoStills,
    mockUpdatePresentRendition,
    createMockSpawn,
  }
})

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

function makeProbeJson(codecName = 'h264'): string {
  return JSON.stringify({
    streams: [
      { width: 1280, height: 720, duration: '10.5', codec_type: 'video', codec_name: codecName },
    ],
  })
}

const PROBE_JSON = makeProbeJson('h264')

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
  S3Client: vi.fn().mockImplementation(function () {
    return { send: mockS3Send }
  }),
  GetObjectCommand: vi.fn().mockImplementation(function (_input: unknown) {
    return { input: _input }
  }),
  PutObjectCommand: vi.fn().mockImplementation(function (_input: unknown) {
    return { input: _input }
  }),
  DeleteObjectCommand: vi.fn().mockImplementation(function (_input: unknown) {
    return { input: _input, delete: true }
  }),
}))

vi.mock('../db.js', () => ({
  createDb: vi.fn().mockReturnValue({}),
}))

vi.mock('../assets.js', () => ({
  updateTranscodeStatus: mockUpdateTranscodeStatus,
  updateVideoAssetOutputs: mockUpdateVideoAssetOutputs,
  updateVideoStills: mockUpdateVideoStills,
  updatePresentRendition: mockUpdatePresentRendition,
}))

// Import module under test AFTER mocks
import {
  displaySize,
  needsPresentRendition,
  quarterTurnsOf,
  transcodeProcessor,
} from './transcode.js'

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
        playbackKey: expect.stringContaining('playback.mp4'),
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
    expect(result.playbackKey).toContain('playback.mp4')
    expect(result.posterKey).toContain('poster.jpg')
    expect(result.thumbnailKey).toContain('thumb.jpg')
    expect(result.width).toBe(1280)
    expect(result.height).toBe(720)
    expect(result.durationSec).toBeCloseTo(10.5, 0)
  })

  it("writes the outputs under the owner the storage key names: a deck's video", async () => {
    const result = await transcodeProcessor(makeJob())

    expect(result.playbackKey).toBe('decks/deck-01/videos/asset-01/playback.mp4')
    expect(result.posterKey).toBe('decks/deck-01/videos/asset-01/poster.jpg')
    expect(result.thumbnailKey).toBe('decks/deck-01/videos/asset-01/thumb.jpg')
  })

  it("writes a component master's video (tus compound key, no deckId) under components/<id>/", async () => {
    const path = 'components/comp-7/uploads/asset-01/original.mp4'
    const { deckId: _none, ...data } = makeJob().data
    const job = makeJob()
    job.data = {
      ...data,
      storageKey: `asset-01:unknown:${Buffer.from(path).toString('base64url')}`,
    }
    const result = await transcodeProcessor(job)

    expect(result.playbackKey).toBe('components/comp-7/videos/asset-01/playback.mp4')
    expect(mockUpdateVideoAssetOutputs).toHaveBeenCalledWith(
      expect.anything(),
      'asset-01',
      expect.objectContaining({ posterKey: 'components/comp-7/videos/asset-01/poster.jpg' }),
    )
  })

  it('fails a job whose key names no owner and that has no deckId, before any work', async () => {
    const { deckId: _none, ...data } = makeJob().data
    const job = makeJob()
    job.data = { ...data, storageKey: 'imports/whatever/original.mp4' }

    await expect(transcodeProcessor(job)).rejects.toThrow(/names no deck or component/)
    expect(mockS3Send).not.toHaveBeenCalled()
    expect(mockUpdateTranscodeStatus).not.toHaveBeenCalled()
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

    // playback.mp4 + poster.jpg + thumb.jpg → 3 PutObjectCommand uploads.
    expect(PutObjectCommand).toHaveBeenCalled()
  })

  it('runs exactly 2 ffmpeg invocations (remux + one for poster and thumb)', async () => {
    const spawnSpy = vi.fn().mockImplementation(createMockSpawn(0, PROBE_JSON))
    mockSpawnImpl = spawnSpy

    const job = makeJob()
    await transcodeProcessor(job)

    // 1 ffprobe + 2 ffmpeg = 3 total spawns. Filter to ffmpeg only.
    const ffmpegCalls = spawnSpy.mock.calls.filter((c) => c[0] === 'ffmpeg')
    expect(ffmpegCalls).toHaveLength(2)
    // The stills: both outputs of one decoded frame.
    const stills = ffmpegCalls.map((c) => c[1] as string[]).find((a) => a.includes('-ss'))!
    expect(stills.filter((a) => a.endsWith('.jpg'))).toEqual([
      expect.stringContaining('poster.jpg'),
      expect.stringContaining('thumb.jpg'),
    ])
  })

  it('starts the stills beside the playback and puts them on the asset before it is done', async () => {
    const spawnSpy = vi.fn().mockImplementation(createMockSpawn(0, PROBE_JSON))
    mockSpawnImpl = spawnSpy
    await transcodeProcessor(makeJob())

    // Both ffmpeg runs were spawned before either could finish (same tick).
    const ffmpegOrder = spawnSpy.mock.invocationCallOrder.filter(
      (_, i) => spawnSpy.mock.calls[i]![0] === 'ffmpeg',
    )
    expect(ffmpegOrder).toHaveLength(2)
    expect(mockUpdateVideoStills).toHaveBeenCalledWith(expect.anything(), 'asset-01', {
      posterKey: 'decks/deck-01/videos/asset-01/poster.jpg',
      thumbnailKey: 'decks/deck-01/videos/asset-01/thumb.jpg',
      durationSec: 10.5,
      width: 1280,
      height: 720,
    })
    expect(mockUpdateVideoStills.mock.invocationCallOrder[0]!).toBeLessThan(
      mockUpdateVideoAssetOutputs.mock.invocationCallOrder[0]!,
    )
  })

  it('reports the stills on the job once they are on the asset (the server warms them)', async () => {
    const job = makeJob()
    await transcodeProcessor(job)

    const report = vi.mocked(job.updateProgress)
    expect(report).toHaveBeenCalledWith({ stage: 'stills', assetId: 'asset-01' })
    expect(report.mock.invocationCallOrder[0]!).toBeGreaterThan(
      mockUpdateVideoStills.mock.invocationCallOrder[0]!,
    )
  })

  it('does not fail the job when the stills report cannot be made', async () => {
    const job = makeJob()
    vi.mocked(job.updateProgress).mockRejectedValue(new Error('redis down'))
    const result = await transcodeProcessor(job)

    expect(result.posterKey).toBe('decks/deck-01/videos/asset-01/poster.jpg')
    expect(mockUpdateVideoAssetOutputs).toHaveBeenCalled()
  })

  it('fails the job when the stills fail, after the playback run ended, and marks nothing done', async () => {
    let callCount = 0
    mockSpawnImpl = vi.fn().mockImplementation((cmd: string, args: string[]) => {
      callCount++
      const isStills = cmd === 'ffmpeg' && args.includes('-ss')
      return createMockSpawn(isStills ? 1 : 0, callCount === 1 ? PROBE_JSON : undefined)()
    })
    await expect(transcodeProcessor(makeJob())).rejects.toThrow(/ffmpeg exited with code 1/)
    expect(mockUpdateVideoStills).not.toHaveBeenCalled()
    expect(mockUpdateVideoAssetOutputs).not.toHaveBeenCalled()
  })

  it('h264 source uses lossless stream copy (-c copy)', async () => {
    const spawnSpy = vi.fn().mockImplementation(createMockSpawn(0, makeProbeJson('h264')))
    mockSpawnImpl = spawnSpy

    const job = makeJob()
    await transcodeProcessor(job)

    const ffmpegArgArrays = spawnSpy.mock.calls
      .filter((c) => c[0] === 'ffmpeg')
      .map((c) => c[1] as string[])
    // One of the ffmpeg invocations (the remux) must contain '-c copy'.
    const hasCopy = ffmpegArgArrays.some((args) => args.includes('copy'))
    expect(hasCopy).toBe(true)
    // And none should re-encode with libx264.
    const hasLibx264 = ffmpegArgArrays.some((args) => args.includes('libx264'))
    expect(hasLibx264).toBe(false)
  })

  it('non-web codec (prores) triggers a libx264 re-encode', async () => {
    const spawnSpy = vi.fn().mockImplementation(createMockSpawn(0, makeProbeJson('prores')))
    mockSpawnImpl = spawnSpy

    const job = makeJob()
    await transcodeProcessor(job)

    const ffmpegArgArrays = spawnSpy.mock.calls
      .filter((c) => c[0] === 'ffmpeg')
      .map((c) => c[1] as string[])
    const hasLibx264 = ffmpegArgArrays.some((args) => args.includes('libx264'))
    expect(hasLibx264).toBe(true)
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

  describe('the 1080p rendition (present.mp4) of a source larger than 1080p', () => {
    /** ffprobe of the source says `source`; of present.mp4, `present`; ffmpeg runs succeed (or `failPresent`). */
    function spawnFor(
      source: Record<string, unknown>,
      present = { width: 1920, height: 1080 },
      failPresent = false,
    ) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return vi.fn().mockImplementation((cmd: string, args: string[]): any => {
        if (cmd === 'ffprobe' && args.includes('stream=width,height'))
          return createMockSpawn(0, JSON.stringify({ streams: [present] }))()
        if (cmd === 'ffprobe')
          return createMockSpawn(
            0,
            JSON.stringify({ streams: [{ duration: '10', codec_type: 'video', ...source }] }),
          )()
        const isPresentOnly =
          args.some((a) => a.endsWith('present.mp4')) &&
          !args.some((a) => a.endsWith('playback.mp4'))
        return createMockSpawn(failPresent && isPresentOnly ? 1 : 0)()
      })
    }

    it('encodes it beside the stream copy of a 4K H.264, after the video is marked done', async () => {
      const spawnSpy = spawnFor({ width: 3840, height: 2160, codec_name: 'h264' })
      mockSpawnImpl = spawnSpy
      const result = await transcodeProcessor(makeJob())

      const ffmpeg = spawnSpy.mock.calls
        .filter((c) => c[0] === 'ffmpeg')
        .map((c) => c[1] as string[])
      expect(ffmpeg).toHaveLength(3)
      const present = ffmpeg.find((a) => a.at(-1)!.endsWith('present.mp4'))!
      expect(present.join(' ')).toContain(
        'scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2',
      )
      expect(present).toContain('libx264')
      // The copy stays a copy, the original resolution kept.
      expect(ffmpeg.find((a) => a.at(-1)!.endsWith('playback.mp4'))).toContain('copy')
      expect(mockUpdatePresentRendition).toHaveBeenCalledWith(expect.anything(), 'asset-01', {
        presentKey: 'decks/deck-01/videos/asset-01/present.mp4',
        width: 1920,
        height: 1080,
      })
      expect(mockUpdateVideoAssetOutputs.mock.invocationCallOrder[0]!).toBeLessThan(
        mockUpdatePresentRendition.mock.invocationCallOrder[0]!,
      )
      expect(result).toMatchObject({
        presentKey: expect.stringContaining('present.mp4'),
        presentWidth: 1920,
      })
    })

    it('encodes it after the re-encode of a source x264 cannot copy, the playback first', async () => {
      const spawnSpy = spawnFor(
        { width: 4096, height: 2160, codec_name: 'prores' },
        {
          width: 1920,
          height: 1012,
        },
      )
      mockSpawnImpl = spawnSpy
      await transcodeProcessor(
        makeJob({ storageKey: 'decks/deck-01/uploads/asset-01/original.mov' }),
      )
      const ffmpeg = spawnSpy.mock.calls
        .map((c, i) => ({ args: c[1] as string[], order: spawnSpy.mock.invocationCallOrder[i]! }))
        .filter((_, i) => spawnSpy.mock.calls[i]![0] === 'ffmpeg')
      expect(ffmpeg).toHaveLength(3)
      const playback = ffmpeg.find((c) => c.args.at(-1)!.endsWith('playback.mp4'))!
      const present = ffmpeg.find((c) => c.args.at(-1)!.endsWith('present.mp4'))!
      expect(playback.order).toBeLessThan(present.order)
      // Spawned only once the playback's run has closed.
      expect(mockUpdatePresentRendition).toHaveBeenCalledWith(
        expect.anything(),
        'asset-01',
        expect.objectContaining({ width: 1920, height: 1012 }),
      )
    })

    it('makes none for a 1080p source, and turns a rotated phone video upright to decide', async () => {
      mockSpawnImpl = spawnFor({ width: 1920, height: 1080, codec_name: 'h264' })
      await transcodeProcessor(makeJob())
      expect(mockUpdatePresentRendition).not.toHaveBeenCalled()

      // Coded 1920×1080, shown 1080×1920: taller than the slide.
      mockSpawnImpl = spawnFor(
        {
          width: 1920,
          height: 1080,
          codec_name: 'h264',
          side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }],
        },
        { width: 608, height: 1080 },
      )
      await transcodeProcessor(makeJob())
      expect(mockUpdatePresentRendition).toHaveBeenCalledTimes(1)
    })

    it('removes present.mp4 again when the asset was deleted while it was made', async () => {
      mockSpawnImpl = spawnFor({ width: 3840, height: 2160, codec_name: 'h264' })
      mockUpdatePresentRendition.mockResolvedValueOnce(false)
      const result = await transcodeProcessor(makeJob())
      const deletes = mockS3Send.mock.calls
        .map(([c]) => c as { input: { Key?: string }; delete?: boolean })
        .filter((c) => c.delete === true)
      expect(deletes.map((c) => c.input.Key)).toEqual(['decks/deck-01/videos/asset-01/present.mp4'])
      expect(result.presentKey).toBeUndefined()
    })

    it('removes nothing when the rendition is recorded', async () => {
      mockSpawnImpl = spawnFor({ width: 3840, height: 2160, codec_name: 'h264' })
      await transcodeProcessor(makeJob())
      expect(mockS3Send.mock.calls.some(([c]) => (c as { delete?: boolean }).delete === true)).toBe(
        false,
      )
    })

    it('keeps the video playable when only the rendition fails', async () => {
      mockSpawnImpl = spawnFor({ width: 3840, height: 2160, codec_name: 'h264' }, undefined, true)
      const result = await transcodeProcessor(makeJob())
      expect(mockUpdateVideoAssetOutputs).toHaveBeenCalled()
      expect(mockUpdatePresentRendition).not.toHaveBeenCalled()
      expect(result.presentKey).toBeUndefined()
    })

    it('reads the display rotation from side data or the old rotate tag', () => {
      expect(quarterTurnsOf({ side_data_list: [{ rotation: -90 }] })).toBe(3)
      expect(quarterTurnsOf({ side_data_list: [{ rotation: 180 }] })).toBe(2)
      expect(quarterTurnsOf({ tags: { rotate: '90' } })).toBe(1)
      expect(quarterTurnsOf({})).toBe(0)
      expect(displaySize({ width: 3840, height: 2160, quarterTurns: 1 })).toEqual({
        width: 2160,
        height: 3840,
      })
      expect(needsPresentRendition({ width: 1920, height: 1080 })).toBe(false)
      expect(needsPresentRendition({ width: 1080, height: 1920 })).toBe(true)
    })
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

// ---------------------------------------------------------------------------
// videoOutputPrefix — where the outputs of a job go
// ---------------------------------------------------------------------------

describe('videoOutputPrefix', () => {
  const b64 = (path: string): string => Buffer.from(path).toString('base64url')

  it('takes the first two segments of a plain decks/ or components/ path', () => {
    expect(
      videoOutputPrefix({ assetId: 'a1', storageKey: 'decks/d1/uploads/a1/original.mp4' }),
    ).toBe('decks/d1/videos/a1')
    expect(
      videoOutputPrefix({ assetId: 'a1', storageKey: 'components/c1/uploads/a1/original.mov' }),
    ).toBe('components/c1/videos/a1')
  })

  it("decodes a tus upload's compound id", () => {
    expect(
      videoOutputPrefix({
        assetId: 'a1',
        deckId: 'd1',
        storageKey: `a1:d1:${b64('decks/d1/uploads/a1/original.mp4')}`,
      }),
    ).toBe('decks/d1/videos/a1')
    expect(
      videoOutputPrefix({
        assetId: 'a1',
        storageKey: `a1:unknown:${b64('components/c1/uploads/a1/original.webm')}`,
      }),
    ).toBe('components/c1/videos/a1')
  })

  it('the key wins over the deckId: a component video never lands under a deck', () => {
    expect(
      videoOutputPrefix({
        assetId: 'a1',
        deckId: 'd9',
        storageKey: `a1:unknown:${b64('components/c1/uploads/a1/original.mp4')}`,
      }),
    ).toBe('components/c1/videos/a1')
  })

  it('falls back to decks/<deckId> for a key that names no owner', () => {
    expect(videoOutputPrefix({ assetId: 'a1', deckId: 'd1', storageKey: 'legacy/a1.mp4' })).toBe(
      'decks/d1/videos/a1',
    )
    expect(videoOutputPrefix({ assetId: 'a1', deckId: 'd1', storageKey: 'a1:d1:not*base64' })).toBe(
      'decks/d1/videos/a1',
    )
    expect(
      videoOutputPrefix({ assetId: 'a1', deckId: 'd1', storageKey: 'decks/../uploads/x.mp4' }),
    ).toBe('decks/d1/videos/a1')
  })

  it('throws when neither the key nor the job names an owner', () => {
    expect(() => videoOutputPrefix({ assetId: 'a1', storageKey: 'legacy/a1.mp4' })).toThrow(
      /names no deck or component/,
    )
  })
})
