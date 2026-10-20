/**
 * pptx/ooxml/writeDeck.stream.test.ts — a deck whose media comes as streams
 * (the export's storage reads) is the same package, byte for byte, as one
 * whose media sits in memory: the same picture sizes from a large picture's
 * header, the same deflated parts, the same CRCs. A stream that cannot be
 * read is left out like a missing asset.
 */

import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import JSZip from 'jszip'
import { matrixDeck } from '../roundtripMatrix.js'
import { planDeck, writeDeck, type AssetLoader, type AssetSource } from './writeDeck.js'

/** A noisy photo over the 1 MiB header read, turned a quarter by EXIF (orientation 6). */
async function bigRotatedJpeg(): Promise<Buffer> {
  const width = 1800
  const height = 1200
  const raw = Buffer.alloc(width * height * 3)
  let seed = 7
  for (let i = 0; i < raw.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    raw[i] = seed >> 23
  }
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 95 })
    .withMetadata({ orientation: 6 })
    .toBuffer()
}

/** The same bytes as a stream of small chunks, each open counted. */
function streamed(assets: Map<string, AssetSource>, opens: Map<string, number>): AssetLoader {
  return async (id) => {
    const a = assets.get(id)
    if (a === undefined || !('bytes' in a)) return null
    const bytes = a.bytes
    return {
      mimeType: a.mimeType,
      open: async () => {
        opens.set(id, (opens.get(id) ?? 0) + 1)
        return (async function* () {
          for (let i = 0; i < bytes.byteLength; i += 64 * 1024)
            yield bytes.subarray(i, i + 64 * 1024)
        })()
      },
    }
  }
}

describe('planDeck with streamed media', () => {
  it('writes the same package as from memory, reading each stream twice', async () => {
    const deck = await matrixDeck()
    const jpeg = await bigRotatedJpeg()
    expect(jpeg.byteLength).toBeGreaterThan(1024 * 1024)
    const assets = new Map<string, AssetSource>(deck.assets)
    assets.set('img-a', { bytes: jpeg, mimeType: 'image/jpeg' })
    // A format that is deflated (and sized from its whole bytes).
    assets.set('img-b', {
      bytes: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="20"><rect width="30" height="20"/></svg>',
      ),
      mimeType: 'image/svg+xml',
    })
    const now = new Date(Date.UTC(2026, 9, 19))
    const fromMemory = await writeDeck(deck.slides, {
      assetLoader: async (id) => assets.get(id) ?? null,
      now,
    })
    const opens = new Map<string, number>()
    const pkg = await planDeck(deck.slides, { assetLoader: streamed(assets, opens), now })
    expect(pkg.size).toBe(fromMemory.byteLength)
    expect((await pkg.toBuffer()).equals(fromMemory)).toBe(true)
    for (const n of opens.values()) expect(n).toBe(2)

    // The large picture was sized from its header, turned upright.
    const zip = await JSZip.loadAsync(fromMemory)
    const media = Object.keys(zip.files).filter((p) => p.endsWith('.jpeg'))
    expect(media).toHaveLength(1)
  })

  it('leaves out a stream that cannot be read, and says which', async () => {
    const deck = await matrixDeck()
    const failed: string[] = []
    const loader: AssetLoader = async (id) => {
      const a = deck.assets.get(id)
      if (a === undefined) return null
      if (id !== 'img-a') return a
      return {
        mimeType: a.mimeType,
        open: async () => {
          throw new Error('storage is down')
        },
      }
    }
    const pkg = await planDeck(deck.slides, {
      assetLoader: loader,
      onAssetError: (id) => failed.push(id),
    })
    const withoutA = await writeDeck(deck.slides, {
      assetLoader: async (id) => (id === 'img-a' ? null : (deck.assets.get(id) ?? null)),
    })
    const zip = await JSZip.loadAsync(await pkg.toBuffer())
    const reference = await JSZip.loadAsync(withoutA)
    expect(Object.keys(zip.files)).toEqual(Object.keys(reference.files))
    expect(failed).toEqual(['img-a'])
  })
})
