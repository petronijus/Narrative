/**
 * tests/agent-eval/lib/png.ts — a tiny PNG encoder, so fixtures can upload
 * a real image (the crop scenario needs an image object whose asset exists,
 * or the exported deck and the editor show a broken picture) without
 * shipping a binary fixture.
 */

import { deflateSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  const typeBytes = new TextEncoder().encode(type)
  out.set(typeBytes, 4)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/** An RGB PNG of `width` x `height` whose pixels `colour(x, y)` gives. */
function rgbPng(
  width: number,
  height: number,
  colour: (x: number, y: number) => readonly [number, number, number],
): Uint8Array {
  const stride = width * 3 + 1
  const raw = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0 // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = colour(x, y)
      const i = y * stride + 1 + x * 3
      raw[i] = r
      raw[i + 1] = g
      raw[i + 2] = b
    }
  }
  const header = new Uint8Array(13)
  const hv = new DataView(header.buffer)
  hv.setUint32(0, width)
  hv.setUint32(4, height)
  header[8] = 8 // bit depth
  header[9] = 2 // colour type: RGB
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array(0)),
  ]
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/**
 * An RGB PNG of `width` x `height` with a diagonal two-colour gradient and a
 * grid, so a crop offset is visible when someone looks at the deck.
 */
export function gradientPng(width: number, height: number): Uint8Array {
  return rgbPng(width, height, (x, y) => {
    const t = (x / width + y / height) / 2
    if (x % 50 === 0 || y % 50 === 0) return [255, 255, 255]
    return [Math.round(30 + 200 * t), Math.round(90 + 60 * (1 - t)), Math.round(200 - 150 * t)]
  })
}

/** An RGB PNG of one colour — a fact only someone who looks at the picture can tell. */
export function solidPng(
  width: number,
  height: number,
  rgb: readonly [number, number, number],
): Uint8Array {
  return rgbPng(width, height, () => rgb)
}
