/**
 * text-edit-parity.spec.ts — a text sits exactly where it sits in edit mode
 * (ADR 0018 → Decision: Petr, 2026-10-26).
 *
 * The canvas draws a text from glyph runs; double-clicking it hands it to the
 * edit overlay (ui/TextEditOverlay.tsx: a contenteditable laid out by the
 * page, the canvas text faded). The two must put every line and every word at
 * the same place, or the text visibly jumps on entering and leaving edit mode.
 *
 * For each text of the corpus (fixtures/textCorpus.ts: families, sizes,
 * spacing, alignment, autofit, lists, runs, underline, scripts incl. CJK,
 * table cells, rotated and translucent boxes, a sample of the crowded slide)
 * at the fitted zoom, 100 % and ≈2.2×: a screenshot of the canvas alone
 * around the text, then — in edit mode — of the overlay alone, both over
 * white, and their ink compared:
 *
 *   - per line (the overlay's line boxes, two lines split at the emptiest
 *     row where their boxes meet): the ink-weighted centre's y (its x
 *     is reported, not gated: it moves when words merely draw heavier, in
 *     proportion to their widths — renderer/runText/inkCentres.ts);
 *   - per word (column runs of ink within a line): the centre x;
 *   - a rotated box: the centre of all its ink;
 *   - coverage: the overlay's ink within ±25 % of the canvas's.
 *
 * Centres, not pixels: an engine need not draw its HTML text and its canvas
 * text alike — WebKit's HTML glyphs past ~180 device px are heavier, more to
 * the left (ADR 0018 → The residue). Tolerance:
 * 0.5 device px. DPR from TEXT_EDIT_DPR (default 1); `TEXT_EDIT_SLIDES=`
 * filters slides. Chromium and WebKit (`just e2e-webkit -g text-edit-parity`).
 */

import { writeFileSync } from 'node:fs'
import type { Browser, Page } from '@playwright/test'
import { PNG } from 'pngjs'
import { expect, test } from './fixtures/test'
import { createDeckInFolder, seedFontFolder } from './fixtures/customFonts'
import { exportedCorpusPptx, importPptx } from './fixtures/importPptx'
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
const ONLY = (process.env['TEXT_EDIT_SLIDES'] ?? '').split(',').filter((s) => s !== '')
/** Device px a centre may move by between the canvas and the overlay. */
const TOLERANCE = 0.5
const EDITOR = '[data-shortcut-scope="canvas"] [contenteditable="true"]'

const ONLY_CANVAS =
  '* { visibility: hidden !important } .artboard canvas { visibility: visible !important }'
/**
 * The edit overlay's box keeps its outline, made transparent: hidden, it
 * leaves the overlay's layer (Chromium composites the box over the WebGL
 * canvas) with other bounds — the raster the compositor turns starts at the
 * outline's corner, as it does in use (renderer/runText/runTextSystem.ts →
 * RIG_OUTLINE).
 */
const KEEP_OUTLINE =
  ' [data-shortcut-scope="canvas"] [style*="dashed"] { visibility: visible !important; ' +
  'outline-color: transparent !important }'
/**
 * The canvas alone while the editor is open: the editor stays visible (a
 * `visibility: hidden` blurs it, which ends edit mode) but transparent.
 */
const ONLY_CANVAS_EDITING =
  ONLY_CANVAS +
  KEEP_OUTLINE +
  ' [data-shortcut-scope="canvas"] [contenteditable="true"], [data-shortcut-scope="canvas"] [contenteditable="true"] * { visibility: visible !important; ' +
  'opacity: 0 !important; caret-color: transparent !important }'
/**
 * The editor over the canvas without the edited text (it is faded): both
 * pictures of the text are then measured against the same background — the
 * canvas around it, light text on a dark fill included.
 */
const EDITOR_OVER_CANVAS =
  ONLY_CANVAS +
  KEEP_OUTLINE +
  ' [data-shortcut-scope="canvas"] [contenteditable="true"], [data-shortcut-scope="canvas"] [contenteditable="true"] * { visibility: visible !important; ' +
  'outline: none !important; caret-color: transparent !important }'

async function settle(page: Page): Promise<void> {
  const r = await page.evaluate(() =>
    window.__narrative_perf_harness!.settle({ quietMs: 600, timeoutMs: 60_000 }),
  )
  expect(r.ok, `the scene settled: ${r.reason ?? ''}`).toBe(true)
}

