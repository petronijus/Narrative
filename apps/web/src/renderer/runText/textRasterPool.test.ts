// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { _resetFontChangesForTests, removeHtmlTextFace, setHtmlTextFace } from '../fontChanges.js'
import type { TextRunLayout } from './glyphRuns.js'
import type { FromWorker, ToWorker } from './protocol.js'
import { fontNamesFamily, TextRasterPool, type PaintResult } from './textRasterPool.js'

/** A worker the test drives: it records what it was sent and answers when told. */
class FakeWorker {
  static all: FakeWorker[] = []
  sent: ToWorker[] = []
  onmessage: ((e: MessageEvent<FromWorker>) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  terminated = false
  constructor() {
    FakeWorker.all.push(this)
  }
  postMessage(msg: ToWorker): void {
    this.sent.push(msg)
  }
  terminate(): void {
    this.terminated = true
  }
  answer(msg: FromWorker): void {
    this.onmessage?.({ data: msg } as MessageEvent<FromWorker>)
  }
  ready(fonts = true): void {
    this.answer({ type: 'ready', canPaint: true, fonts })
  }
  fail(message: string): void {
    this.onerror?.({ message } as ErrorEvent)
  }
  paints(): Extract<ToWorker, { type: 'paint' }>[] {
    return this.sent.filter((m): m is Extract<ToWorker, { type: 'paint' }> => m.type === 'paint')
  }
}

const layout = (font = '400 16px Arial'): TextRunLayout => ({
  width: 10,
  height: 10,
  padding: 0,
  runs: [{ text: 'a', x: 0, y: 8, font, stretch: 100, color: '#000', letterSpacing: 0, width: 5 }],
  decorations: [],
})

const rules = { snapBaseline: true, decorations: 'chromium' as const, strokeMiterLimit: 4 }
const bitmap = { width: 10, height: 10, close() {} } as unknown as ImageBitmap

function makePool(size = 1, readyTimeoutMs = 1000) {
  const onPage: Array<[TextRunLayout, number]> = []
  const pool = new TextRasterPool({
    size,
    readyTimeoutMs,
    createWorker: () => new FakeWorker() as unknown as Worker,
    paintOnPage: (l, r): PaintResult => {
      onPage.push([l, r])
      return { bitmap, where: 'main', ms: 0 }
    },
  })
  return { pool, onPage }
}

const ttf = (marker: number) => new Uint8Array([0, 1, 0, 0, marker]).buffer

afterEach(() => {
  FakeWorker.all = []
  _resetFontChangesForTests()
  vi.useRealTimers()
})

describe('TextRasterPool', () => {
  it('sends every face, those registered before and after it started, before the paints that follow', async () => {
    setHtmlTextFace({ key: 'a', family: 'Brand', weight: '400', style: 'normal', bytes: ttf(1) })
    const { pool } = makePool()
    const first = pool.paint(layout(), 2, rules)
    const w = FakeWorker.all[0]!
    w.ready()
    await Promise.resolve()
    await Promise.resolve()
    setHtmlTextFace({ key: 'b', family: 'Brand', weight: '700', style: 'normal', bytes: ttf(2) })
    const second = pool.paint(layout(), 1, rules)
    await Promise.resolve()
    await Promise.resolve()
    removeHtmlTextFace('a')
    expect(
      w.sent.map((m) =>
        m.type === 'paint' ? `paint@${m.resolution}` : `${m.type}:${'key' in m ? m.key : ''}`,
      ),
    ).toEqual(['face:a', 'paint@2', 'face:b', 'paint@1', 'dropFace:a'])
    // Each worker gets a copy of the bytes (transferred), not the registry's.
    const face = w.sent[0] as Extract<ToWorker, { type: 'face' }>
    expect(new Uint8Array(face.bytes)[4]).toBe(1)
    for (const p of w.paints()) w.answer({ type: 'painted', id: p.id, bitmap, ms: 1 })
    await expect(first).resolves.toMatchObject({ where: 'worker' })
    await expect(second).resolves.toMatchObject({ where: 'worker' })
  })

  it('paints on the page when no worker says it is ready in time (a CSP that blocks it)', async () => {
    vi.useFakeTimers()
    const { pool, onPage } = makePool(1, 50)
    const p = pool.paint(layout(), 1, rules)
    await vi.advanceTimersByTimeAsync(60)
    await expect(p).resolves.toMatchObject({ where: 'main' })
    expect(onPage).toHaveLength(1)
    expect(FakeWorker.all[0]!.terminated).toBe(true)
    expect(pool.workers).toBe(0)
  })

  it('paints a crashed worker’s pending texts on the page, and the next ones on the live workers', async () => {
    const { pool, onPage } = makePool(2)
    const p1 = pool.paint(layout(), 1, rules)
    const p2 = pool.paint(layout(), 1, rules)
    const [w1, w2] = FakeWorker.all as [FakeWorker, FakeWorker]
    w1.ready()
    w2.ready()
    await new Promise((r) => setTimeout(r, 0))
    // One paint each (least busy first).
    expect(w1.paints()).toHaveLength(1)
    expect(w2.paints()).toHaveLength(1)
    w1.fail('crashed')
    await expect(p1).resolves.toMatchObject({ where: 'main' })
    expect(onPage).toHaveLength(1)
    w2.answer({ type: 'painted', id: w2.paints()[0]!.id, bitmap, ms: 1 })
    await expect(p2).resolves.toMatchObject({ where: 'worker' })
    const p3 = pool.paint(layout(), 1, rules)
    await new Promise((r) => setTimeout(r, 0))
    expect(w2.paints()).toHaveLength(2)
    w2.answer({ type: 'painted', id: w2.paints()[1]!.id, bitmap, ms: 1 })
    await expect(p3).resolves.toMatchObject({ where: 'worker' })
  })

  it('resolves to null when the worker cannot paint the text (the caller falls back)', async () => {
    const { pool } = makePool()
    const p = pool.paint(layout(), 1, rules)
    const w = FakeWorker.all[0]!
    w.ready()
    await new Promise((r) => setTimeout(r, 0))
    w.answer({ type: 'paintFailed', id: w.paints()[0]!.id, message: 'unpaintable' })
    await expect(p).resolves.toBeNull()
  })

  it('paints texts in a registered family on the page where the workers have no fonts', async () => {
    setHtmlTextFace({ key: 'a', family: 'Brand', weight: '400', style: 'normal', bytes: ttf(1) })
    const { pool, onPage } = makePool()
    const inBrand = pool.paint(layout('400 16px Brand, Arial'), 1, rules)
    FakeWorker.all[0]!.ready(false)
    await expect(inBrand).resolves.toMatchObject({ where: 'main' })
    const inArial = pool.paint(layout('400 16px Arial'), 1, rules)
    await new Promise((r) => setTimeout(r, 0))
    expect(FakeWorker.all[0]!.paints()).toHaveLength(1)
    expect(onPage).toHaveLength(1)
    void inArial
  })

  it('paints a family on the page once a face of it failed in a worker', async () => {
    setHtmlTextFace({ key: 'a', family: 'Brand', weight: '400', style: 'normal', bytes: ttf(1) })
    const { pool, onPage } = makePool()
    void pool.paint(layout('400 16px Arial'), 1, rules)
    const w = FakeWorker.all[0]!
    w.ready()
    w.answer({ type: 'faceFailed', key: 'a', message: 'bad font' })
    await expect(pool.paint(layout('700 16px "Brand", Arial'), 1, rules)).resolves.toMatchObject({
      where: 'main',
    })
    expect(onPage).toHaveLength(1)
  })
})

describe('fontNamesFamily', () => {
  it('finds a family in a computed font-family list, quoted or not', () => {
    expect(fontNamesFamily('italic 700 16px "Brand Sans", Arial', 'Brand Sans')).toBe(true)
    expect(fontNamesFamily('400 16px Inter, Arial', 'Inter')).toBe(true)
    expect(fontNamesFamily('400 16px Interstate, Arial', 'Inter')).toBe(false)
    expect(fontNamesFamily('400 16px Arial, Inter', 'inter')).toBe(true)
  })
})
