/**
 * text-edit-transition.spec.ts — entering and leaving text edit mode shows the
 * text in every frame, at one place (ADR 0018 → Decision: Petr, 2026-10-26).
 *
 * Double-clicking a text fades its canvas node and shows the edit overlay
 * (ui/TextEditOverlay.tsx); leaving (Esc, a click elsewhere) removes the
 * overlay and shows the node again. Between those, no painted frame may:
 *
 *   - show neither (the text blinks out): a faded node and no overlay;
 *   - show a canvas text whose raster is not of its current text and style
 *     (the old text for a frame after typing, a fallback-font raster);
 *   - put the overlay's first line, or the canvas node, anywhere but where
 *     it settles.
 *
 * Frames are observed in the page: every render of the Pixi app records the
 * canvas side (the object's HTMLText nodes: alpha, whether the texture is the
 * one of its current `styleKey`, world position), and an animation-frame loop
 * records the DOM side (the overlay: present, visible, its first line's
 * position); both are keyed by the frame's timestamp
 * (`document.timeline.currentTime`), and a frame's state is the last record
 * of each side at or before it. Positions are compared with the settled ones
 * (0.5 device px). Each transition runs on fresh text and again right after
 * typing a character, the case where the canvas raster lags.
 */

import type { Page } from '@playwright/test'
import { expect, test } from './fixtures/test'
import { createDeckInFolder, seedFontFolder } from './fixtures/customFonts'
import { customFontSlide, textCorpusOps, type CorpusSlide } from './fixtures/textCorpus'
import { applyOps } from './perf/lib/seed'
import type { PerfHarnessApi } from '../src/perf/harness'

declare global {
  interface Window {
    __narrative_perf_harness?: PerfHarnessApi
  }
}

const VIEWPORT = { width: 1600, height: 1000 }
const DPR = Number(process.env['TEXT_EDIT_DPR'] ?? '1')
const TOLERANCE = 0.5
/** The alpha a text is drawn at while edited (renderer/editedTextAlpha.ts). */
const FADED = 1 / 1024
const EDITOR = '[data-shortcut-scope="canvas"] [contenteditable="true"]'

/** The texts the transitions run on: slide name → object ids (a table: cells). */
const TARGETS: Array<{ slide: string; id: string; cell?: { row: number; col: number } }> = [
  { slide: 'alignment', id: 'al-left-top' },
  { slide: 'alignment', id: 'al-right-bottom' },
  { slide: 'alignment', id: 'al-center-middle' },
  { slide: 'autofit', id: 'fit-shrink' },
  { slide: 'lists', id: 'list-bullets' },
  { slide: 'runs', id: 'run-runs' },
  { slide: 'scripts', id: 'sc-japanese' },
  { slide: 'table', id: 'tbl', cell: { row: 1, col: 1 } },
  { slide: 'transformed', id: 'tr-rot15' },
  { slide: 'custom-fonts', id: 'cf-tall-bottom' },
  { slide: 'custom-fonts', id: 'cf-var-700' },
  { slide: 'custom-fonts', id: 'cf-missing' },
]

async function settle(page: Page): Promise<void> {
  const r = await page.evaluate(() =>
    window.__narrative_perf_harness!.settle({ quietMs: 400, timeoutMs: 60_000 }),
  )
  expect(r.ok, `the scene settled: ${r.reason ?? ''}`).toBe(true)
}

/** One frame as painted: the canvas side and the DOM side. */
interface FrameState {
  t: number
  /** Per HTMLText of the object: alpha, texture current, world position (device px). */
  nodes: Array<{ alpha: number; current: boolean; x: number; y: number }>
  overlay: { x: number; y: number } | null
}

