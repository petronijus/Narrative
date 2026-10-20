import { describe, expect, it } from 'vitest'
import {
  netBucket,
  percentile,
  routeOf,
  settleInputs,
  sourceSize,
  texUploadPixels,
} from './measure'

describe('texUploadPixels', () => {
  it('reads width and height of the 9-argument overloads', () => {
    expect(texUploadPixels('texImage2D', [0, 0, 0, 640, 480, 0, 0, 0, new Uint8Array(4)])).toBe(
      307_200,
    )
    expect(texUploadPixels('texSubImage2D', [0, 0, 10, 20, 64, 32, 0, 0, new Uint8Array(4)])).toBe(
      2048,
    )
  })

  it('treats a texImage2D without data as an allocation, not an upload', () => {
    expect(texUploadPixels('texImage2D', [0, 0, 0, 640, 480, 0, 0, 0, null])).toBeNull()
  })

  it('reads the source of the short overloads', () => {
    const img = { naturalWidth: 300, naturalHeight: 200, width: 30, height: 20 }
    expect(texUploadPixels('texImage2D', [0, 0, 0, 0, 0, img])).toBe(60_000)
    const canvas = { width: 10, height: 10 }
    expect(texUploadPixels('texSubImage2D', [0, 0, 0, 0, 0, 0, canvas])).toBe(100)
  })

  it('is null for an overload it does not know', () => {
    expect(texUploadPixels('texImage2D', [0, 0])).toBeNull()
  })
})

describe('sourceSize', () => {
  it('prefers the intrinsic size of a video', () => {
    expect(sourceSize({ videoWidth: 1920, videoHeight: 1080, width: 300, height: 150 })).toEqual({
      width: 1920,
      height: 1080,
    })
  })

  it('falls back to width/height, and is null for anything without a size', () => {
    expect(sourceSize({ displayWidth: 0, displayHeight: 0, width: 4, height: 2 })).toEqual({
      width: 4,
      height: 2,
    })
    expect(sourceSize(null)).toBeNull()
    expect(sourceSize({})).toBeNull()
  })
})

describe('routeOf / netBucket', () => {
  const origin = 'http://localhost:5173'

  it('replaces ids by :id and keeps the rest of the path', () => {
    expect(routeOf('/api/media/abc123XYZ_q/url?x=1', origin)).toBe('/api/media/:id/url')
    expect(routeOf('http://localhost:5173/api/decks/GoYLg0H4-wSp', origin)).toBe('/api/decks/:id')
    expect(routeOf('/api/decks', origin)).toBe('/api/decks')
  })

  it('folds build assets and dev modules', () => {
    expect(routeOf('/assets/index-Ab12Cd34.js', origin)).toBe('/assets/*')
    expect(routeOf('/src/main.tsx?t=1', origin)).toBe('/(dev module)')
  })

  it('names the host of another origin', () => {
    expect(routeOf('https://fonts.example.com/inter.woff2', origin)).toBe(
      'fonts.example.com/inter.woff2',
    )
  })

  it('buckets routes', () => {
    expect(netBucket('/api/media/:id/url')).toBe('net.mediaUrl')
    expect(netBucket('/api/decks/:id')).toBe('net.api')
    expect(netBucket('/imgproxy/:id')).toBe('net.imgproxy')
    expect(netBucket('/storage/media/x.jpg')).toBe('net.storage')
    expect(netBucket('/assets/*')).toBe('net.code')
    expect(netBucket('/favicon.svg')).toBe('net.other')
  })
})

describe('settleInputs', () => {
  it('resolves the inputs before the frame and keeps the later ones waiting', () => {
    const { resolved, waiting } = settleInputs(
      [
        { type: 'pointermove', at: 100 },
        { type: 'pointermove', at: 110 },
        { type: 'pointermove', at: 130 },
      ],
      120,
      150,
      'canvas',
    )
    expect(resolved).toEqual([
      { type: 'pointermove', ms: 50, via: 'canvas' },
      { type: 'pointermove', ms: 40, via: 'canvas' },
    ])
    expect(waiting).toEqual([{ type: 'pointermove', at: 130 }])
  })
})

describe('percentile', () => {
  it('is the nearest rank', () => {
    expect(percentile([5, 1, 4, 2, 3], 0.5)).toBe(3)
    expect(percentile([5, 1, 4, 2, 3], 0.9)).toBe(5)
    expect(percentile([5, 1, 4, 2, 3], 1)).toBe(5)
    expect(percentile([], 0.5)).toBe(0)
  })
})
