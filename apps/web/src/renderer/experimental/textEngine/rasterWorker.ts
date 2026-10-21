/**
 * renderer/experimental/textEngine/rasterWorker.ts — the E7 spike's text
 * worker (EXPERIMENTAL): Canvas2D layout (candidate a1) and raster (a1, a2)
 * on an OffscreenCanvas, and SDF glyphs (candidate b).
 *
 * Fonts: the page sends each face's bytes and descriptors; the worker adds a
 * `FontFace` to its own `FontFaceSet` (`self.fonts`), so a family's faces are
 * matched by the engine's own CSS Fonts 4 §5.2 algorithm, the one the SVG
 * raster uses — the same faces and descriptors, the same pick. A FontFace
 * made from bytes is no fetch: `font-src` does not apply (ADR 0007); the
 * worker itself is a same-origin module (`worker-src 'self'`).
 */

import TinySDF from '@mapbox/tiny-sdf'
import { layoutBlock, type Measurer } from './blockLayout.js'
import { paintRuns } from './paint.js'
import type { FromWorker, SdfGlyph, ToWorker } from './protocol.js'
import { rasterSize, stretchKeyword, type TextRunLayout } from './runs.js'
import type { BlockStyle } from './textBlock.js'

interface WorkerScope {
  fonts: { add(face: FontFace): void }
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null
  postMessage(message: FromWorker, transfer?: Transferable[]): void
}

const scope = self as unknown as WorkerScope

const measureCtx = new OffscreenCanvas(1, 1).getContext('2d')!
const canStretch = 'fontStretch' in measureCtx
let currentFont = ''
let currentSpacing = ''
let currentStretch: CanvasFontStretch = 'normal'

const measurer: Measurer = {
  width(text: string, style: BlockStyle): number {
    if (style.font !== currentFont) {
      measureCtx.font = style.font
      currentFont = style.font
    }
    const spacing = `${style.letterSpacing}px`
    if (spacing !== currentSpacing) {
      measureCtx.letterSpacing = spacing
      currentSpacing = spacing
    }
    if (canStretch) {
      const stretch = stretchKeyword(style.stretch) ?? 'normal'
      if (stretch !== currentStretch) {
        measureCtx.fontStretch = stretch
        currentStretch = stretch
      }
    }
    return measureCtx.measureText(text).width
  },
}

/** Layouts kept for repaints, by the caller's key. */
const kept = new Map<string, TextRunLayout>()

function paint(id: number, layout: TextRunLayout, resolution: number, layoutMs: number): void {
  const t0 = performance.now()
  const size = rasterSize(layout, resolution)
  const canvas = new OffscreenCanvas(size.width, size.height)
  const ctx = canvas.getContext('2d')!
  const notes = paintRuns(ctx, layout, resolution)
  const bitmap = canvas.transferToImageBitmap()
  const paintMs = performance.now() - t0
  scope.postMessage({ type: 'painted', id, bitmap, layoutMs, paintMs, notes }, [bitmap])
}

function sdfGlyphs(msg: Extract<ToWorker, { type: 'sdf' }>): void {
  const t0 = performance.now()
  const sdf = new TinySDF({
    fontSize: msg.size,
    buffer: msg.buffer,
    radius: msg.radius,
    cutoff: 0.5,
    fontFamily: msg.family,
    fontWeight: msg.weight,
    fontStyle: msg.style,
  })
  const glyphs: SdfGlyph[] = msg.chars.map((char) => {
    const g = sdf.draw(char)
    return {
      char,
      data: g.data,
      width: g.width,
      height: g.height,
      glyphLeft: g.glyphLeft,
      glyphTop: g.glyphTop,
      glyphAdvance: g.glyphAdvance,
    }
  })
  const ctx = new OffscreenCanvas(1, 1).getContext('2d')!
  ctx.font = `${msg.style} ${msg.weight} ${msg.size}px ${msg.family}`
  const advance = new Map<string, number>()
  const w = (s: string): number => {
    let v = advance.get(s)
    if (v === undefined) {
      v = ctx.measureText(s).width
      advance.set(s, v)
    }
    return v
  }
  const kerning: Record<string, number> = {}
  for (const pair of msg.pairs) {
    const [a, b] = [...pair]
    if (a === undefined || b === undefined) continue
    const k = w(pair) - w(a) - w(b)
    if (Math.abs(k) > 1e-3) kerning[pair] = k
  }
  const ascent = ctx.measureText('x').fontBoundingBoxAscent
  const ms = performance.now() - t0
  scope.postMessage(
    { type: 'sdf', id: msg.id, glyphs, kerning, ascent, ms },
    glyphs.map((g) => g.data.buffer as ArrayBuffer),
  )
}

scope.onmessage = (e: MessageEvent<ToWorker>): void => {
  const msg = e.data
  try {
    switch (msg.type) {
      case 'font': {
        const face = new FontFace(msg.family, msg.bytes, msg.descriptors)
        void face.load().then(
          () => {
            scope.fonts.add(face)
            currentFont = ''
            scope.postMessage({ type: 'ack', id: msg.id })
          },
          (err: unknown) => scope.postMessage({ type: 'error', id: msg.id, message: String(err) }),
        )
        return
      }
      case 'paint':
        kept.set(msg.key, msg.layout)
        paint(msg.id, msg.layout, msg.resolution, 0)
        return
      case 'layoutPaint': {
        const t0 = performance.now()
        const layout = layoutBlock(msg.block, measurer, msg.options)
        const layoutMs = performance.now() - t0
        kept.set(msg.key, layout)
        const t1 = performance.now()
        const size = rasterSize(layout, msg.resolution)
        const canvas = new OffscreenCanvas(size.width, size.height)
        const notes = paintRuns(canvas.getContext('2d')!, layout, msg.resolution)
        const bitmap = canvas.transferToImageBitmap()
        scope.postMessage(
          {
            type: 'painted',
            id: msg.id,
            bitmap,
            layout,
            layoutMs,
            paintMs: performance.now() - t1,
            notes,
          },
          [bitmap],
        )
        return
      }
      case 'repaint': {
        const layout = kept.get(msg.key)
        if (layout === undefined) throw new Error(`no layout kept for ${msg.key}`)
        paint(msg.id, layout, msg.resolution, 0)
        return
      }
      case 'forget':
        if (msg.keys === 'all') kept.clear()
        else for (const k of msg.keys) kept.delete(k)
        scope.postMessage({ type: 'ack', id: msg.id })
        return
      case 'sdf':
        sdfGlyphs(msg)
        return
    }
  } catch (err) {
    scope.postMessage({ type: 'error', id: msg.id, message: String(err) })
  }
}