/** Start recording frames for object `id` (`window.__textEditFrames`). */
async function record(page: Page, id: string, editor: string): Promise<void> {
  await page.evaluate(
    ({ id, editor }) => {
      type Pt = { x: number; y: number }
      interface Node {
        alpha: number
        visible: boolean
        styleKey: string
        anchor?: unknown
        parent?: Node | null
        _gpuData?: Record<
          string,
          { currentKey?: string; generatingTexture?: boolean; texture?: { label?: string } }
        >
        getGlobalTransform(): { tx: number; ty: number }
        children?: Node[]
        destroyed?: boolean
      }
      const w = window as unknown as {
        __narrative_scene_graph: { getContainer(id: string): Node | undefined }
        __narrative_perf: {
          app: { renderer: { render: (...a: unknown[]) => unknown; resolution: number } }
        }
        __textEditFrames?: {
          canvas: Array<[number, FrameState['nodes']]>
          dom: Array<[number, FrameState['overlay']]>
          stop(): void
        }
      }
      w.__textEditFrames?.stop()
      const renderer = w.__narrative_perf.app.renderer
      const now = (): number => Number(document.timeline.currentTime ?? performance.now())
      const texts = (n: Node, out: Node[] = []): Node[] => {
        if (n.anchor !== undefined && typeof n.styleKey === 'string') out.push(n)
        for (const c of n.children ?? []) texts(c, out)
        return out
      }
      const canvasSide = (): FrameState['nodes'] => {
        const c = w.__narrative_scene_graph.getContainer(id)
        if (c === undefined) return []
        const k = renderer.resolution
        return texts(c).map((n) => {
          const gpu = Object.values(n._gpuData ?? {})
          // Alpha and visibility up the chain (worldAlpha / worldTransform are
          // relative to the render group in Pixi v8, and stale between its updates).
          let alpha = 1
          for (let p: Node | null | undefined = n; p != null; p = p.parent)
            alpha *= p.visible === false ? 0 : p.alpha
          const g = n.getGlobalTransform()
          return {
            alpha,
            // Drawn now: a run raster says what it is of (its label); any
            // other is current when nothing is in flight for its key.
            current:
              gpu.length > 0 &&
              gpu.every((g) =>
                g.texture?.label?.startsWith('runText:') === true
                  ? g.texture.label === `runText:${n.styleKey}`
                  : g.generatingTexture !== true && g.currentKey === n.styleKey,
              ),
            x: g.tx * k,
            y: g.ty * k,
          }
        })
      }
      const domSide = (): FrameState['overlay'] => {
        const el = document.querySelector(editor)
        if (el === null || !el.isConnected) return null
        const cs = getComputedStyle(el)
        if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0)
          return null
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
        let t = walker.nextNode()
        // The first text that is not a list marker.
        while (t !== null && (t.parentElement?.closest('[data-marker]') ?? null) !== null)
          t = walker.nextNode()
        if (t === null) return null
        const r = document.createRange()
        r.setStart(t, 0)
        r.setEnd(t, Math.min(1, t.textContent?.length ?? 0))
        const rect = r.getBoundingClientRect()
        return { x: rect.left * devicePixelRatio, y: rect.top * devicePixelRatio }
      }
      const canvas: Array<[number, FrameState['nodes']]> = []
      const dom: Array<[number, FrameState['overlay']]> = []
      const render = renderer.render
      renderer.render = function (this: unknown, ...a: unknown[]) {
        const r = render.apply(this, a)
        canvas.push([now(), canvasSide()])
        dom.push([now(), domSide()])
        return r
      }
      let on = true
      const loop = (): void => {
        if (!on) return
        dom.push([now(), domSide()])
        canvas.push([
          now() - 0.001,
          canvas.length > 0 ? canvas[canvas.length - 1]![1] : canvasSide(),
        ])
        requestAnimationFrame(loop)
      }
      requestAnimationFrame(loop)
      w.__textEditFrames = {
        canvas,
        dom,
        stop: () => {
          on = false
          renderer.render = render
        },
      }
      void (null as unknown as Pt)
    },
    { id, editor },
  )
}

/** Stop recording; the frames, one state per frame timestamp. */
async function frames(page: Page): Promise<FrameState[]> {
  const raw = await page.evaluate(() => {
    const w = window as unknown as {
      __textEditFrames: {
        canvas: Array<[number, unknown]>
        dom: Array<[number, unknown]>
        stop(): void
      }
    }
    w.__textEditFrames.stop()
    return { canvas: w.__textEditFrames.canvas, dom: w.__textEditFrames.dom }
  })
  const times = [...new Set([...raw.dom.map((d) => d[0])])].sort((a, b) => a - b)
  const lastAt = <T>(list: Array<[number, T]>, t: number): T | undefined => {
    let v: T | undefined
    for (const [at, x] of list) if (at <= t + 1e-6) v = x
    return v
  }
  return times.map((t) => ({
    t,
    nodes: (lastAt(raw.canvas as Array<[number, FrameState['nodes']]>, t) ??
      []) as FrameState['nodes'],
    overlay: (lastAt(raw.dom as Array<[number, FrameState['overlay']]>, t) ??
      null) as FrameState['overlay'],
  }))
}