async function open(browser: Browser, deckId: string): Promise<Page> {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DPR })
  const page = await context.newPage()
  await page.goto(`/deck/${deckId}?perf=1`)
  await expect
    .poll(() => page.evaluate(() => window.__narrative_perf_harness?.version ?? 0), {
      timeout: 30_000,
    })
    .toBe(1)
  return page
}

async function showSlide(page: Page, index: number, s: CorpusSlide): Promise<void> {
  await page.locator('[role="option"][data-slide-id]').nth(index).click()
  await expect
    .poll(
      () =>
        page.evaluate(
          (ids) => ids.every((id) => window.__narrative_perf_harness!.mountedIds().includes(id)),
          s.ids,
        ),
      { timeout: 60_000 },
    )
    .toBe(true)
  await page.mouse.move(2, VIEWPORT.height - 2)
  await settle(page)
}

async function fit(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Reset zoom to 100%' }).hover()
  await page.getByRole('button', { name: 'Fit to screen' }).click()
  await settle(page)
}

async function zoomTo100(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Reset zoom to 100%' }).click()
  await settle(page)
}

/** Wheel steps of the zoomed state (`TEXT_EDIT_ZOOM_STEPS`, default 8: the editor's 400 % from fit). */
const ZOOM_STEPS = Number(process.env['TEXT_EDIT_ZOOM_STEPS'] ?? '8')

async function zoomIn(page: Page): Promise<void> {
  const a = (await page.locator('.artboard').boundingBox())!
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.keyboard.down('ControlOrMeta')
  for (let i = 0; i < ZOOM_STEPS; i++) {
    await page.mouse.wheel(0, -50)
    await page.waitForTimeout(25)
  }
  await page.keyboard.up('ControlOrMeta')
  await page.mouse.move(2, VIEWPORT.height - 2)
  await settle(page)
}

/** Whether a text of object `id` is faded (being edited) on the canvas. */
async function faded(page: Page, id: string): Promise<boolean> {
  return await page.evaluate((id) => {
    interface N {
      alpha: number
      anchor?: unknown
      children?: N[]
    }
    const sg = (
      window as unknown as { __narrative_scene_graph: { getContainer(id: string): N | undefined } }
    ).__narrative_scene_graph
    const walk = (n: N): boolean =>
      (n.anchor !== undefined && n.alpha <= 1 / 1024) || (n.children ?? []).some(walk)
    const c = sg.getContainer(id)
    return c !== undefined && walk(c)
  }, id)
}

/** The editor stage's scroll position. */
async function stageScroll(page: Page): Promise<{ x: number; y: number }> {
  return await page.evaluate(() => {
    let el: HTMLElement | null = document.querySelector('.artboard')
    while (el !== null) {
      const cs = getComputedStyle(el)
      if (/(auto|scroll)/.test(cs.overflow + cs.overflowX + cs.overflowY)) break
      el = el.parentElement
    }
    return el === null ? { x: 0, y: 0 } : { x: el.scrollLeft, y: el.scrollTop }
  })
}

/** Scroll the editor's stage so page point `p` comes to the middle of the canvas area. */
async function centreOn(page: Page, p: { x: number; y: number }): Promise<void> {
  await page.evaluate((p) => {
    let el: HTMLElement | null = document.querySelector('.artboard')
    while (el !== null) {
      const cs = getComputedStyle(el)
      if (
        /(auto|scroll)/.test(cs.overflow + cs.overflowX + cs.overflowY) &&
        (el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight)
      )
        break
      el = el.parentElement
    }
    if (el === null) return
    const r = el.getBoundingClientRect()
    el.scrollLeft += p.x - (r.left + r.width / 2)
    el.scrollTop += p.y - (r.top + r.height / 2)
  }, p)
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  )
  await settle(page)
}

/** A target on the page: where to double-click, the region around it, whether it is rotated. */
interface Target {
  id: string
  label: string
  click: { x: number; y: number }
  box: { x: number; y: number; width: number; height: number }
  rotated: boolean
  visible: boolean
  /** The part of `box` the editor's view shows (null: too little of it). */
  inView: { x: number; y: number; width: number; height: number } | null
}

