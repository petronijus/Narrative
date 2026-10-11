/**
 * pages/renderLook.ts — what an agent looks at (`query.render`, agentic A3),
 * composed in the render page from captured slides with a 2D canvas, so the
 * render worker needs no image library.
 *
 *   - `slide`: the slide downscaled to what a model reads of an image
 *     (`LOOK_MAX_EDGE` on the long edge and `LOOK_MAX_PIXELS` in all);
 *   - `region`: a region at full resolution, downscaled only past those
 *     limits — for small type, a table, an alignment;
 *   - `sheet`: the slides in a grid with the largest tiles the limits allow,
 *     each labelled with its number in the deck — for pacing and repetition
 *     across a deck;
 *   - `thumbnail`: the slide as the deck's card picture on the folder page
 *     (`THUMBNAIL_WIDTH`×`THUMBNAIL_HEIGHT`).
 *
 * Always a PNG (sharp text); one that comes out over `MAX_LOOK_BYTES` (photo
 * heavy) is composed again smaller, so it stays within what an MCP client
 * passes to a model.
 *
 * Every canvas here is a CPU canvas (`willReadFrequently`). Chrome keeps
 * other 2D canvases in GPU memory — SwiftShader's, on the production VM — and
 * drops them when its budget, sized from the machine's memory, runs out: on
 * the 2.9 GB VM a sheet of six slides came back as six empty tiles with
 * their numbers (0.10.24). A canvas that lost its content anyway is an error
 * (`assertIntact`), never a blank picture.
 */

import { LOOK_MAX_EDGE, LOOK_MAX_PIXELS, THUMBNAIL_HEIGHT, THUMBNAIL_WIDTH } from '@narrative/shared'
import { SLIDE_HEIGHT, SLIDE_WIDTH } from '../renderer/constants.js'
import { canvasToPng } from '../renderer/captureSlide.js'

export const MAX_LOOK_BYTES = 3_750_000
const MIN_EDGE = 640

export interface LookFrame {
  canvas: CanvasImageSource
  /** 0-based position in the deck. */
  index: number
}

export type LookRequest =
  | { mode: 'slide' }
  | { mode: 'region'; region: { x: number; y: number; width: number; height: number } }
  | { mode: 'sheet' }
  | { mode: 'thumbnail' }

export interface ComposedLook {
  png: Blob
  width: number
  height: number
}

/** The region inside the slide, whole pixels, at least 1×1. */
export function clampRegion(region: { x: number; y: number; width: number; height: number }): {
  x: number
  y: number
  width: number
  height: number
} {
  const x = Math.min(Math.max(0, Math.floor(region.x)), SLIDE_WIDTH - 1)
  const y = Math.min(Math.max(0, Math.floor(region.y)), SLIDE_HEIGHT - 1)
  const right = Math.min(SLIDE_WIDTH, Math.max(x + 1, Math.ceil(region.x + region.width)))
  const bottom = Math.min(SLIDE_HEIGHT, Math.max(y + 1, Math.ceil(region.y + region.height)))
  return { x, y, width: right - x, height: bottom - y }
}

/** The largest scale ≤ 1 at which `width`×`height` fits the edge and pixel limits. */
export function fitScale(
  width: number,
  height: number,
  maxEdge: number,
  maxPixels: number,
): number {
  return Math.min(1, maxEdge / Math.max(width, height), Math.sqrt(maxPixels / (width * height)))
}

export const SHEET_GAP = 8

/**
 * The grid for `count` slides with the largest tiles that keep the whole
 * sheet within the limits (tiles 16:9, `SHEET_GAP` around each). Under the
 * pixel limit a tall grid and a wide one often allow nearly the same tile;
 * among grids within 3% of the largest tile, the one nearest 16:9 wins.
 */
export function sheetLayout(
  count: number,
  maxEdge: number,
  maxPixels: number,
): { cols: number; rows: number; tileWidth: number; tileHeight: number } {
  const grids: Array<{ cols: number; rows: number; tileWidth: number; tileHeight: number }> = []
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols)
    const size = (tw: number) => ({
      w: cols * tw + SHEET_GAP * (cols + 1),
      h: rows * Math.round((tw * SLIDE_HEIGHT) / SLIDE_WIDTH) + SHEET_GAP * (rows + 1),
    })
    let tw = Math.floor(
      Math.min(
        (maxEdge - SHEET_GAP * (cols + 1)) / cols,
        ((maxEdge - SHEET_GAP * (rows + 1)) / rows) * (SLIDE_WIDTH / SLIDE_HEIGHT),
      ),
    )
    while (tw > 1 && size(tw).w * size(tw).h > maxPixels) tw -= 1
    grids.push({
      cols,
      rows,
      tileWidth: tw,
      tileHeight: Math.round((tw * SLIDE_HEIGHT) / SLIDE_WIDTH),
    })
  }
  const largest = Math.max(...grids.map((g) => g.tileWidth))
  const offAspect = (g: (typeof grids)[number]) =>
    Math.abs(Math.log((g.cols * g.tileWidth) / (g.rows * g.tileHeight) / (16 / 9)))
  return grids
    .filter((g) => g.tileWidth >= largest * 0.97)
    .reduce((a, b) => (offAspect(b) < offAspect(a) ? b : a))
}

