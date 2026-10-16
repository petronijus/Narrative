/**
 * state/browserDeckPdf.ts — Export → PDF in the editor (agentic A5.6),
 * built in this browser.
 *
 * Each slide is rendered as slide PNGs are (state/browserSlideExport.ts: the
 * render page in a hidden frame, the same pixels the render worker takes),
 * turned into a JPEG on a canvas, and the pages go into one PDF with
 * shared's `buildImagePdf` — the writer the server's `deck.exportPdf` uses
 * too, so both files are alike. When the browser cannot render, the editor
 * asks the server (`GET /decks/:id/export.pdf`) instead.
 */

import type * as Y from 'yjs'
import { buildImagePdf, type PdfPage } from '@narrative/shared'
import { exportSlidePngInBrowser } from './browserSlideExport.js'

/** JPEG quality of a page: as the server's (services/render.ts PDF_JPEG_QUALITY). */
const JPEG_QUALITY = 0.85

/** A PNG as a JPEG on white (a PNG may be transparent where a JPEG cannot). */
async function pngToJpeg(png: Blob): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(png)
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const g = canvas.getContext('2d')
    if (g === null) throw new Error('no 2D canvas to make the page with')
    g.fillStyle = '#ffffff'
    g.fillRect(0, 0, bitmap.width, bitmap.height)
    g.drawImage(bitmap, 0, 0)
    const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY })
    return new Uint8Array(await jpeg.arrayBuffer())
  } finally {
    bitmap.close()
  }
}

/** The slides `slideIds`, in order, as one PDF: a page each. */
export async function exportDeckPdfInBrowser(args: {
  deckId: string
  doc: Y.Doc
  slideIds: readonly string[]
  title?: string
  /** After each page. */
  onProgress?: (done: number, total: number) => void
}): Promise<Blob> {
  const pages: PdfPage[] = []
  for (const slideId of args.slideIds) {
    const png = await exportSlidePngInBrowser({ deckId: args.deckId, slideId, doc: args.doc })
    pages.push({ jpeg: await pngToJpeg(png) })
    args.onProgress?.(pages.length, args.slideIds.length)
  }
  const pdf = buildImagePdf(pages, args.title !== undefined ? { title: args.title } : {})
  return new Blob([pdf as Uint8Array<ArrayBuffer>], { type: 'application/pdf' })
}
