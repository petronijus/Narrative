/**
 * media/assets.test.ts
 *
 * CRUD tests for media_assets helpers.
 * Uses a mock Drizzle DB — no real Postgres connection.
 *
 * Mock strategy: replicate the builder-chain pattern from decks.test.ts.
 * Each function test provides its own mock to keep fixtures local.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Database } from '../db/client.js'
import type { MediaAsset } from '../db/schema.js'
import {
  createMediaAsset,
  getMediaAsset,
  listMediaAssets,
  deleteMediaAsset,
  getVideoAsset,
  updateTranscodeStatus,
  updateVideoAssetOutputs,
  type CreateMediaAssetArgs,
  type VideoAssetRow,
} from './assets.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const now = new Date('2026-04-20T10:00:00Z')

const sampleAsset: MediaAsset = {
  id: 'asset-abc123',
  deckId: 'deck-1',
  folderId: null,
  uploaderUserId: 'user-42',
  mimeType: 'image/jpeg',
  sizeBytes: 204800,
  storageKey: 'decks/deck-1/uploads/asset-abc123/original.jpg',
  originalFilename: 'mountain.jpg',
  width: 1920,
  height: 1080,
  createdAt: now,
  // M12 additions — image defaults
  kind: 'image',
  durationSec: null,
  hlsManifestKey: null,
  posterKey: null,
  thumbnailKey: null,
  transcodeStatus: null,
  transcodeError: null,
  fontFamily: null,
  fontWeight: null,
  fontStyle: null,
  fontPostscriptName: null,
}

const sampleVideoAsset: MediaAsset = {
  id: 'asset-vid-001',
  deckId: 'deck-1',
  folderId: null,
  uploaderUserId: 'user-42',
  mimeType: 'video/mp4',
  sizeBytes: 10485760,
  storageKey: 'decks/deck-1/uploads/asset-vid-001/original.mp4',
  originalFilename: 'demo.mp4',
  width: null,
  height: null,
  createdAt: now,
  kind: 'video',
  durationSec: null,
  hlsManifestKey: null,
  posterKey: null,
  thumbnailKey: null,
  transcodeStatus: 'pending',
  transcodeError: null,
  fontFamily: null,
  fontWeight: null,
  fontStyle: null,
  fontPostscriptName: null,
}

const sampleArgs: CreateMediaAssetArgs = {
  id: 'asset-abc123',
  deckId: 'deck-1',
  uploaderUserId: 'user-42',
  mimeType: 'image/jpeg',
  sizeBytes: 204800,
  storageKey: 'decks/deck-1/uploads/asset-abc123/original.jpg',
  originalFilename: 'mountain.jpg',
  width: 1920,
  height: 1080,
  // kind omitted — should default to 'image'
}

// ---------------------------------------------------------------------------
// Mock DB helpers
// ---------------------------------------------------------------------------

/**
 * Builds a minimal Drizzle-shaped mock for createMediaAsset.
 * The function calls db.insert(mediaAssets).values({...}).
 */
function makeMockDbForInsert(): { db: Database; valuesMock: ReturnType<typeof vi.fn> } {
  const valuesMock = vi.fn().mockResolvedValue([])
  const db = {
    insert: vi.fn().mockReturnValue({ values: valuesMock }),
  } as unknown as Database
  return { db, valuesMock }
}

/**
 * Builds a mock for getMediaAsset / listMediaAssets.
 * The functions call db.select().from(table).where(...).limit(n) or
 * db.select().from(table).where(...).
 */
function makeMockDbForSelect(rows: MediaAsset[]): Database {
  // Chain: select() → from() → where() → limit() or thenable
  const limitMock = vi.fn().mockResolvedValue(rows.slice(0, 1))
  const whereMock = vi.fn().mockReturnValue({
    limit: limitMock,
    // listMediaAssets awaits the where() result directly (no limit)
    then: (resolve: (v: MediaAsset[]) => void) => Promise.resolve(rows).then(resolve),
  })
  const fromMock = vi.fn().mockReturnValue({ where: whereMock })
  const db = {
    select: vi.fn().mockReturnValue({ from: fromMock }),
  } as unknown as Database
  return db
}

