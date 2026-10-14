/**
 * lib/fontFileMetrics.ts
 *
 * Reads a font file's own vertical metrics — the ones PowerPoint lays lines
 * out with — because no browser API will hand them over for every font.
 *
 * PowerPoint's "single" line spacing is `hhea.ascender − hhea.descender +
 * hhea.lineGap`, in ems. Chrome's `line-height: normal` agrees for most
 * fonts, but when a font sets OS/2 `USE_TYPO_METRICS` the browser switches
 * to the typo metrics and the two part ways: Brand Sans declares hhea
 * 964/−198/0 (1.162 em) and typo 704/−198/75 (0.977 em), so a frame
 * PowerPoint sized for 1.162 would be laid out here at 0.977 — 16% shorter,
 * far worse than the flat 1.2 this replaces. The canvas `fontBoundingBox`
 * is no help either (0.902 for the same face).
 *
 * The folder-font loader already downloads each font to install it; this
 * reads the two tables it needs from those same bytes. Pure: no DOM, no
 * globals, and a test can feed it a hand-built sfnt.
 *
 * Formats: raw sfnt (TrueType `00010000`, OpenType `OTTO`, `true`) is read
 * directly. WOFF 1.0 wraps the same tables zlib-compressed, decompressed
 * here with `DecompressionStream`. WOFF 2.0 uses Brotli, which the platform
 * cannot decode in script; those return null and the caller falls back to
 * the browser's measured normal.
 */

export interface FontVerticalMetrics {
  unitsPerEm: number
  hheaAscender: number
  hheaDescender: number
  hheaLineGap: number
  /** OS/2 fsSelection bit 7 — the flag that makes browsers prefer typo metrics. */
  useTypoMetrics: boolean
  typoAscender?: number
  typoDescender?: number
  typoLineGap?: number
}

/** `hhea.ascender − hhea.descender + hhea.lineGap`, in ems — PowerPoint's 100%. */
export function powerpointLineHeightRatio(m: FontVerticalMetrics): number {
  return (m.hheaAscender - m.hheaDescender + m.hheaLineGap) / m.unitsPerEm
}

/** `−hhea.descender`, in ems — how far below the baseline PowerPoint's line
 *  box ends, which fixes where the baseline sits inside it. */
export function powerpointDescentRatio(m: FontVerticalMetrics): number {
  return -m.hheaDescender / m.unitsPerEm
}

const TAG_SFNT_TT = 0x00010000
const TAG_OTTO = 0x4f54544f // 'OTTO'
const TAG_TRUE = 0x74727565 // 'true'
const TAG_WOFF = 0x774f4646 // 'wOFF'
const TAG_WOF2 = 0x774f4632 // 'wOF2'

interface TableRef {
  tag: string
  offset: number
  length: number
  /** WOFF only: compressed length; equals `length` when stored raw. */
  compLength?: number
}

function tagOf(view: DataView, at: number): string {
  return String.fromCharCode(
    view.getUint8(at),
    view.getUint8(at + 1),
    view.getUint8(at + 2),
    view.getUint8(at + 3),
  )
}

function readSfntDirectory(view: DataView): TableRef[] {
  const numTables = view.getUint16(4)
  const out: TableRef[] = []
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16
    if (rec + 16 > view.byteLength) break
    out.push({
      tag: tagOf(view, rec),
      offset: view.getUint32(rec + 8),
      length: view.getUint32(rec + 12),
    })
  }
  return out
}

function readWoffDirectory(view: DataView): TableRef[] {
  const numTables = view.getUint16(12)
  const out: TableRef[] = []
  for (let i = 0; i < numTables; i++) {
    const rec = 44 + i * 20
    if (rec + 20 > view.byteLength) break
    out.push({
      tag: tagOf(view, rec),
      offset: view.getUint32(rec + 4),
      compLength: view.getUint32(rec + 8),
      length: view.getUint32(rec + 12),
    })
  }
  return out
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('DecompressionStream unavailable')
  }
  // A view over a shared/sliced buffer is not a BlobPart to the type
  // checker; hand Blob a buffer of its own.
  const owned = new Uint8Array(bytes.byteLength)
  owned.set(bytes)
  const stream = new Blob([owned.buffer]).stream().pipeThrough(new DecompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function tableBytes(
  buffer: ArrayBuffer,
  ref: TableRef,
  woff: boolean,
): Promise<DataView | null> {
  if (ref.offset + (woff ? (ref.compLength ?? ref.length) : ref.length) > buffer.byteLength) {
    return null
  }
  if (!woff || ref.compLength === undefined || ref.compLength === ref.length) {
    return new DataView(buffer, ref.offset, ref.length)
  }
  const raw = new Uint8Array(buffer, ref.offset, ref.compLength)
  const out = await inflate(raw)
  return new DataView(out.buffer, out.byteOffset, Math.min(out.byteLength, ref.length))
}

/**
 * Parse the vertical metrics out of a font file. Returns null for anything
 * it cannot read — an unknown container, WOFF2, a truncated file, a font
 * without `head`/`hhea` — so a caller always has a fallback path and never
 * a thrown surprise mid-load.
 */
export async function readFontVerticalMetrics(
  buffer: ArrayBuffer,
): Promise<FontVerticalMetrics | null> {
  if (buffer.byteLength < 12) return null
  const view = new DataView(buffer)
  const magic = view.getUint32(0)

  let tables: TableRef[]
  let woff = false
  if (magic === TAG_SFNT_TT || magic === TAG_OTTO || magic === TAG_TRUE) {
    tables = readSfntDirectory(view)
  } else if (magic === TAG_WOFF) {
    if (buffer.byteLength < 44) return null
    tables = readWoffDirectory(view)
    woff = true
  } else if (magic === TAG_WOF2) {
    return null
  } else {
    return null
  }

  const find = (tag: string): TableRef | undefined => tables.find((t) => t.tag === tag)
  const headRef = find('head')
  const hheaRef = find('hhea')
  if (headRef === undefined || hheaRef === undefined) return null

  try {
    const head = await tableBytes(buffer, headRef, woff)
    const hhea = await tableBytes(buffer, hheaRef, woff)
    if (head === null || hhea === null || head.byteLength < 20 || hhea.byteLength < 10) return null

    const unitsPerEm = head.getUint16(18)
    if (!(unitsPerEm > 0)) return null
    const metrics: FontVerticalMetrics = {
      unitsPerEm,
      hheaAscender: hhea.getInt16(4),
      hheaDescender: hhea.getInt16(6),
      hheaLineGap: hhea.getInt16(8),
      useTypoMetrics: false,
    }

    const os2Ref = find('OS/2')
    if (os2Ref !== undefined) {
      const os2 = await tableBytes(buffer, os2Ref, woff)
      if (os2 !== null && os2.byteLength >= 74) {
        metrics.useTypoMetrics = (os2.getUint16(62) & 0x80) !== 0
        metrics.typoAscender = os2.getInt16(68)
        metrics.typoDescender = os2.getInt16(70)
        metrics.typoLineGap = os2.getInt16(72)
      }
    }
    return metrics
  } catch {
    return null
  }
}
