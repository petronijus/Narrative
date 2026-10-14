/**
 * shared/src/pdf.ts — a PDF of pictures, one per page (agentic A5.6,
 * `deck.exportPdf`): each slide rendered to a JPEG, embedded as it is
 * (DCTDecode — no decoding, no re-encoding) and drawn over the whole page.
 *
 * A raster PDF, by decision (docs/plans/a5-deck-builder.md: a vector PDF
 * would need a second renderer). Pure and dependency-free, so the editor
 * builds the file in the browser from the slides it renders itself, and the
 * server from the render worker's.
 *
 * The file is PDF 1.4: a catalog, a page tree, and per page a page object,
 * its picture (an image XObject) and a content stream that scales the
 * picture to the page; an Info dictionary with the title; a classic xref
 * table. The page size is the slide's 16:9 at PowerPoint's widescreen size,
 * 960 × 540 pt (13.33 × 7.5 in), whatever the pictures' pixel size.
 */

export interface PdfPage {
  /** A baseline or progressive JPEG (JFIF / Exif). */
  jpeg: Uint8Array
}

export interface PdfOptions {
  /** Page size in points; default 960 × 540 (16:9 widescreen). */
  pageWidth?: number
  pageHeight?: number
  /** The document title (Info /Title). */
  title?: string
}

export interface JpegInfo {
  width: number
  height: number
  /** 1 grey, 3 RGB (YCbCr), 4 CMYK. */
  components: 1 | 3 | 4
}

/** The size and colour components of a JPEG, from its frame header; throws on anything else. */
export function jpegInfo(bytes: Uint8Array): JpegInfo {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8)
    throw new Error('not a JPEG (no SOI marker)')
  let i = 2
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) throw new Error('not a JPEG (a segment does not start with 0xFF)')
    const marker = bytes[i + 1]!
    // Fill bytes, and markers without a length.
    if (marker === 0xff) {
      i += 1
      continue
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    const length = (bytes[i + 2]! << 8) | bytes[i + 3]!
    // Start of frame: any SOF but DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 9 >= bytes.length) break
      const height = (bytes[i + 5]! << 8) | bytes[i + 6]!
      const width = (bytes[i + 7]! << 8) | bytes[i + 8]!
      const components = bytes[i + 9]!
      if (width === 0 || height === 0) throw new Error('a JPEG without a size')
      if (components !== 1 && components !== 3 && components !== 4)
        throw new Error(`a JPEG with ${components} colour components`)
      return { width, height, components }
    }
    if (marker === 0xda || marker === 0xd9) break
    i += 2 + length
  }
  throw new Error('not a JPEG (no frame header)')
}

const encoder = new TextEncoder()

/** A PDF literal string: (…) with \, ( and ) escaped, non-ASCII as UTF-16BE hex. */
function pdfString(text: string): string {
  if (/^[\x20-\x7e]*$/.test(text)) return `(${text.replace(/[\\()]/g, (c) => `\\${c}`)})`
  let hex = 'FEFF'
  for (let i = 0; i < text.length; i++) hex += text.charCodeAt(i).toString(16).padStart(4, '0')
  return `<${hex.toUpperCase()}>`
}

/** Points with at most two decimals, as PDF numbers are written. */
const num = (n: number): string => String(Math.round(n * 100) / 100)

/** The PDF: one page per JPEG, in order. */
export function buildImagePdf(pages: readonly PdfPage[], options: PdfOptions = {}): Uint8Array {
  if (pages.length === 0) throw new Error('a PDF needs at least one page')
  const pageWidth = options.pageWidth ?? 960
  const pageHeight = options.pageHeight ?? 540

  const chunks: Uint8Array[] = []
  let length = 0
  const offsets: number[] = []
  const write = (part: string | Uint8Array): void => {
    const bytes = typeof part === 'string' ? encoder.encode(part) : part
    chunks.push(bytes)
    length += bytes.length
  }
  /** Begin object `n` (1-based) at the current offset. */
  const object = (n: number, body: string): void => {
    offsets[n] = length
    write(`${n} 0 obj\n${body}\nendobj\n`)
  }

  // A binary comment after the header marks the file as binary for transports.
  write('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
  // Objects: 1 catalog, 2 pages, 3 info, then per page: page, image, contents.
  const pageObject = (i: number): number => 4 + i * 3
  object(1, '<< /Type /Catalog /Pages 2 0 R >>')
  object(
    2,
    `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${pageObject(i)} 0 R`).join(' ')}] >>`,
  )
  object(
    3,
    `<< /Producer (Narrative)${options.title !== undefined ? ` /Title ${pdfString(options.title)}` : ''} >>`,
  )
  pages.forEach((page, i) => {
    const info = jpegInfo(page.jpeg)
    const n = pageObject(i)
    object(
      n,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(pageWidth)} ${num(pageHeight)}] ` +
        `/Resources << /XObject << /Im${i} ${n + 1} 0 R >> >> /Contents ${n + 2} 0 R >>`,
    )
    const colorSpace =
      info.components === 1 ? '/DeviceGray' : info.components === 3 ? '/DeviceRGB' : '/DeviceCMYK'
    offsets[n + 1] = length
    write(
      `${n + 1} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} ` +
        `/ColorSpace ${colorSpace} /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`,
    )
    write(page.jpeg)
    write('\nendstream\nendobj\n')
    const content = `q ${num(pageWidth)} 0 0 ${num(pageHeight)} 0 0 cm /Im${i} Do Q`
    object(n + 2, `<< /Length ${encoder.encode(content).length} >>\nstream\n${content}\nendstream`)
  })

  const size = pageObject(pages.length)
  const xref = length
  let table = `xref\n0 ${size}\n0000000000 65535 f \n`
  for (let n = 1; n < size; n++) table += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`
  write(table)
  write(`trailer\n<< /Size ${size} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`)

  const out = new Uint8Array(length)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}
