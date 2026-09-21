/**
 * lib/fontFileMetrics.test.ts
 *
 * A hand-built sfnt with just `head`, `hhea` and `OS/2`, using Proseware Pro's
 * real numbers: hhea 964/−198/0 and typo 704/−198/75 with USE_TYPO_METRICS
 * set. The point of the whole module is that PowerPoint uses the first and
 * the browser the second, so both must come out exactly.
 */

import { describe, it, expect } from 'vitest'
import { readFontVerticalMetrics, powerpointLineHeightRatio } from './fontFileMetrics.js'

interface Table {
  tag: string
  data: Uint8Array
}

function buildSfnt(tables: Table[], magic = 0x00010000): ArrayBuffer {
  const headerLen = 12 + tables.length * 16
  let offset = headerLen
  const placed = tables.map((t) => {
    const at = offset
    offset += (t.data.length + 3) & ~3
    return { ...t, at }
  })
  const buf = new ArrayBuffer(offset)
  const view = new DataView(buf)
  const bytes = new Uint8Array(buf)
  view.setUint32(0, magic)
  view.setUint16(4, tables.length)
  placed.forEach((t, i) => {
    const rec = 12 + i * 16
    for (let k = 0; k < 4; k++) view.setUint8(rec + k, t.tag.charCodeAt(k))
    view.setUint32(rec + 8, t.at)
    view.setUint32(rec + 12, t.data.length)
    bytes.set(t.data, t.at)
  })
  return buf
}

function head(unitsPerEm: number): Uint8Array {
  const d = new Uint8Array(54)
  new DataView(d.buffer).setUint16(18, unitsPerEm)
  return d
}

function hhea(asc: number, desc: number, gap: number): Uint8Array {
  const d = new Uint8Array(36)
  const v = new DataView(d.buffer)
  v.setInt16(4, asc)
  v.setInt16(6, desc)
  v.setInt16(8, gap)
  return d
}

function os2(opts: { useTypo: boolean; asc: number; desc: number; gap: number }): Uint8Array {
  const d = new Uint8Array(96)
  const v = new DataView(d.buffer)
  v.setUint16(62, opts.useTypo ? 0x80 : 0)
  v.setInt16(68, opts.asc)
  v.setInt16(70, opts.desc)
  v.setInt16(72, opts.gap)
  return d
}

describe('readFontVerticalMetrics', () => {
  it('reads hhea and OS/2 from a TrueType-flavoured sfnt', async () => {
    const buf = buildSfnt([
      { tag: 'head', data: head(1000) },
      { tag: 'hhea', data: hhea(964, -198, 0) },
      { tag: 'OS/2', data: os2({ useTypo: true, asc: 704, desc: -198, gap: 75 }) },
    ])
    const m = await readFontVerticalMetrics(buf)
    expect(m).toEqual({
      unitsPerEm: 1000,
      hheaAscender: 964,
      hheaDescender: -198,
      hheaLineGap: 0,
      useTypoMetrics: true,
      typoAscender: 704,
      typoDescender: -198,
      typoLineGap: 75,
    })
    // PowerPoint's single spacing for Proseware Pro — not the 0.977 the
    // browser derives from the typo metrics.
    expect(powerpointLineHeightRatio(m!)).toBeCloseTo(1.162, 6)
  })

  it('accepts the OpenType (CFF) and Apple magics too', async () => {
    for (const magic of [0x4f54544f, 0x74727565]) {
      const buf = buildSfnt(
        [
          { tag: 'head', data: head(2048) },
          { tag: 'hhea', data: hhea(1854, -434, 67) },
        ],
        magic,
      )
      const m = await readFontVerticalMetrics(buf)
      expect(m?.unitsPerEm).toBe(2048)
      // Arial's numbers: 1.15 em, the same as the browser reports for it.
      expect(powerpointLineHeightRatio(m!)).toBeCloseTo(1.15, 2)
    }
  })

  it('returns null for WOFF2, unknown containers and fonts missing hhea', async () => {
    const wof2 = new ArrayBuffer(48)
    new DataView(wof2).setUint32(0, 0x774f4632)
    expect(await readFontVerticalMetrics(wof2)).toBeNull()

    expect(await readFontVerticalMetrics(new ArrayBuffer(4))).toBeNull()

    const noHhea = buildSfnt([{ tag: 'head', data: head(1000) }])
    expect(await readFontVerticalMetrics(noHhea)).toBeNull()
  })

  it('does not throw on a truncated directory', async () => {
    const buf = buildSfnt([
      { tag: 'head', data: head(1000) },
      { tag: 'hhea', data: hhea(900, -200, 100) },
    ])
    const cut = buf.slice(0, 40)
    expect(await readFontVerticalMetrics(cut)).toBeNull()
  })
})