/** Page coordinates of an object (or a table cell), from the live scene graph. */
async function targetOf(
  page: Page,
  id: string,
  cell?: { row: number; col: number },
): Promise<Target | null> {
  const t = await page.evaluate(
    ({ id, cell }) => {
      type Pt = { x: number; y: number }
      const sg = (
        window as unknown as {
          __narrative_scene_graph?: {
            getContainer(id: string): { toGlobal(p: Pt): Pt; rotation: number } | undefined
            getBounds(id: string): { corners: Pt[]; rotation: number } | null
          }
        }
      ).__narrative_scene_graph
      const c = sg?.getContainer(id)
      if (sg === undefined || c === undefined) return null
      // The world's origin: the canvas's container (the canvas draws a region of it — ADR 0020).
      const canvas = (document.querySelector('.artboard canvas')?.parentElement ??
        null) as HTMLElement | null
      if (canvas === null) return null
      const rect = canvas.getBoundingClientRect()
      const k = rect.width / canvas.offsetWidth
      const toPage = (p: Pt): Pt => ({ x: rect.left + p.x * k, y: rect.top + p.y * k })
      const data = window.__narrative_perf_harness!.object(id) as unknown as {
        width: number
        height: number
        colWidths?: number[]
        rowHeights?: number[]
      } | null
      if (data === null) return null
      let corners: Pt[]
      if (cell !== undefined && data.colWidths !== undefined && data.rowHeights !== undefined) {
        const x0 = data.colWidths.slice(0, cell.col).reduce((a, b) => a + b, 0)
        const y0 = data.rowHeights.slice(0, cell.row).reduce((a, b) => a + b, 0)
        const w = data.colWidths[cell.col]!
        const h = data.rowHeights[cell.row]!
        corners = [
          { x: x0, y: y0 },
          { x: x0 + w, y: y0 },
          { x: x0 + w, y: y0 + h },
          { x: x0, y: y0 + h },
        ].map((p) => toPage(c.toGlobal(p)))
      } else {
        const b = sg.getBounds(id)
        if (b === null) return null
        const parent = (c as unknown as { parent: { toGlobal(p: Pt): Pt } }).parent
        corners = b.corners.map((p) => toPage(parent.toGlobal(p)))
      }
      const xs = corners.map((p) => p.x)
      const ys = corners.map((p) => p.y)
      // Every corner (a little inside) and the centre over the canvas
      // itself — not under a panel, not off the editor's viewport.
      const scope = document.querySelector('[data-shortcut-scope="canvas"]')
      const over = (x: number, y: number): boolean => {
        const el = document.elementFromPoint(x, y)
        return (
          el !== null && scope !== null && scope.contains(el) && el.closest('.artboard') !== null
        )
      }
      const pad = 2
      const visible =
        over((Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2) &&
        over(Math.min(...xs) - pad, Math.min(...ys) - pad) &&
        over(Math.max(...xs) + pad, Math.min(...ys) - pad) &&
        over(Math.max(...xs) + pad, Math.max(...ys) + pad) &&
        over(Math.min(...xs) - pad, Math.max(...ys) + pad)
      // The part of the box the editor's view shows (a box larger than the
      // view, zoomed in): the canvas's area inset by the pictures' margin.
      let inView: { x: number; y: number; width: number; height: number } | null = null
      const drawn = document.querySelector('.artboard canvas')
      if (scope !== null && drawn !== null) {
        // The canvas's view, and within the canvas element (it draws a region).
        const sv = scope.getBoundingClientRect()
        const cv = drawn.getBoundingClientRect()
        const v = {
          left: Math.max(sv.left, cv.left),
          top: Math.max(sv.top, cv.top),
          right: Math.min(sv.right, cv.right),
          bottom: Math.min(sv.bottom, cv.bottom),
        }
        const m = 30
        const x0 = Math.max(Math.min(...xs), v.left + m, 0)
        const y0 = Math.max(Math.min(...ys), v.top + m, 0)
        const x1 = Math.min(Math.max(...xs), v.right - m, window.innerWidth)
        const y1 = Math.min(Math.max(...ys), v.bottom - m, window.innerHeight)
        if (x1 - x0 > 40 && y1 - y0 > 20) inView = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
      }
      return {
        visible,
        inView,
        click: {
          x: (Math.min(...xs) + Math.max(...xs)) / 2,
          y: (Math.min(...ys) + Math.max(...ys)) / 2,
        },
        box: {
          x: Math.min(...xs),
          y: Math.min(...ys),
          width: Math.max(...xs) - Math.min(...xs),
          height: Math.max(...ys) - Math.min(...ys),
        },
        rotated: Math.abs(c.rotation % Math.PI) > 1e-6 || Math.abs(c.rotation) > 1e-6,
      }
    },
    { id, cell },
  )
  if (t === null) return null
  return { id, label: cell === undefined ? id : `${id}[${cell.row},${cell.col}]`, ...t }
}

/**
 * The region the pictures of a target cover: its box and a margin, on whole
 * CSS px (whole device px at any DPR), so a page position maps exactly onto
 * the picture's pixels (`overlayLines`).
 */
function clipOf(box: Target['box']): { x: number; y: number; width: number; height: number } {
  const m = 24
  const x = Math.max(0, Math.floor(box.x - m))
  const y = Math.max(0, Math.floor(box.y - m))
  return {
    x,
    y,
    width: Math.min(VIEWPORT.width, Math.ceil(box.x + box.width + m)) - x,
    height: Math.min(VIEWPORT.height, Math.ceil(box.y + box.height + m)) - y,
  }
}

async function shot(page: Page, box: Target['box'], style: string): Promise<PNG> {
  return PNG.sync.read(await page.screenshot({ clip: clipOf(box), animations: 'disabled', style }))
}

/**
 * The edit overlay's lines, as the page laid them out: the line fragments of
 * its text (`Range.getClientRects` per text node) grouped by line — boxes
 * whose content areas overlap by half the smaller one lie on one line (a
 * fallback face's taller box included; consecutive lines overlap less, even
 * at a line height of 0.75). Top and bottom in device px of the pictures
 * `shot` takes of `box`, sorted from the top.
 */
async function overlayLines(
  page: Page,
  box: Target['box'],
): Promise<Array<{ top: number; bottom: number }>> {
  const clip = clipOf(box)
  const lines = await page.evaluate((selector) => {
    const root = document.querySelector(selector)
    if (root === null) return []
    const rects: Array<{ top: number; bottom: number }> = []
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    const range = document.createRange()
    for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
      range.selectNodeContents(n)
      for (const q of range.getClientRects())
        if (q.height > 0 && q.width > 0) rects.push({ top: q.top, bottom: q.bottom })
    }
    rects.sort((a, b) => a.top + a.bottom - (b.top + b.bottom))
    const out: Array<{ top: number; bottom: number }> = []
    for (const q of rects) {
      const same = out.find(
        (l) =>
          Math.min(l.bottom, q.bottom) - Math.max(l.top, q.top) >=
          Math.min(l.bottom - l.top, q.bottom - q.top) / 2,
      )
      if (same !== undefined) {
        same.top = Math.min(same.top, q.top)
        same.bottom = Math.max(same.bottom, q.bottom)
      } else out.push({ ...q })
    }
    return out
  }, EDITOR)
  return lines
    .map((l) => ({ top: (l.top - clip.y) * DPR, bottom: (l.bottom - clip.y) * DPR }))
    .sort((a, b) => a.top + a.bottom - (b.top + b.bottom))
}

