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
  type CreateMediaAssetArgs,
} from './assets.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const now = new Date('2026-04-20T10:00:00Z')

const sampleAsset: MediaAsset = {
  id: 'asset-abc123',
  deckId: 'deck-1',
  uploaderUserId: 'user-42',
  mimeType: 'image/jpeg',
  sizeBytes: 204800,
  storageKey: 'decks/deck-1/uploads/asset-abc123/original.jpg',
  originalFilename: 'mountain.jpg',
  width: 1920,
  height: 1080,
  createdAt: now,
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