/**
 * Builds a mock for deleteMediaAsset.
 * The function calls db.delete(table).where(...).
 */
function makeMockDbForDelete(): { db: Database; whereMock: ReturnType<typeof vi.fn> } {
  const whereMock = vi.fn().mockResolvedValue([])
  const db = {
    delete: vi.fn().mockReturnValue({ where: whereMock }),
  } as unknown as Database
  return { db, whereMock }
}

/**
 * Builds a mock for update helpers (updateTranscodeStatus, updateVideoAssetOutputs).
 * The functions call db.update(table).set({...}).where(...).
 */
function makeMockDbForUpdate(): {
  db: Database
  setMock: ReturnType<typeof vi.fn>
  whereMock: ReturnType<typeof vi.fn>
} {
  const whereMock = vi.fn().mockResolvedValue([])
  const setMock = vi.fn().mockReturnValue({ where: whereMock })
  const db = {
    update: vi.fn().mockReturnValue({ set: setMock }),
  } as unknown as Database
  return { db, setMock, whereMock }
}

/**
 * Builds a mock for getVideoAsset — uses select with both where conditions chained.
 * The function calls db.select().from(table).where(and(...)).limit(1).
 */
function makeMockDbForVideoSelect(rows: MediaAsset[]): Database {
  const limitMock = vi.fn().mockResolvedValue(rows.slice(0, 1))
  const whereMock = vi.fn().mockReturnValue({ limit: limitMock })
  const fromMock = vi.fn().mockReturnValue({ where: whereMock })
  const db = {
    select: vi.fn().mockReturnValue({ from: fromMock }),
  } as unknown as Database
  return db
}

// ---------------------------------------------------------------------------
// createMediaAsset
// ---------------------------------------------------------------------------