/**
 * Ink of a pixel, 0–255: how much darker than the picture's background it is.
 * The background is the brightest value its border mostly has (the canvas
 * crop is the slide's white, the overlay crop the page's grey behind the
 * hidden canvas) — measured once per picture.
 */
const backgrounds = new WeakMap<PNG, number>()
function backgroundOf(png: PNG): number {
  const cached = backgrounds.get(png)
  if (cached !== undefined) return cached
  const counts = new Map<number, number>()
  const add = (x: number, y: number): void => {
    const i = (y * png.width + x) * 4
    const v = Math.min(png.data[i]!, png.data[i + 1]!, png.data[i + 2]!)
    counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  for (let x = 0; x < png.width; x++) {
    add(x, 0)
    add(x, png.height - 1)
  }
  for (let y = 0; y < png.height; y++) {
    add(0, y)
    add(png.width - 1, y)
  }
  const bg = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0]
  backgrounds.set(png, bg)
  return bg
}
function ink(png: PNG, x: number, y: number): number {
  const i = (y * png.width + x) * 4
  const v = Math.min(png.data[i]!, png.data[i + 1]!, png.data[i + 2]!)
  // Scaled so full ink on either background reads 255: centres are weighted
  // alike over white and over grey.
  const bg = backgroundOf(png)
  return bg === 0 ? 0 : (Math.max(0, bg - v) * 255) / bg
}