/** What went wrong in a run of frames; empty when nothing. */
function problems(
  list: FrameState[],
  settledEdit: FrameState['overlay'],
  settledCanvas: FrameState['nodes'],
): string[] {
  const out: string[] = []
  for (const f of list) {
    // Faded = drawn at the edit fade (renderer/editedTextAlpha.ts, 1/1024) or less.
    const shown = f.nodes.filter((n) => n.alpha > FADED)
    const faded = f.nodes.some((n) => n.alpha <= FADED)
    if (faded && f.overlay === null)
      out.push(`${f.t.toFixed(1)}: text faded and no overlay (blinks out)`)
    for (const [i, n] of f.nodes.entries()) {
      if (n.alpha <= FADED) continue
      if (!n.current) out.push(`${f.t.toFixed(1)}: canvas text ${i} drawn with a stale raster`)
      const s = settledCanvas[i]
      if (s !== undefined && (Math.abs(n.x - s.x) > TOLERANCE || Math.abs(n.y - s.y) > TOLERANCE))
        out.push(
          `${f.t.toFixed(1)}: canvas text ${i} at ${n.x.toFixed(2)},${n.y.toFixed(2)}, settles at ${s.x.toFixed(2)},${s.y.toFixed(2)}`,
        )
    }
    if (f.overlay !== null && settledEdit !== null) {
      const dx = Math.abs(f.overlay.x - settledEdit.x)
      const dy = Math.abs(f.overlay.y - settledEdit.y)
      if (dx > TOLERANCE || dy > TOLERANCE)
        out.push(
          `${f.t.toFixed(1)}: overlay at ${f.overlay.x.toFixed(2)},${f.overlay.y.toFixed(2)}, settles at ${settledEdit.x.toFixed(2)},${settledEdit.y.toFixed(2)}`,
        )
    }
    if (shown.length === 0 && f.nodes.length > 0 && f.overlay === null)
      out.push(`${f.t.toFixed(1)}: nothing shows the text`)
  }
  return out
}

async function clickPoint(
  page: Page,
  id: string,
  cell?: { row: number; col: number },
): Promise<{ x: number; y: number }> {
  return await page.evaluate(
    ({ id, cell }) => {
      type Pt = { x: number; y: number }
      const sg = (
        window as unknown as {
          __narrative_scene_graph: { getContainer(id: string): { toGlobal(p: Pt): Pt } | undefined }
        }
      ).__narrative_scene_graph
      const c = sg.getContainer(id)!
      const data = window.__narrative_perf_harness!.object(id) as unknown as {
        width: number
        height: number
        colWidths?: number[]
        rowHeights?: number[]
      }
      // The world's origin: the canvas's container (ADR 0020).
      const canvas = document.querySelector('.artboard canvas')!.parentElement as HTMLElement
      const rect = canvas.getBoundingClientRect()
      const k = rect.width / canvas.offsetWidth
      let local: Pt
      if (cell !== undefined && data.colWidths !== undefined && data.rowHeights !== undefined) {
        const x0 = data.colWidths.slice(0, cell.col).reduce((a, b) => a + b, 0)
        const y0 = data.rowHeights.slice(0, cell.row).reduce((a, b) => a + b, 0)
        local = { x: x0 + data.colWidths[cell.col]! / 2, y: y0 + data.rowHeights[cell.row]! / 2 }
      } else {
        // The container's local origin is the box's centre (pivot).
        local = { x: data.width / 2, y: data.height / 2 }
        const p = c.toGlobal({ x: 0, y: 0 })
        void p
      }
      const g = c.toGlobal(local)
      return { x: rect.left + g.x * k, y: rect.top + g.y * k }
    },
    { id, cell },
  )
}

/** A point of the editor's stage outside the slide (its pasteboard): a click there ends editing. */
async function pasteboardPoint(page: Page): Promise<{ x: number; y: number }> {
  const p = await page.evaluate(() => {
    const a = document.querySelector('.artboard')!.getBoundingClientRect()
    const scope = document.querySelector('[data-shortcut-scope="canvas"]')
    const candidates = [
      { x: a.left + a.width / 2, y: a.bottom + 14 },
      { x: a.left + a.width / 2, y: a.top - 14 },
      { x: a.left - 14, y: a.top + a.height / 2 },
      { x: a.right + 14, y: a.top + a.height / 2 },
    ]
    for (const c of candidates) {
      const el = document.elementFromPoint(c.x, c.y)
      if (el !== null && scope !== null && scope.contains(el) && el.closest('.artboard') === null)
        return c
    }
    return null
  })
  expect(p, 'a point of the stage outside the slide').not.toBeNull()
  return p!
}

/** The settled overlay position for `id` (in edit mode, nothing changing). */
async function settledOverlay(page: Page): Promise<FrameState['overlay']> {
  await page.waitForTimeout(400)
  return await page.evaluate((editor) => {
    const el = document.querySelector(editor)
    if (el === null) return null
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let t = walker.nextNode()
    while (t !== null && (t.parentElement?.closest('[data-marker]') ?? null) !== null)
      t = walker.nextNode()
    if (t === null) return null
    const r = document.createRange()
    r.setStart(t, 0)
    r.setEnd(t, Math.min(1, t.textContent?.length ?? 0))
    const rect = r.getBoundingClientRect()
    return { x: rect.left * devicePixelRatio, y: rect.top * devicePixelRatio }
  }, EDITOR)
}

