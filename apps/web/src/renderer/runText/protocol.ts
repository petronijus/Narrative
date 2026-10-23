/**
 * renderer/runText/protocol.ts — the messages between the page and a text
 * raster worker (`textRasterWorker.ts`, ADR 0018).
 *
 * The worker is stateless about texts: every paint carries its whole layout
 * (a structured clone of a few hundred numbers and strings), so any worker can
 * paint any text and nothing is kept per text there. What a worker keeps is
 * the faces: each registered face arrives once, as its bytes and descriptors,
 * and becomes a `FontFace` in the worker's own `FontFaceSet` — so the worker
 * matches a family's faces with the engine's own CSS Fonts 4 §5.2 algorithm,
 * over the same faces the page has (ADR 0018, decision 3).
 *
 * Order is the contract: a worker handles messages in the order they were
 * posted, and a paint waits for every face posted before it to have loaded.
 * A layout made after a face was registered is therefore never painted
 * without it.
 */

import type { DecorationRules } from './decorations.js'
import type { TextRunLayout } from './glyphRuns.js'

/** How the engine whose layout a paint draws snaps what it paints. */
export interface PaintRules {
  /**
   * Round each run's baseline to a whole CSS px of the layout before scaling
   * by the resolution (Chromium does: the SVG raster scales the snapped line).
   */
  snapBaseline: boolean
  /** Whose rules place and cut an underline (decorations.ts). */
  decorations: DecorationRules
  /**
   * The miter limit of `-webkit-text-stroke`: Blink strokes text with Skia's
   * default paint (miter joins, limit 4), WebKit with Core Graphics' (10, a
   * canvas's default too).
   */
  strokeMiterLimit: number
}

/** A face the worker should know: the bytes and descriptors the page registered. */
export interface FaceMessage {
  type: 'face'
  key: string
  family: string
  bytes: ArrayBuffer
  /** CSS descriptors as registered (`weight` may be a range, `stretch` a range). */
  weight: string
  style: string
  stretch: string
}

/** Forget a face (removed or replaced on the page). */
export interface DropFaceMessage {
  type: 'dropFace'
  key: string
}

/** Paint `layout` at `resolution` into a canvas of `width` × `height` device px. */
export interface PaintMessage {
  type: 'paint'
  id: number
  layout: TextRunLayout
  resolution: number
  width: number
  height: number
  rules: PaintRules
}

export type ToWorker = FaceMessage | DropFaceMessage | PaintMessage

/** What the worker can do, sent once when it starts. */
export interface ReadyMessage {
  type: 'ready'
  /** OffscreenCanvas with a 2D context. */
  canPaint: boolean
  /** `self.fonts` (a FontFaceSet in the worker): registered faces can be used. */
  fonts: boolean
}

export interface PaintedMessage {
  type: 'painted'
  id: number
  bitmap: ImageBitmap
  /** Worker time of the paint, ms. */
  ms: number
}

export interface PaintFailedMessage {
  type: 'paintFailed'
  id: number
  message: string
}

/** A face that could not be loaded in the worker (its text paints in a fallback face there). */
export interface FaceFailedMessage {
  type: 'faceFailed'
  key: string
  message: string
}

export type FromWorker = ReadyMessage | PaintedMessage | PaintFailedMessage | FaceFailedMessage