/**
 * How `shot` differs from `rest` (the same region without the text), as dark
 * ink on white: 255 less the largest channel difference. A text and nothing
 * else, dark or light, over whatever is behind it.
 */
function differenceFrom(shot: PNG, rest: PNG): PNG {
  const out = new PNG({ width: shot.width, height: shot.height })
  for (let i = 0; i < shot.data.length; i += 4) {
    let d = 0
    for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(shot.data[i + k]! - rest.data[i + k]!))
    // Below 4: the same pixel, encoded or blended a hair apart.
    const v = d < 4 ? 255 : 255 - d
    out.data[i] = out.data[i + 1] = out.data[i + 2] = v
    out.data[i + 3] = 255
  }
  return out
}

interface Comparison {
  lines: number
  linesOverlay: number
  /** Largest centre difference, device px. */
  lineDx: number
  lineDy: number
  wordDx: number
  coverage: number
}

/** Ink-weighted centre of a rectangle of `png`, or null without ink. */
function centre(
  png: PNG,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
): { x: number; y: number; ink: number } | null {
  let sum = 0
  let sx = 0
  let sy = 0
  for (let y = Math.max(0, y0); y < Math.min(png.height, y1); y++)
    for (let x = Math.max(0, x0); x < Math.min(png.width, x1); x++) {
      const v = ink(png, x, y)
      if (v === 0) continue
      sum += v
      sx += v * x
      sy += v * y
    }
  return sum === 0 ? null : { x: sx / sum, y: sy / sum, ink: sum }
}

/** Bands of rows (or columns) with ink: [start, end) runs, merged over gaps up to `gap`. */
function bands(profile: number[], threshold: number, gap: number): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (let i = 0; i < profile.length; i++) {
    if (profile[i]! <= threshold) continue
    const last = out[out.length - 1]
    if (last !== undefined && i - last[1] <= gap) last[1] = i + 1
    else out.push([i, i + 1])
  }
  return out
}

/**
 * Compare the two pictures line by line. The lines are the overlay's own line
 * boxes (`overlayLines`), split at the emptiest row where two boxes meet: each
 * picture's ink goes to the line the page laid it out on, an underline below
 * its box included.
 * (Lines found as bands of ink split where a row between two lines is under a
 * threshold in one picture and not in the other — a faint pixel of an
 * ascender — and a band's margin took the next line's top pixels into a
 * word's centre: misses of the measurement, not of the text.)
 *
 * `lines` / `linesOverlay`: the lines with ink in each picture — a canvas
 * that wraps otherwise leaves one without ink, or draws a line's words
 * elsewhere (`wordDx`).
 */