/** The settled canvas nodes for `id`. */
async function settledCanvas(page: Page, id: string): Promise<FrameState['nodes']> {
  await settle(page)
  await record(page, id, EDITOR)
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  )
  const f = await frames(page)
  return f[f.length - 1]?.nodes ?? []
}

test('entering and leaving edit mode never moves, drops or stales the text', async ({
  browser,
  request,
}) => {
  test.setTimeout(30 * 60_000)
  const { folderId, families } = await seedFontFolder(request, `text edit transition ${Date.now()}`)
  const deckId = await createDeckInFolder(request, folderId, `text edit transition ${Date.now()}`)
  const { ops, slides } = textCorpusOps()
  const fonts = customFontSlide(slides.length, families)
  await applyOps(request, deckId, [...ops, { command: 'slide.add', input: {} }, ...fonts.ops])
  slides.push(fonts)

  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DPR })
  const page = await context.newPage()
  await page.goto(`/deck/${deckId}?perf=1`)
  await expect
    .poll(() => page.evaluate(() => window.__narrative_perf_harness?.version ?? 0), {
      timeout: 30_000,
    })
    .toBe(1)

  const report: string[] = []
  let shownSlide = ''
  for (const target of TARGETS) {
    const index = slides.findIndex((s: CorpusSlide) => s.name === target.slide)
    expect(index, `slide ${target.slide}`).toBeGreaterThanOrEqual(0)
    const s = slides[index]!
    const ids = target.cell === undefined ? [target.id] : [target.id]
    expect(s.ids, `${target.slide} has ${target.id}`).toEqual(expect.arrayContaining(ids))
    if (shownSlide !== s.name) {
      await page.locator('[role="option"][data-slide-id]').nth(index).click()
      await expect
        .poll(
          () =>
            page.evaluate(
              (id) => window.__narrative_perf_harness!.mountedIds().includes(id),
              target.id,
            ),
          {
            timeout: 60_000,
          },
        )
        .toBe(true)
      await page.getByRole('button', { name: 'Reset zoom to 100%' }).hover()
      await page.getByRole('button', { name: 'Fit to screen' }).click()
      shownSlide = s.name
    }
    const label =
      target.cell === undefined ? target.id : `${target.id}[${target.cell.row},${target.cell.col}]`
    for (const [how, typing] of [
      ['Esc', false],
      ['Esc after typing', true],
      ['click-away', false],
      ['click-away after typing', true],
    ] as const) {
      await page.mouse.move(2, VIEWPORT.height - 2)
      const before = await settledCanvas(page, target.id)
      const at = await clickPoint(page, target.id, target.cell)
      await record(page, target.id, EDITOR)
      await page.mouse.dblclick(at.x, at.y)
      await expect(page.locator(EDITOR).first()).toBeVisible()
      const editAt = await settledOverlay(page)
      const entering = await frames(page)
      await record(page, target.id, EDITOR)
      if (typing) await page.keyboard.type('x')
      if (how.startsWith('Esc')) await page.keyboard.press('Escape')
      else {
        const away = await pasteboardPoint(page)
        await page.mouse.click(away.x, away.y)
      }
      await expect(page.locator(EDITOR)).toHaveCount(0)
      await settle(page)
      await page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
      )
      const leaving = await frames(page)
      const after = await settledCanvas(page, target.id)
      const found = [
        ...problems(entering, editAt, before).map((p) => `enter: ${p}`),
        ...problems(leaving, typing ? null : editAt, after).map((p) => `leave: ${p}`),
      ]
      // The canvas text settles where it was (typing at the end changes no
      // earlier line's place).
      for (const [i, n] of before.entries()) {
        const a = after[i]
        if (a === undefined || typing) continue
        if (Math.abs(a.x - n.x) > TOLERANCE || Math.abs(a.y - n.y) > TOLERANCE)
          found.push(`canvas text ${i} settled at another place after editing`)
      }
      report.push(
        `${label} ${how}: ${entering.length}+${leaving.length} frames, ${found.length === 0 ? 'ok' : found.slice(0, 6).join('; ')}`,
      )
      expect.soft(found, `${label} ${how}`).toEqual([])
      if (typing) {
        // Undo the typed character for the next round.
        await page.keyboard.press('ControlOrMeta+z')
        await settle(page)
      }
      await page.keyboard.press('Escape')
    }
  }
  console.log(report.join('\n'))
  await context.close()
})