function newCanvas(
  width: number,
  height: number,
): {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
} {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (ctx === null) throw new Error('no 2D canvas')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  return { canvas, ctx }
}

function composeAt(
  request: LookRequest,
  frames: LookFrame[],
  maxEdge: number,
  maxPixels: number,
): HTMLCanvasElement {
  if (request.mode === 'slide') {
    const scale = fitScale(SLIDE_WIDTH, SLIDE_HEIGHT, maxEdge, maxPixels)
    const { canvas, ctx } = newCanvas(
      Math.round(SLIDE_WIDTH * scale),
      Math.round(SLIDE_HEIGHT * scale),
    )
    ctx.drawImage(frames[0]!.canvas, 0, 0, canvas.width, canvas.height)
    return canvas
  }
  if (request.mode === 'thumbnail') {
    // Fixed size: far below the limits, and a smaller retry is never needed.
    const { canvas, ctx } = newCanvas(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT)
    ctx.drawImage(frames[0]!.canvas, 0, 0, canvas.width, canvas.height)
    return canvas
  }
  if (request.mode === 'region') {
    const r = clampRegion(request.region)
    const scale = fitScale(r.width, r.height, maxEdge, maxPixels)
    const { canvas, ctx } = newCanvas(
      Math.max(1, Math.round(r.width * scale)),
      Math.max(1, Math.round(r.height * scale)),
    )
    ctx.drawImage(frames[0]!.canvas, r.x, r.y, r.width, r.height, 0, 0, canvas.width, canvas.height)
    return canvas
  }
  const {
    cols,
    rows,
    tileWidth: tileW,
    tileHeight: tileH,
  } = sheetLayout(frames.length, maxEdge, maxPixels)
  const gap = SHEET_GAP
  const { canvas, ctx } = newCanvas(
    cols * tileW + gap * (cols + 1),
    rows * tileH + gap * (rows + 1),
  )
  ctx.fillStyle = '#d9d9d9'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  const labelSize = Math.max(12, Math.round(tileH * 0.11))
  frames.forEach((frame, i) => {
    const x = gap + (i % cols) * (tileW + gap)
    const y = gap + Math.floor(i / cols) * (tileH + gap)
    ctx.drawImage(frame.canvas, x, y, tileW, tileH)
    // The slide's number in the deck, on a dark tab in the corner.
    const label = String(frame.index + 1)
    ctx.font = `600 ${labelSize}px system-ui, sans-serif`
    const pad = Math.round(labelSize * 0.35)
    const w = Math.ceil(ctx.measureText(label).width) + pad * 2
    const h = labelSize + pad * 2
    ctx.fillStyle = 'rgba(17, 17, 17, 0.85)'
    ctx.fillRect(x, y, w, h)
    ctx.fillStyle = '#ffffff'
    ctx.textBaseline = 'top'
    ctx.fillText(label, x + pad, y + pad)
  })
  return canvas
}

/** Throws when a canvas has lost its content (Chrome dropped its backing store). */
export function assertIntact(canvas: unknown, what: string): void {
  if (typeof HTMLCanvasElement === 'undefined' || !(canvas instanceof HTMLCanvasElement)) return
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (ctx !== null && typeof ctx.isContextLost === 'function' && ctx.isContextLost()) {
    throw new Error(`${what} lost its pixels (the browser dropped the canvas)`)
  }
}

/** Compose the look; smaller again while its PNG is over `MAX_LOOK_BYTES`. */
export async function composeLook(
  request: LookRequest,
  frames: LookFrame[],
): Promise<ComposedLook> {
  if (frames.length === 0) throw new Error('nothing to compose')
  frames.forEach((frame, i) => assertIntact(frame.canvas, `slide ${i + 1} of the look`))
  let edge = LOOK_MAX_EDGE
  let pixels = LOOK_MAX_PIXELS
  for (;;) {
    const canvas = composeAt(request, frames, edge, pixels)
    assertIntact(canvas, 'the look')
    const png = await canvasToPng(canvas)
    if (png.size <= MAX_LOOK_BYTES || edge <= MIN_EDGE) {
      return { png, width: canvas.width, height: canvas.height }
    }
    edge = Math.max(MIN_EDGE, Math.floor(edge * 0.8))
    pixels = Math.floor(pixels * 0.64)
  }
}

/** A Blob's bytes as base64 (handed to the render worker through Playwright). */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

/**
 * A captured slide shrunk to its tile in a sheet of `count` slides (the
 * largest tile the sheet can have; a smaller retry only shrinks it further),
 * so a sheet holds tiles, not up to 20 captures of 1920×1080.
 */
export function shrinkForSheet(source: CanvasImageSource, count: number): HTMLCanvasElement {
  const { tileWidth, tileHeight } = sheetLayout(count, LOOK_MAX_EDGE, LOOK_MAX_PIXELS)
  const { canvas, ctx } = newCanvas(tileWidth, tileHeight)
  ctx.drawImage(source, 0, 0, tileWidth, tileHeight)
  return canvas
}