function compare(
  canvas: PNG,
  editor: PNG,
  rotated: boolean,
  layoutLines: Array<{ top: number; bottom: number }>,
): Comparison {
  const w = Math.min(canvas.width, editor.width)
  const h = Math.min(canvas.height, editor.height)
  const all = [centre(canvas, 0, w, 0, h), centre(editor, 0, w, 0, h)]
  if (all[0] === null && all[1] === null)
    // An empty text (a blank table cell): nothing to place either way.
    return { lines: 0, linesOverlay: 0, lineDx: 0, lineDy: 0, wordDx: 0, coverage: 1 }
  const coverage = all[0] === null || all[1] === null ? 0 : all[1].ink / all[0].ink
  if (rotated || all[0] === null || all[1] === null || layoutLines.length === 0) {
    const dx = all[0] !== null && all[1] !== null ? Math.abs(all[0].x - all[1].x) : Infinity
    const dy = all[0] !== null && all[1] !== null ? Math.abs(all[0].y - all[1].y) : Infinity
    return { lines: 1, linesOverlay: 1, lineDx: dx, lineDy: dy, wordDx: dx, coverage }
  }
  // Each line's rows: two lines are split at the emptiest row (both
  // pictures' ink) near where their boxes meet — within a quarter of a line
  // either side. Not at the boxes' edge: an underline lies below its line's
  // box, a row into the next box at a small size, and descenders and
  // accents cross the edge where lines are set tight.
  const rowInk = Array.from({ length: h }, (_, y) => {
    let s = 0
    for (let x = 0; x < w; x++) s += ink(canvas, x, y) + ink(editor, x, y)
    return s
  })
  const boundary = (
    above: { top: number; bottom: number },
    below: { top: number; bottom: number },
  ): number => {
    const meet = (above.bottom + below.top) / 2
    const reach = Math.max(1, ((above.bottom - above.top + below.bottom - below.top) / 2) * 0.25)
    const from = Math.max(0, Math.floor(meet - reach))
    const to = Math.min(h, Math.ceil(meet + reach))
    let best = Math.round(meet)
    for (let y = from; y <= to && y < h; y++) {
      const v = rowInk[y]!
      const b = rowInk[best] ?? Infinity
      if (v < b || (v === b && Math.abs(y - meet) < Math.abs(best - meet))) best = y
    }
    // The emptiest row is the first of the line below.
    return best
  }
  const slabs = layoutLines.map((l, i) => {
    const prev = layoutLines[i - 1]
    const next = layoutLines[i + 1]
    return {
      y0: prev === undefined ? 0 : boundary(prev, l),
      y1: next === undefined ? h : boundary(l, next),
    }
  })
  let lines = 0
  let linesOverlay = 0
  let lineDx = 0
  let lineDy = 0
  let wordDx = 0
  for (const { y0, y1 } of slabs) {
    const a = centre(canvas, 0, w, y0, y1)
    const b = centre(editor, 0, w, y0, y1)
    if (a !== null) lines++
    if (b !== null) linesOverlay++
    // A line without ink in either picture (an empty paragraph): nothing to place.
    if (a === null && b === null) continue
    if (a === null || b === null) {
      lineDx = lineDy = Infinity
      continue
    }
    lineDx = Math.max(lineDx, Math.abs(a.x - b.x))
    lineDy = Math.max(lineDy, Math.abs(a.y - b.y))
    // Words: column runs of ink in the line (both pictures' ink), split at
    // gaps of a sixth of the height of the canvas's ink on it.
    const rows: number[] = []
    for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) {
      let s = 0
      for (let x = 0; x < w; x++) s += ink(canvas, x, y)
      rows.push(s)
    }
    // The height of the line's core (rows with a quarter of the busiest row's
    // ink: its small letters' height, whatever else the line holds): a word
    // gap is a fraction of it. The line's whole ink height took a large run
    // into it (a 40 px word in a 22 px line) and merged bold, italic and red
    // words into one band, whose centre then moved with how heavily WebKit's
    // smoothing draws each colour and weight (0.73 px, run-runs).
    const inked = bands(rows, Math.max(...rows) * 0.25, rows.length)[0] ?? [0, rows.length]
    const cols = Array.from({ length: w }, (_, x) => {
      let s = 0
      for (let y = Math.max(0, y0); y < Math.min(h, y1); y++)
        s += ink(canvas, x, y) + ink(editor, x, y)
      return s
    })
    const gap = Math.max(2, Math.round((inked[1] - inked[0]) / 6))
    for (const [c0, c1] of bands(cols, 0, gap)) {
      const wa = centre(canvas, c0 - 1, c1 + 1, y0, y1)
      const wb = centre(editor, c0 - 1, c1 + 1, y0, y1)
      if (wa === null || wb === null) continue
      wordDx = Math.max(wordDx, Math.abs(wa.x - wb.x))
    }
  }
  return { lines, linesOverlay, lineDx, lineDy, wordDx, coverage }
}

/** The texts measured on a slide: every box (the crowded slide: a sample), table cells. */
function targetsOf(s: CorpusSlide): Array<{ id: string; cell?: { row: number; col: number } }> {
  if (s.name === 'table')
    return [
      { id: 'tbl', cell: { row: 0, col: 0 } },
      { id: 'tbl', cell: { row: 1, col: 1 } },
      { id: 'tbl', cell: { row: 2, col: 2 } },
      { id: 'tbl', cell: { row: 3, col: 3 } },
      { id: 'tbl', cell: { row: 4, col: 4 } },
    ]
  const ids = s.name === 'crowded' ? s.ids.filter((_, i) => i % 12 === 0) : s.ids
  return ids.map((id) => ({ id }))
}

/** `TEXT_EDIT_PPTX`: a .pptx to import and check instead of the corpus. */
const PPTX = process.env['TEXT_EDIT_PPTX']