describe('createMediaAsset', () => {
  beforeEach(() => vi.clearAllMocks())

  it('calls insert with correct values', async () => {
    const { db, valuesMock } = makeMockDbForInsert()

    await createMediaAsset(db, sampleArgs)

    expect(valuesMock).toHaveBeenCalledOnce()
    const inserted = valuesMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(inserted['id']).toBe('asset-abc123')
    expect(inserted['deckId']).toBe('deck-1')
    expect(inserted['uploaderUserId']).toBe('user-42')
    expect(inserted['mimeType']).toBe('image/jpeg')
    expect(inserted['sizeBytes']).toBe(204800)
    expect(inserted['storageKey']).toBe('decks/deck-1/uploads/asset-abc123/original.jpg')
    expect(inserted['originalFilename']).toBe('mountain.jpg')
    expect(inserted['width']).toBe(1920)
    expect(inserted['height']).toBe(1080)
  })

  it('maps missing optional fields to null', async () => {
    const { db, valuesMock } = makeMockDbForInsert()

    const minimalArgs: CreateMediaAssetArgs = {
      id: 'asset-min',
      deckId: 'deck-1',
      uploaderUserId: 'user-1',
      mimeType: 'image/png',
      sizeBytes: 1024,
      storageKey: 'decks/deck-1/uploads/asset-min/original.png',
    }

    await createMediaAsset(db, minimalArgs)

    const inserted = valuesMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(inserted['originalFilename']).toBeNull()
    expect(inserted['width']).toBeNull()
    expect(inserted['height']).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// getMediaAsset
// ---------------------------------------------------------------------------

describe('getMediaAsset', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns the asset when found', async () => {
    const db = makeMockDbForSelect([sampleAsset])

    const result = await getMediaAsset(db, 'asset-abc123')

    expect(result).toEqual(sampleAsset)
  })

  it('returns null when asset not found', async () => {
    const db = makeMockDbForSelect([])

    const result = await getMediaAsset(db, 'nonexistent')

    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// listMediaAssets
// ---------------------------------------------------------------------------

describe('listMediaAssets', () => {
  beforeEach(() => vi.clearAllMocks())

  const secondAsset: MediaAsset = {
    ...sampleAsset,
    id: 'asset-def456',
    storageKey: 'decks/deck-1/uploads/asset-def456/original.png',
    mimeType: 'image/png',
  }

  it('returns all assets for a deck', async () => {
    // listMediaAssets awaits the where() chain directly — mock the thenable
    const assets = [sampleAsset, secondAsset]
    const whereMock = vi.fn().mockReturnValue(Promise.resolve(assets))
    const fromMock = vi.fn().mockReturnValue({ where: whereMock })
    const db = {
      select: vi.fn().mockReturnValue({ from: fromMock }),
    } as unknown as Database

    const result = await listMediaAssets(db, 'deck-1')

    expect(result).toHaveLength(2)
    expect(result[0]?.id).toBe('asset-abc123')
    expect(result[1]?.id).toBe('asset-def456')
  })

  it('returns empty array for a deck with no assets', async () => {
    const whereMock = vi.fn().mockReturnValue(Promise.resolve([]))
    const fromMock = vi.fn().mockReturnValue({ where: whereMock })
    const db = {
      select: vi.fn().mockReturnValue({ from: fromMock }),
    } as unknown as Database

    const result = await listMediaAssets(db, 'deck-empty')

    expect(result).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// deleteMediaAsset
// ---------------------------------------------------------------------------

describe('deleteMediaAsset', () => {
  beforeEach(() => vi.clearAllMocks())

  it('calls delete with the correct id filter', async () => {
    const { db, whereMock } = makeMockDbForDelete()

    await deleteMediaAsset(db, 'asset-abc123')

    expect(whereMock).toHaveBeenCalledOnce()
  })

  it('does not throw when asset does not exist (no-op at DB level)', async () => {
    const { db } = makeMockDbForDelete()

    await expect(deleteMediaAsset(db, 'nonexistent')).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// createMediaAsset — kind field (M12)
// ---------------------------------------------------------------------------

describe('createMediaAsset — kind field (M12)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('defaults kind to image when omitted', async () => {
    const { db, valuesMock } = makeMockDbForInsert()

    await createMediaAsset(db, sampleArgs)

    const inserted = valuesMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(inserted['kind']).toBe('image')
    expect(inserted['transcodeStatus']).toBeNull()
  })

  it('passes kind=video and transcodeStatus=pending for video uploads', async () => {
    const { db, valuesMock } = makeMockDbForInsert()

    await createMediaAsset(db, {
      id: 'asset-vid-001',
      deckId: 'deck-1',
      uploaderUserId: 'user-42',
      mimeType: 'video/mp4',
      sizeBytes: 10485760,
      storageKey: 'decks/deck-1/uploads/asset-vid-001/original.mp4',
      kind: 'video',
      transcodeStatus: 'pending',
    })

    const inserted = valuesMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(inserted['kind']).toBe('video')
    expect(inserted['transcodeStatus']).toBe('pending')
  })
})

// ---------------------------------------------------------------------------
// getVideoAsset (M12)
// ---------------------------------------------------------------------------

describe('getVideoAsset', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns VideoAssetRow when kind=video', async () => {
    const db = makeMockDbForVideoSelect([sampleVideoAsset])

    const result = await getVideoAsset(db, 'asset-vid-001')

    expect(result).not.toBeNull()
    expect(result!.id).toBe('asset-vid-001')
    expect(result!.mimeType).toBe('video/mp4')
    expect(result!.transcodeStatus).toBe('pending')
    expect(result!.hlsManifestKey).toBeNull()
  })

  it('returns null when no row found (e.g., image asset queried as video)', async () => {
    // Simulate DB returning empty — the where(and(kind='video')) filtered it out
    const db = makeMockDbForVideoSelect([])

    const result = await getVideoAsset(db, 'asset-abc123')

    expect(result).toBeNull()
  })

  it('maps all VideoAssetRow fields correctly', async () => {
    const doneVideoAsset: MediaAsset = {
      ...sampleVideoAsset,
      id: 'asset-vid-done',
      width: 1920,
      height: 1080,
      durationSec: 142,
      hlsManifestKey: 'decks/deck-1/videos/asset-vid-done/master.m3u8',
      posterKey: 'decks/deck-1/videos/asset-vid-done/poster.jpg',
      thumbnailKey: 'decks/deck-1/videos/asset-vid-done/thumb.jpg',
      transcodeStatus: 'done',
      transcodeError: null,
    }
    const db = makeMockDbForVideoSelect([doneVideoAsset])

    const result = await getVideoAsset(db, 'asset-vid-done')

    expect(result).not.toBeNull()
    expect(result!.durationSec).toBe(142)
    expect(result!.hlsManifestKey).toBe('decks/deck-1/videos/asset-vid-done/master.m3u8')
    expect(result!.posterKey).toBe('decks/deck-1/videos/asset-vid-done/poster.jpg')
    expect(result!.thumbnailKey).toBe('decks/deck-1/videos/asset-vid-done/thumb.jpg')
    expect(result!.transcodeStatus).toBe('done')
    expect(result!.width).toBe(1920)
    expect(result!.height).toBe(1080)
  })
})

// ---------------------------------------------------------------------------
// updateTranscodeStatus (M12)
// ---------------------------------------------------------------------------

describe('updateTranscodeStatus', () => {
  beforeEach(() => vi.clearAllMocks())

  it('sets transcodeStatus to processing with no error', async () => {
    const { db, setMock } = makeMockDbForUpdate()

    await updateTranscodeStatus(db, 'asset-vid-001', 'processing')

    expect(setMock).toHaveBeenCalledOnce()
    const setArg = setMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(setArg['transcodeStatus']).toBe('processing')
    expect(setArg['transcodeError']).toBeNull()
  })

  it('sets transcodeStatus to failed with error message', async () => {
    const { db, setMock } = makeMockDbForUpdate()

    await updateTranscodeStatus(db, 'asset-vid-001', 'failed', 'ffmpeg exit code 1')

    const setArg = setMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(setArg['transcodeStatus']).toBe('failed')
    expect(setArg['transcodeError']).toBe('ffmpeg exit code 1')
  })

  it('sets transcodeStatus to done with null error', async () => {
    const { db, setMock } = makeMockDbForUpdate()

    await updateTranscodeStatus(db, 'asset-vid-001', 'done')

    const setArg = setMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(setArg['transcodeStatus']).toBe('done')
    expect(setArg['transcodeError']).toBeNull()
  })

  it('calls where filter with the asset id', async () => {
    const { db, whereMock } = makeMockDbForUpdate()

    await updateTranscodeStatus(db, 'asset-vid-001', 'processing')

    expect(whereMock).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// updateVideoAssetOutputs (M12)
// ---------------------------------------------------------------------------

describe('updateVideoAssetOutputs', () => {
  beforeEach(() => vi.clearAllMocks())

  const outputs = {
    hlsManifestKey: 'decks/deck-1/videos/asset-vid-001/master.m3u8',
    posterKey: 'decks/deck-1/videos/asset-vid-001/poster.jpg',
    thumbnailKey: 'decks/deck-1/videos/asset-vid-001/thumb.jpg',
    durationSec: 90,
    width: 1280,
    height: 720,
  }

  it('sets all six output fields + transcodeStatus=done atomically', async () => {
    const { db, setMock } = makeMockDbForUpdate()

    await updateVideoAssetOutputs(db, 'asset-vid-001', outputs)

    expect(setMock).toHaveBeenCalledOnce()
    const setArg = setMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(setArg['hlsManifestKey']).toBe(outputs.hlsManifestKey)
    expect(setArg['posterKey']).toBe(outputs.posterKey)
    expect(setArg['thumbnailKey']).toBe(outputs.thumbnailKey)
    expect(setArg['durationSec']).toBe(90)
    expect(setArg['width']).toBe(1280)
    expect(setArg['height']).toBe(720)
    expect(setArg['transcodeStatus']).toBe('done')
    expect(setArg['transcodeError']).toBeNull()
  })

  it('calls where filter with the asset id', async () => {
    const { db, whereMock } = makeMockDbForUpdate()

    await updateVideoAssetOutputs(db, 'asset-vid-001', outputs)

    expect(whereMock).toHaveBeenCalledOnce()
  })

  it('is a single DB call (atomic)', async () => {
    const { db, setMock } = makeMockDbForUpdate()

    await updateVideoAssetOutputs(db, 'asset-vid-001', outputs)

    // Exactly one set() call — all fields in one update
    expect(setMock).toHaveBeenCalledTimes(1)
  })
})
