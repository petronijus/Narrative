/**
 * media/enqueue.test.ts
 *
 * Tests for enqueueVideoTranscode() and closeQueueConnection() in enqueue.ts.
 *
 * BullMQ and ioredis are mocked — no real Redis connection required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { VideoTranscodeJobData } from '@narrative/shared'

// ---------------------------------------------------------------------------
// Hoisted mocks (variables referenced inside vi.mock factories must use vi.hoisted)
// ---------------------------------------------------------------------------

const { mockAdd, mockClose, MockQueue, MockIORedis } = vi.hoisted(() => {
  const mockAdd = vi.fn().mockResolvedValue({ id: 'job-1' })
  const mockClose = vi.fn().mockResolvedValue(undefined)
  const MockQueue = vi.fn().mockImplementation(function () {
    return { add: mockAdd, close: mockClose }
  })
  const MockIORedis = vi.fn().mockImplementation(function () {
    return {}
  })
  return { mockAdd, mockClose, MockQueue, MockIORedis }
})

vi.mock('bullmq', () => ({ Queue: MockQueue }))
vi.mock('ioredis', () => ({ default: MockIORedis, Redis: MockIORedis }))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const JOB_DATA: VideoTranscodeJobData = {
  assetId: 'asset-abc123',
  deckId: 'deck-xyz',
  storageKey: 'decks/deck-xyz/uploads/asset-abc123/original.mp4',
  uploaderUserId: 'user-1',
  mimeType: 'video/mp4',
}

// ---------------------------------------------------------------------------
// Tests
//
// Each test re-imports enqueue.ts via dynamic import after vi.resetModules()
// to clear the queue singleton between tests.
// ---------------------------------------------------------------------------

async function importEnqueue() {
  const mod = await import('./enqueue.js')
  return mod
}

describe('enqueueVideoTranscode', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('calls queue.add with correct queue name, job name, and data', async () => {
    const { enqueueVideoTranscode } = await importEnqueue()
    await enqueueVideoTranscode(JOB_DATA)

    expect(mockAdd).toHaveBeenCalledTimes(1)
    expect(mockAdd).toHaveBeenCalledWith(
      'transcode',
      JOB_DATA,
      expect.objectContaining({
        attempts: 3,
        backoff: expect.objectContaining({ type: 'exponential' }),
      }),
    )
  })

  it('creates a Queue with VIDEO_TRANSCODE_QUEUE name', async () => {
    const { enqueueVideoTranscode } = await importEnqueue()
    await enqueueVideoTranscode(JOB_DATA)

    expect(MockQueue).toHaveBeenCalledWith(
      'video-transcode',
      expect.objectContaining({ connection: expect.anything() }),
    )
  })

  it('reuses the same Queue instance across multiple calls (singleton)', async () => {
    const { enqueueVideoTranscode } = await importEnqueue()
    await enqueueVideoTranscode(JOB_DATA)
    await enqueueVideoTranscode(JOB_DATA)

    // Queue constructor called only once
    expect(MockQueue).toHaveBeenCalledTimes(1)
    expect(mockAdd).toHaveBeenCalledTimes(2)
  })

  it('includes removeOnComplete and removeOnFail job options', async () => {
    const { enqueueVideoTranscode } = await importEnqueue()
    await enqueueVideoTranscode(JOB_DATA)

    expect(mockAdd).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({
        removeOnComplete: expect.anything(),
        removeOnFail: expect.anything(),
      }),
    )
  })
})

describe('closeQueueConnection', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('calls queue.close() when a queue exists', async () => {
    const { enqueueVideoTranscode, closeQueueConnection } = await importEnqueue()
    await enqueueVideoTranscode(JOB_DATA)
    vi.clearAllMocks()

    await closeQueueConnection()

    expect(mockClose).toHaveBeenCalledTimes(1)
  })

  it('is idempotent — second call does nothing', async () => {
    const { enqueueVideoTranscode, closeQueueConnection } = await importEnqueue()
    await enqueueVideoTranscode(JOB_DATA)
    await closeQueueConnection()
    vi.clearAllMocks()

    // Second close — queue is null, should not throw
    await expect(closeQueueConnection()).resolves.toBeUndefined()
    expect(mockClose).not.toHaveBeenCalled()
  })
})