/** The texts of an imported slide: text boxes with text, and up to six cells of each table. */
async function importedTargets(
  page: Page,
): Promise<Array<{ id: string; cell?: { row: number; col: number } }>> {
  return await page.evaluate(() => {
    const h = window.__narrative_perf_harness!
    const out: Array<{ id: string; cell?: { row: number; col: number } }> = []
    for (const id of h.mountedIds()) {
      const o = h.object(id) as unknown as {
        type: string
        rows?: Array<Array<{ text?: unknown }>>
        text?: unknown
      } | null
      if (o === null) continue
      if (o.type === 'text') out.push({ id })
      if (o.type === 'table' && o.rows !== undefined) {
        let n = 0
        for (const [row, cells] of o.rows.entries())
          for (const [col] of cells.entries()) if (n++ < 6) out.push({ id, cell: { row, col } })
      }
    }
    return out
  })
}

interface Row extends Comparison {
  slide: string
  state: string
  target: string
}

test('every text sits where its edit overlay puts it', async ({
  browser,
  browserName,
  request,
}) => {
  test.setTimeout(150 * 60_000)
  // The deck sits in a folder with the test fonts: the custom-font slide.
  const { folderId, families } = await seedFontFolder(request, `text edit parity ${Date.now()}`)
  let deckId: string
  let slides: CorpusSlide[]
  if (PPTX !== undefined) {
    // An imported deck: every text box and table of every slide.
    // `corpus`: the corpus exported to .pptx and imported again (the importer's autofit,
    // line spacing, lists, scripts and fonts); otherwise a file.
    const file = PPTX === 'corpus' ? await exportedCorpusPptx(request, folderId, families) : PPTX
    const imported = await importPptx(request, browser, folderId, file, `edit parity ${Date.now()}`)
    deckId = imported.deckId
    slides = Array.from({ length: imported.slideCount }, (_, i) => ({
      name: `pptx-${i + 1}`,
      ops: [],
      ids: [],
    }))
  } else {
    deckId = await createDeckInFolder(request, folderId, `text edit parity ${Date.now()}`)
    const corpus = textCorpusOps()
    slides = corpus.slides
    const fonts = customFontSlide(slides.length, families)
    await applyOps(request, deckId, [
      ...corpus.ops,
      { command: 'slide.add', input: {} },
      ...fonts.ops,
    ])
    slides.push(fonts)
  }
  const page = await open(browser, deckId)
  const rows: Row[] = []
  const scrolls: string[] = []
  const misses: string[] = []
  for (const [i, s] of slides.entries()) {
    if (ONLY.length > 0 && !ONLY.includes(s.name)) continue
    await showSlide(page, i, s)
    const targets = PPTX === undefined ? targetsOf(s) : await importedTargets(page)
    for (const [state, go] of [
      ['fit', fit],
      ['100%', zoomTo100],
      ['zoomed', zoomIn],
    ] as const) {
      await go(page)
      for (const t of targets) {
        let target = await targetOf(page, t.id, t.cell)
        if (target === null) continue
        if (!target.visible && state === 'zoomed') {
          // Zoomed in, the slide is larger than the view: scroll the text to its middle.
          await centreOn(page, target.click)
          target = await targetOf(page, t.id, t.cell)
          if (target === null) continue
        }
        // Not wholly in the editor's view at this zoom: the part of it the view
        // shows, when its middle is there (a box larger than the view, zoomed
        // in: its lines are measured where they are seen); otherwise skipped.
        let b = target.box
        if (!target.visible) {
          const v = target.inView
          const middleSeen =
            v !== null &&
            target.click.x > v.x &&
            target.click.x < v.x + v.width &&
            target.click.y > v.y &&
            target.click.y < v.y + v.height
          if (state !== 'zoomed' || target.rotated || v === null || !middleSeen) continue
          b = v
        }
        await page.mouse.move(2, VIEWPORT.height - 2)
        const before = await shot(page, b, ONLY_CANVAS)
        const scrollBefore = await stageScroll(page)
        await page.mouse.dblclick(target.click.x, target.click.y)
        // A table: the first double-click may select the table, the second its cell.
        if (t.cell !== undefined && !(await faded(page, t.id)))
          await page.mouse.dblclick(target.click.x, target.click.y)
        const opened = await page
          .locator(EDITOR)
          .first()
          .waitFor({ state: 'visible', timeout: 4000 })
          .then(() => true)
          .catch(() => false)
        if (!opened) {
          // Not editable by a double-click at its middle (in a group, under
          // another object, a component's leaf): nothing to compare.
          misses.push(
            `${s.name}/${state} ${target.label}: no editor opens on a double-click at its middle`,
          )
          await page.keyboard.press('Escape')
          await page.keyboard.press('Escape')
          continue
        }
        if (!(await faded(page, t.id))) {
          // Another object is on top at that point (the crowded slide's
          // overlapping boxes): nothing of this text to compare.
          misses.push(
            `${s.name}/${state} ${target.label}: a double-click at its middle edits another object`,
          )
          await page.keyboard.press('Escape')
          await expect(page.locator(EDITOR)).toHaveCount(0)
          await page.keyboard.press('Escape')
          continue
        }
        const scrollAfter = await stageScroll(page)
        if (scrollAfter.x !== scrollBefore.x || scrollAfter.y !== scrollBefore.y) {
          // Entering edit mode moved the whole slide (the editor scrolled its
          // caret into view): a jump of its own, and nothing to compare.
          scrolls.push(
            `${s.name}/${state} ${target.label}: the stage scrolled by ${scrollAfter.x - scrollBefore.x}, ${scrollAfter.y - scrollBefore.y} px on entering edit mode`,
          )
          await page.keyboard.press('Escape')
          await expect(page.locator(EDITOR)).toHaveCount(0)
          await page.keyboard.press('Escape')
          continue
        }
        await page.evaluate(
          () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
        )
        const editing = await shot(page, b, EDITOR_OVER_CANVAS)
        // The canvas without this text (faded while edited): what differs
        // from it is the text's own ink, neighbours and fills left out.
        const rest = await shot(page, b, ONLY_CANVAS_EDITING)
        const layoutLines = await overlayLines(page, b)
        await expect(page.locator(EDITOR), 'still editing after the pictures').toHaveCount(1)
        const own = differenceFrom(before, rest)
        const during = differenceFrom(editing, rest)
        await page.keyboard.press('Escape')
        await expect(page.locator(EDITOR)).toHaveCount(0)
        await page.keyboard.press('Escape') // clear the selection
        await settle(page)
        const c = compare(own, during, target.rotated, layoutLines)

        rows.push({ slide: s.name, state, target: target.label, ...c })
        const r = rows[rows.length - 1]!
        // Progress, as it goes (the run is long).
        console.log(
          `  ${r.slide}/${r.state} ${r.target}: lines ${r.lines}/${r.linesOverlay} line Δx ${r.lineDx.toFixed(2)} Δy ${r.lineDy.toFixed(2)} word Δx ${r.wordDx.toFixed(2)} coverage ${r.coverage.toFixed(2)}`,
        )
        const bad =
          c.lineDy > TOLERANCE ||
          c.wordDx > TOLERANCE ||
          c.lines !== c.linesOverlay ||
          c.coverage < 0.75 ||
          c.coverage > 1.33
        if (bad) {
          const info = test.info()
          const name = `${s.name}-${state}-${target.label}`.replace(/[^a-z0-9]+/gi, '-')
          writeFileSync(info.outputPath(`${name}-canvas.png`), PNG.sync.write(own))
          writeFileSync(info.outputPath(`${name}-editor.png`), PNG.sync.write(during))
        }
      }
    }
  }
  writeFileSync(test.info().outputPath('edit-parity.json'), JSON.stringify(rows, null, 1))
  console.log(`${browserName} dpr${DPR}: ${rows.length} texts`)
  for (const line of scrolls) console.log(`  ${line}`)
  for (const line of misses) console.log(`  not measured: ${line}`)
  expect.soft(scrolls, 'entering edit mode scrolls nothing').toEqual([])
  await page.context().close()
  for (const r of rows) {
    const where = `${r.slide}/${r.state} ${r.target}`
    expect.soft(r.linesOverlay, `${where}: lines`).toBe(r.lines)
    expect.soft(r.lineDy, `${where}: line centre y`).toBeLessThanOrEqual(TOLERANCE)
    expect.soft(r.wordDx, `${where}: word centre x`).toBeLessThanOrEqual(TOLERANCE)
    expect.soft(r.coverage, `${where}: ink coverage`).toBeGreaterThan(0.75)
    expect.soft(r.coverage, `${where}: ink coverage`).toBeLessThan(1.33)
  }
})
