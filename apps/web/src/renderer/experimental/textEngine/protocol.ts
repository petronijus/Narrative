/**
 * renderer/experimental/textEngine/protocol.ts — messages between the main
 * thread and the raster worker of the E7 spike (EXPERIMENTAL).
 */

import type { LayoutOptions } from './blockLayout.js'
import type { PaintNotes } from './paint.js'
import type { TextRunLayout } from './runs.js'
import type { TextBlock } from './textBlock.js'

/** A face the worker should know: the same bytes and descriptors the page registered. */
export interface FontMessage {
  type: 'font'
  id: number
  family: string
  bytes: ArrayBuffer
  descriptors: { weight?: string; style?: string; stretch?: string }
}

/** Paint a layout the main thread made (candidate a2). `key` keeps it for repaints. */
export interface PaintMessage {
  type: 'paint'
  id: number
  key: string
  layout: TextRunLayout
  resolution: number
}

/** Lay a block out and paint it (candidate a1). `key` keeps the layout for repaints. */
export interface LayoutPaintMessage {
  type: 'layoutPaint'
  id: number
  key: string
  block: TextBlock
  resolution: number
  options: LayoutOptions
}

/** Paint a kept layout again at another resolution (a zoom). */
export interface RepaintMessage {
  type: 'repaint'
  id: number
  key: string
  resolution: number
}

/** Forget kept layouts. */
export interface ForgetMessage {
  type: 'forget'
  id: number
  keys: string[] | 'all'
}

/** SDF glyphs of one face (candidate b). */
export interface SdfMessage {
  type: 'sdf'
  id: number
  family: string
  weight: string
  style: string
  /** Base size the atlas is rendered at, px. */
  size: number
  buffer: number
  radius: number
  chars: string[]
  /** Pairs to kern ("AV"). */
  pairs: string[]
}

export type ToWorker =
  FontMessage | PaintMessage | LayoutPaintMessage | RepaintMessage | ForgetMessage | SdfMessage

export interface PaintResult {
  type: 'painted'
  id: number
  bitmap: ImageBitmap
  /** Present for layoutPaint: the layout the worker made. */
  layout?: TextRunLayout
  layoutMs: number
  paintMs: number
  notes: PaintNotes
}

export interface SdfGlyph {
  char: string
  data: Uint8ClampedArray
  width: number
  height: number
  glyphLeft: number
  glyphTop: number
  glyphAdvance: number
}

export interface SdfResult {
  type: 'sdf'
  id: number
  glyphs: SdfGlyph[]
  kerning: Record<string, number>
  /** The face's ascent at the base size (TinySDF draws glyphs relative to it). */
  ascent: number
  ms: number
}

export interface AckResult {
  type: 'ack'
  id: number
}

export interface ErrorResult {
  type: 'error'
  id: number
  message: string
}

export type FromWorker = PaintResult | SdfResult | AckResult | ErrorResult
