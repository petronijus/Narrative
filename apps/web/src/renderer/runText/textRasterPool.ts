/**
 * renderer/runText/textRasterPool.ts — the page's text raster workers
 * (ADR 0018): a small pool every renderer of the page shares, the faces each
 * worker must know, and a paint that resolves to the text's pixels.
 *
 * Faces: the pool hears the font registry (`fontChanges.ts` →
 * `subscribeHtmlTextFaces`) and posts every face to every worker, a copy of
 * the bytes each, before any paint that follows (a worker handles messages in
 * order and a paint waits for the faces posted before it; protocol.ts).
 *
 * Where a worker cannot do the job the page paints instead, on the main
 * thread, with the same painter and the document's fonts — never a wrong
 * raster, at worst a slower one:
 *
 *   - the worker never started (a CSP that blocks it fails silently: no
 *     `ready` within `READY_TIMEOUT_MS`), cannot make a 2D OffscreenCanvas,
 *     or crashed;
 *   - the worker has no `FontFaceSet` (texts in a registered family), or a
 *     face failed to load there (texts in that family).
 *
 * A paint that cannot be made at all (a run whose font cannot be set, a width
 * Canvas2D cannot spell) resolves to null: the caller draws that text with
 * Pixi's HTMLText instead.
 */

import { perfCount } from '@narrative/shared'
import { subscribeHtmlTextFaces } from '../fontChanges.js'
import { rasterSize, type TextRunLayout } from './glyphRuns.js'
import { offscreenScratch, paintRuns, type PaintSupport } from './paintRuns.js'
import type { FromWorker, PaintRules, ToWorker } from './protocol.js'

/** How long a worker may take to say it is ready before the page paints without it. */
export const READY_TIMEOUT_MS = 4000

/** Workers in the pool: a quarter of the cores, 1 to 3 (each holds a copy of every face). */
export function defaultPoolSize(): number {
  const cores = typeof navigator === 'undefined' ? 4 : (navigator.hardwareConcurrency ?? 4)
  return Math.max(1, Math.min(3, Math.floor(cores / 4)))
}

/** A painted raster: the bitmap and where it was made. */
export interface PaintResult {
  bitmap: ImageBitmap
  /** `worker` or `main` (the fallback painter). */
  where: 'worker' | 'main'
  ms: number
}

interface Slot {
  worker: Worker
  /** Settles with the worker's capabilities, or null when it failed to start. */
  ready: Promise<{ canPaint: boolean; fonts: boolean } | null>
  /** Paints posted and not answered. */
  inFlight: number
  broken: boolean
}

interface Pending {
  slot: Slot
  resolve: (r: PaintResult | null) => void
  layout: TextRunLayout
  resolution: number
  rules: PaintRules
  width: number
  height: number
}

export type WorkerFactory = () => Worker

/** Paints on the page when no worker can (`paintOnMainThread`; tests hand in their own). */
export type PagePainter = (
  layout: TextRunLayout,
  resolution: number,
  rules: PaintRules,
  width: number,
  height: number,
) => PaintResult | null

export interface TextRasterPoolOptions {
  /** Workers to start (default `defaultPoolSize()`). */
  size?: number
  createWorker?: WorkerFactory
  paintOnPage?: PagePainter
  /** How long a worker may take to start (default `READY_TIMEOUT_MS`). */
  readyTimeoutMs?: number
}

const defaultWorkerFactory: WorkerFactory = () =>
  new Worker(new URL('./textRasterWorker.ts', import.meta.url), {
    type: 'module',
    name: 'narrative-text-raster',
  })

export class TextRasterPool {
  private readonly slots: Slot[] = []
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  /** Families with a registered face (a worker without fonts cannot draw them). */
  private readonly registered = new Map<string, number>()
  /** Families some worker failed to load a face of (painted on the main thread). */
  private readonly failedFamilies = new Set<string>()
  private readonly faceFamily = new Map<string, string>()
  private unsubscribe: (() => void) | null = null
  private started = false

  private readonly size: number
  private readonly createWorker: WorkerFactory
  private readonly paintOnPage: PagePainter
  private readonly readyTimeoutMs: number

