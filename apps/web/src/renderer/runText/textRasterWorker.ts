/**
 * renderer/runText/textRasterWorker.ts — a text raster worker (ADR 0018):
 * paints glyph-run layouts with Canvas2D on an OffscreenCanvas and hands the
 * pixels back as an `ImageBitmap` (transferred, no copy).
 *
 * Fonts: the page posts each registered face's bytes and descriptors; the
 * worker adds a `FontFace` made from them to its own `FontFaceSet`
 * (`self.fonts`), so a family's faces are matched by the engine's own CSS
 * Fonts 4 §5.2 algorithm — the faces and descriptors the page's document has,
 * the same pick. A FontFace made from bytes is no fetch: `font-src` does not
 * apply (ADR 0007); the worker itself is a same-origin module script
 * (`worker-src 'self'`).
 *
 * A paint waits for every face posted before it to have loaded (`faces`
 * below is a chain): the first raster in a face is never drawn before the
 * face is there — the WebKit failure of HTMLText that drew some texts in an
 * embedded face as nothing (performance.md → E7) has no counterpart here.
 */

import { offscreenScratch, paintRuns, type PaintSupport } from './paintRuns.js'
import type { FromWorker, PaintMessage, ToWorker } from './protocol.js'

interface WorkerScope {
  fonts?: { add(face: FontFace): void; delete(face: FontFace): boolean }
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null
  postMessage(message: FromWorker, transfer?: Transferable[]): void
}

const scope = self as unknown as WorkerScope

const canPaint =
  typeof OffscreenCanvas === 'function' && new OffscreenCanvas(1, 1).getContext('2d') !== null
const fonts = scope.fonts !== undefined && typeof FontFace === 'function'

/** The scratch canvas underline ink skipping draws its masks into (one per worker). */
const support: PaintSupport | null = canPaint ? { scratch: offscreenScratch() } : null

/** Loaded faces by the page's key. */
const loaded = new Map<string, FontFace>()
/** Settles when every face posted so far has loaded (or failed). */
let faces: Promise<void> = Promise.resolve()

function post(message: FromWorker, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer)
}

function addFace(msg: Extract<ToWorker, { type: 'face' }>): void {
  faces = faces.then(async () => {
    if (!fonts) return
    try {
      const face = new FontFace(msg.family, msg.bytes, {
        weight: msg.weight,
        style: msg.style,
        stretch: msg.stretch,
      })
      await face.load()
      const previous = loaded.get(msg.key)
      if (previous !== undefined) scope.fonts!.delete(previous)
      scope.fonts!.add(face)
      loaded.set(msg.key, face)
    } catch (err) {
      post({ type: 'faceFailed', key: msg.key, message: String(err) })
    }
  })
}

function dropFace(key: string): void {
  faces = faces.then(() => {
    const face = loaded.get(key)
    if (face === undefined) return
    scope.fonts?.delete(face)
    loaded.delete(key)
  })
}

function paint(msg: PaintMessage): void {
  void faces.then(() => {
    const t0 = performance.now()
    try {
      const canvas = new OffscreenCanvas(Math.max(1, msg.width), Math.max(1, msg.height))
      const ctx = canvas.getContext('2d')
      if (ctx === null) throw new Error('no 2d context')
      paintRuns(ctx, msg.layout, msg.resolution, msg.rules, support ?? undefined)
      const bitmap = canvas.transferToImageBitmap()
      post({ type: 'painted', id: msg.id, bitmap, ms: performance.now() - t0 }, [bitmap])
    } catch (err) {
      post({ type: 'paintFailed', id: msg.id, message: String(err) })
    }
  })
}

scope.onmessage = (e: MessageEvent<ToWorker>): void => {
  const msg = e.data
  switch (msg.type) {
    case 'face':
      addFace(msg)
      return
    case 'dropFace':
      dropFace(msg.key)
      return
    case 'paint':
      paint(msg)
      return
  }
}

post({ type: 'ready', canPaint, fonts })
