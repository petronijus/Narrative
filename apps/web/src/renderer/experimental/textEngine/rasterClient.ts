/**
 * renderer/experimental/textEngine/rasterClient.ts — the main thread's side
 * of the E7 spike's text workers (EXPERIMENTAL): a small pool, the faces
 * every worker must know, and promises for paints and SDF glyphs.
 *
 * A text's work goes to the worker that has its kept layout (by key), so a
 * repaint finds it; new keys go round-robin.
 */

import type { LayoutOptions } from './blockLayout.js'
import type {
  FontMessage,
  FromWorker,
  PaintResult,
  SdfMessage,
  SdfResult,
  ToWorker,
} from './protocol.js'
import type { TextRunLayout } from './runs.js'
import type { TextBlock } from './textBlock.js'

type Pending = { resolve: (r: FromWorker) => void; reject: (e: Error) => void }

/** Distributive Omit: drops `key` from every member of a union. */
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never

export class TextRasterPool {
  private readonly workers: Worker[] = []
  private readonly pending = new Map<number, Pending>()
  private readonly home = new Map<string, number>()
  private nextId = 1
  private nextWorker = 0

  constructor(size: number) {
    for (let i = 0; i < Math.max(1, size); i++) {
      const w = new Worker(new URL('./rasterWorker.ts', import.meta.url), { type: 'module' })
      w.onmessage = (e: MessageEvent<FromWorker>) => this.settle(e.data)
      w.onerror = (e) => console.error('[textEngine] worker error', e.message)
      this.workers.push(w)
    }
  }

  get size(): number {
    return this.workers.length
  }

  private settle(msg: FromWorker): void {
    const p = this.pending.get(msg.id)
    if (p === undefined) return
    this.pending.delete(msg.id)
    if (msg.type === 'error') p.reject(new Error(msg.message))
    else p.resolve(msg)
  }

  private send(
    worker: number,
    msg: WithoutId<ToWorker>,
    transfer: Transferable[] = [],
  ): Promise<FromWorker> {
    const id = this.nextId++
    return new Promise<FromWorker>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.workers[worker]!.postMessage({ ...msg, id } as ToWorker, transfer)
    })
  }

  private workerFor(key: string): number {
    let w = this.home.get(key)
    if (w === undefined) {
      w = this.nextWorker
      this.nextWorker = (this.nextWorker + 1) % this.workers.length
      this.home.set(key, w)
    }
    return w
  }

  /** Give every worker a face (a copy of the bytes each). */
  async registerFont(
    family: string,
    bytes: ArrayBuffer,
    descriptors: FontMessage['descriptors'],
  ): Promise<void> {
    await Promise.all(
      this.workers.map((_, i) => {
        const copy = bytes.slice(0)
        return this.send(i, { type: 'font', family, bytes: copy, descriptors }, [copy])
      }),
    )
  }

  /** Paint a main-thread layout (candidate a2). */
  async paint(key: string, layout: TextRunLayout, resolution: number): Promise<PaintResult> {
    return (await this.send(this.workerFor(key), {
      type: 'paint',
      key,
      layout,
      resolution,
    })) as PaintResult
  }

  /** Lay out and paint in the worker (candidate a1). */
  async layoutPaint(
    key: string,
    block: TextBlock,
    resolution: number,
    options: LayoutOptions,
  ): Promise<PaintResult> {
    return (await this.send(this.workerFor(key), {
      type: 'layoutPaint',
      key,
      block,
      resolution,
      options,
    })) as PaintResult
  }

  /** Paint a kept layout at another resolution. */
  async repaint(key: string, resolution: number): Promise<PaintResult> {
    return (await this.send(this.workerFor(key), {
      type: 'repaint',
      key,
      resolution,
    })) as PaintResult
  }

  /** Forget every kept layout. */
  async forgetAll(): Promise<void> {
    this.home.clear()
    await Promise.all(this.workers.map((_, i) => this.send(i, { type: 'forget', keys: 'all' })))
  }

  /** SDF glyphs of one face, from the next worker. */
  async sdf(msg: WithoutId<SdfMessage>): Promise<SdfResult> {
    const w = this.nextWorker
    this.nextWorker = (this.nextWorker + 1) % this.workers.length
    return (await this.send(w, msg)) as SdfResult
  }

  terminate(): void {
    for (const w of this.workers) w.terminate()
    for (const p of this.pending.values()) p.reject(new Error('terminated'))
    this.pending.clear()
  }
}