  constructor(options: TextRasterPoolOptions = {}) {
    this.size = options.size ?? defaultPoolSize()
    this.createWorker = options.createWorker ?? defaultWorkerFactory
    this.paintOnPage = options.paintOnPage ?? paintOnMainThread
    this.readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS
  }

  /** Workers in the pool (0 before the first paint, or where none could start). */
  get workers(): number {
    return this.slots.filter((s) => !s.broken).length
  }

  private start(): void {
    if (this.started) return
    this.started = true
    if (this.createWorker === defaultWorkerFactory && typeof Worker !== 'function') return
    for (let i = 0; i < this.size; i++) {
      let worker: Worker
      try {
        worker = this.createWorker()
      } catch (err) {
        console.warn('[runText] text raster worker could not start; painting on the page', err)
        perfCount('text.worker.failed')
        break
      }
      this.slots.push(this.makeSlot(worker))
    }
    // Every face there is now, then each change, to every worker (in order).
    this.unsubscribe = subscribeHtmlTextFaces({
      added: (face) => {
        this.faceFamily.set(face.key, face.family)
        this.registered.set(face.family, (this.registered.get(face.family) ?? 0) + 1)
        for (const slot of this.slots) {
          if (slot.broken) continue
          const bytes = face.bytes.slice(0)
          this.post(
            slot,
            {
              type: 'face',
              key: face.key,
              family: face.family,
              bytes,
              weight: face.weight,
              style: face.style,
              stretch: face.stretch,
            },
            [bytes],
          )
        }
      },
      removed: (key) => {
        const family = this.faceFamily.get(key)
        this.faceFamily.delete(key)
        if (family !== undefined) {
          const n = (this.registered.get(family) ?? 1) - 1
          if (n <= 0) this.registered.delete(family)
          else this.registered.set(family, n)
        }
        for (const slot of this.slots) if (!slot.broken) this.post(slot, { type: 'dropFace', key })
      },
    })
  }

  private makeSlot(worker: Worker): Slot {
    let settle: (v: { canPaint: boolean; fonts: boolean } | null) => void = () => {}
    const ready = new Promise<{ canPaint: boolean; fonts: boolean } | null>((resolve) => {
      settle = resolve
    })
    const slot: Slot = { worker, ready, inFlight: 0, broken: false }
    const timer = setTimeout(() => {
      console.warn(
        '[runText] text raster worker did not start (CSP worker-src?); painting on the page',
      )
      perfCount('text.worker.failed')
      this.breakSlot(slot)
      settle(null)
    }, this.readyTimeoutMs)
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const msg = e.data
      if (msg.type === 'ready') {
        clearTimeout(timer)
        if (!msg.canPaint) {
          this.breakSlot(slot)
          settle(null)
        } else {
          settle({ canPaint: msg.canPaint, fonts: msg.fonts })
        }
        return
      }
      this.onMessage(msg)
    }
    worker.onerror = (e: ErrorEvent) => {
      console.warn('[runText] text raster worker failed; painting on the page', e.message)
      perfCount('text.worker.failed')
      clearTimeout(timer)
      this.breakSlot(slot)
      settle(null)
    }
    return slot
  }

  /** Take a worker out: its pending paints are made on the main thread. */
  private breakSlot(slot: Slot): void {
    if (slot.broken) return
    slot.broken = true
    try {
      slot.worker.terminate()
    } catch {
      /* already gone */
    }
    for (const [id, p] of [...this.pending]) {
      if (p.slot !== slot) continue
      this.pending.delete(id)
      p.resolve(this.paintOnPage(p.layout, p.resolution, p.rules, p.width, p.height))
    }
  }

  private onMessage(msg: Exclude<FromWorker, { type: 'ready' }>): void {
    if (msg.type === 'faceFailed') {
      const family = this.faceFamily.get(msg.key)
      console.warn(`[runText] a face of ${family ?? msg.key} failed in a worker: ${msg.message}`)
      if (family !== undefined) this.failedFamilies.add(family)
      return
    }
    const p = this.pending.get(msg.id)
    if (p === undefined) return
    this.pending.delete(msg.id)
    p.slot.inFlight--
    if (msg.type === 'painted') {
      p.resolve({ bitmap: msg.bitmap, where: 'worker', ms: msg.ms })
    } else {
      // The worker could not paint it (a font it cannot set, a width it cannot
      // spell): the main thread could not either — the caller falls back.
      p.resolve(null)
    }
  }

  private post(slot: Slot, msg: ToWorker, transfer: Transferable[] = []): void {
    try {
      slot.worker.postMessage(msg, transfer)
    } catch (err) {
      console.warn('[runText] posting to a text raster worker failed', err)
      this.breakSlot(slot)
    }
  }

  /** Whether `layout` names a family the workers cannot draw (no fonts, or a face failed there). */
  private needsPageFonts(layout: TextRunLayout, workersHaveFonts: boolean): boolean {
    const families = [...(workersHaveFonts ? this.failedFamilies : this.registered.keys())]
    if (families.length === 0) return false
    return layout.runs.some((run) => families.some((f) => fontNamesFamily(run.font, f)))
  }

  /**
   * Paint `layout` at `resolution` (device px per CSS px). Resolves to null
   * when it cannot be painted as the engine draws it.
   */
  async paint(
    layout: TextRunLayout,
    resolution: number,
    rules: PaintRules,
  ): Promise<PaintResult | null> {
    this.start()
    const { width, height } = rasterSize(layout, resolution)
    const slot = this.pickSlot()
    if (slot === null) return this.paintOnPage(layout, resolution, rules, width, height)
    // Counted as the worker's from the pick, so paints asked for together
    // spread over the pool while its workers are still starting.
    slot.inFlight++
    const caps = await slot.ready
    if (caps === null || slot.broken || this.needsPageFonts(layout, caps.fonts)) {
      slot.inFlight--
      return this.paintOnPage(layout, resolution, rules, width, height)
    }
    const id = this.nextId++
    return await new Promise<PaintResult | null>((resolve) => {
      this.pending.set(id, { slot, resolve, layout, resolution, rules, width, height })
      this.post(slot, { type: 'paint', id, layout, resolution, width, height, rules })
    })
  }

  /** The least busy live worker (null: none). */
  private pickSlot(): Slot | null {
    let best: Slot | null = null
    for (const slot of this.slots) {
      if (slot.broken) continue
      if (best === null || slot.inFlight < best.inFlight) best = slot
    }
    return best
  }

  /** Stop every worker (tests; a page never needs to). */
  terminate(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    for (const slot of this.slots) this.breakSlot(slot)
  }
}

/** Whether a CSS `font` shorthand's family list names `family`. */
export function fontNamesFamily(font: string, family: string): boolean {
  const lower = font.toLowerCase()
  const name = family.toLowerCase()
  return (
    lower.includes(`"${name}"`) ||
    lower.includes(`'${name}'`) ||
    new RegExp(`(^|[\\s,])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(,|$)`).test(lower)
  )
}

/**
 * Paint on the page: the same painter, the document's fonts (which hold every
 * registered face: the loaders add each to `document.fonts` too). Null when
 * the text cannot be painted as the engine draws it.
 */
let pageSupport: PaintSupport | null = null

export function paintOnMainThread(
  layout: TextRunLayout,
  resolution: number,
  rules: PaintRules,
  width: number,
  height: number,
): PaintResult | null {
  const t0 = performance.now()
  perfCount('text.paint.main')
  try {
    if (typeof OffscreenCanvas === 'function') {
      const canvas = new OffscreenCanvas(Math.max(1, width), Math.max(1, height))
      const ctx = canvas.getContext('2d')
      if (ctx !== null) {
        pageSupport ??= { scratch: offscreenScratch() }
        paintRuns(ctx, layout, resolution, rules, pageSupport)
        return { bitmap: canvas.transferToImageBitmap(), where: 'main', ms: performance.now() - t0 }
      }
    }
    return null
  } catch {
    return null
  }
}

let shared: TextRasterPool | null = null

/** The page's pool (made on first use). */
export function textRasterPool(): TextRasterPool {
  if (shared === null) shared = new TextRasterPool()
  return shared
}
