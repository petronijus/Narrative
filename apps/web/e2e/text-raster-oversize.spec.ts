/**
 * text-raster-oversize.spec.ts — a text whose raster is larger than a GPU
 * texture can be is still drawn, sharp and in its place (ADR 0018 →
 * Placement: rasters larger than a texture).
 *
 * At 400 % and DPR 2 the canvas draws texts at 8 device px per slide px: a
 * 120 px line across the slide is a raster of ~15 000 × 1 300 texels, past the
 * GPU's largest texture (the pooled power-of-two one: 16 384), and was drawn
 * as a black block. The renderer paints such a text for the part of the world
 * the canvas draws (its region, ADR 0020), at full density, and again when a
 * scroll moves the region past what it painted.
 *
 * Checked at DPR 2, 400 %: the canvas around the text is not a dark block
 * (the text's ink is a minority of the pixels), it has ink, and its ink sits
 * where the edit overlay's does (centre within 0.5 device px, coverage within
 * ±25 %) — before and after a scroll along the line. Chromium and WebKit
 * (`just e2e-webkit -g text-raster-oversize`).
 */

import type { Page } from '@playwright/test'
import { PNG } from 'pngjs'
import { expect, test } from './fixtures/test'
import { applyOps, createDeck } from './perf/lib/seed'
import type { PerfHarnessApi } from '../src/perf/harness'

declare global {
  interface Window {
    __narrative_perf_harness?: PerfHarnessApi
  }
}

const VIEWPORT = { width: 1600, height: 1000 }
const EDITOR = '[data-shortcut-scope="canvas"] [contenteditable="true"]'
const ONLY_CANVAS =
  '* { visibility: hidden !important } .artboard canvas { visibility: visible !important }'
const SHOW_EDITOR =
  ' [data-shortcut-scope="canvas"] [contenteditable="true"], [data-shortcut-scope="canvas"] [contenteditable="true"] * { visibility: visible !important; caret-color: transparent !important; outline: none !important'
const CANVAS_WHILE_EDITING = `${ONLY_CANVAS}${SHOW_EDITOR}; opacity: 0 !important }`
const EDITOR_OVER_CANVAS = `${ONLY_CANVAS}${SHOW_EDITOR} }`

async function settle(page: Page): Promise<void> {
  const r = await page.evaluate(() =>
    window.__narrative_perf_harness!.settle({ quietMs: 600, timeoutMs: 60_000 }),
  )
  expect(r.ok, `the scene settled: ${r.reason ?? ''}`).toBe(true)
}

/** Scroll the editor's stage so page point (x, y) comes to the middle of the canvas area. */
async function bringToMiddle(page: Page, x: number, y: number): Promise<void> {
  await page.evaluate(
    ({ x, y }) => {
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
      el.scrollLeft += x - (r.left + r.width / 2)
      el.scrollTop += y - (r.top + r.height / 2)
    },
    { x, y },
  )
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  )
  await settle(page)
}

/** Page position of slide point (x, y). */
async function slideToPage(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  return await page.evaluate(
    ({ x, y }) => {
      const art = document.querySelector('.artboard') as HTMLElement
      const r = art.getBoundingClientRect()
      const k = r.width / art.offsetWidth
      return { x: r.left + x * k, y: r.top + y * k }
    },
    { x, y },
  )
}

/** Per pixel: how much a picture differs from `rest`, 0–255. */
function difference(a: PNG, rest: PNG): Float64Array {
  const out = new Float64Array(a.width * a.height)
  for (let i = 0; i < out.length; i++) {
    let d = 0
    for (let k = 0; k < 3; k++)
      d = Math.max(d, Math.abs(a.data[i * 4 + k]! - rest.data[i * 4 + k]!))
    out[i] = d < 4 ? 0 : d
  }
  return out
}

function centre(d: Float64Array, w: number): { x: number; y: number; ink: number } {
  let s = 0
  let sx = 0
  let sy = 0
  for (let i = 0; i < d.length; i++) {
    const v = d[i]!
    if (v === 0) continue
    s += v
    sx += v * (i % w)
    sy += v * Math.floor(i / w)
  }
  return { x: sx / s, y: sy / s, ink: s }
}

/** The extent of the strong ink (half of full or more): first and last column and row. */
function extent(
  d: Float64Array,
  w: number,
): { left: number; right: number; top: number; bottom: number } {
  let left = Infinity
  let right = -Infinity
  let top = Infinity
  let bottom = -Infinity
  let max = 0
  for (const v of d) max = Math.max(max, v)
  for (let i = 0; i < d.length; i++) {
    if (d[i]! < max / 2) continue
    const x = i % w
    const y = Math.floor(i / w)
    left = Math.min(left, x)
    right = Math.max(right, x)
    top = Math.min(top, y)
    bottom = Math.max(bottom, y)
  }
  return { left, right, top, bottom }
}

/** The share of the picture's pixels that are dark. */
function darkShare(p: PNG): number {
  let dark = 0
  for (let i = 0; i < p.data.length; i += 4)
    if (Math.max(p.data[i]!, p.data[i + 1]!, p.data[i + 2]!) < 60) dark++
  return dark / (p.width * p.height)
}

test('a text larger than a texture is drawn sharp and in place at 400 %, DPR 2', async ({
  browser,
  browserName,
  request,
}) => {
  test.setTimeout(5 * 60_000)
  const deckId = await createDeck(request, `oversize text ${Date.now()}`)
  await applyOps(request, deckId, [
    {
      command: 'object.create',
      input: {
        slide: { index: 0 },
        id: 'big',
        object: {
          type: 'text',
          x: 40,
          y: 400,
          width: 1840,
          height: 170,
          text: { paragraphs: [{ text: '120px Inter AVATAR Typography gjpqy quick brown fox' }] },
          fontSize: 120,
          fontWeight: 400,
          color: '#111827',
          align: 'left',
          rotation: 0,
          opacity: 1,
          wrap: 'none',
        },
      },
    },
  ])
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 })
  const page = await context.newPage()
  await page.goto(`/deck/${deckId}?perf=1`)
  await expect
    .poll(() => page.evaluate(() => window.__narrative_perf_harness?.version ?? 0), {
      timeout: 30_000,
    })
    .toBe(1)
  await page.locator('[role="option"][data-slide-id]').first().click()
  await settle(page)
  // 400 %: from 100 %, eight wheel steps at the artboard's middle.
  await page.getByRole('button', { name: 'Reset zoom to 100%' }).click()
  await settle(page)
  const a = (await page.locator('.artboard').boundingBox())!
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.keyboard.down('ControlOrMeta')
  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel(0, -50)
    await page.waitForTimeout(25)
  }
  await page.keyboard.up('ControlOrMeta')
  await page.mouse.move(2, VIEWPORT.height - 2)
  await settle(page)

  // Two places along the line: its start, then further right (a scroll that
  // moves the canvas's region past what was painted).
  for (const along of [300, 1100]) {
    const at = await slideToPage(page, along, 485)
    await bringToMiddle(page, at.x, at.y)
    const mid = await slideToPage(page, along, 485)
    const clip = {
      x: Math.round(mid.x - 300),
      y: Math.round(mid.y - 260),
      width: 600,
      height: 520,
    }
    await page.mouse.move(2, VIEWPORT.height - 2)
    const canvas = PNG.sync.read(await page.screenshot({ clip, style: ONLY_CANVAS }))
    expect(darkShare(canvas), `at ${along}: the canvas is not a dark block`).toBeLessThan(0.5)
    await page.mouse.dblclick(mid.x, mid.y)
    await page.locator(EDITOR).first().waitFor({ state: 'visible', timeout: 5000 })
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    )
    const editing = PNG.sync.read(await page.screenshot({ clip, style: EDITOR_OVER_CANVAS }))
    const rest = PNG.sync.read(await page.screenshot({ clip, style: CANVAS_WHILE_EDITING }))
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await settle(page)
    const own = centre(difference(canvas, rest), canvas.width)
    const page_ = centre(difference(editing, rest), canvas.width)
    expect(own.ink, `at ${along}: the canvas draws the text`).toBeGreaterThan(0)
    expect(page_.ink / own.ink, `at ${along}: ink coverage`).toBeGreaterThan(0.75)
    expect(page_.ink / own.ink, `at ${along}: ink coverage`).toBeLessThan(1.33)
    if (browserName === 'webkit') {
      // WebKit paints HTML glyphs larger than ~180 device px heavier than
      // canvas glyphs (ADR 0018 → The residue); on these 240 device px
      // glyphs that moves an ink centre by up to 1 px with both drawn at the
      // same place (a plain page, HTML against Canvas2D, 2026-10-30:
      // 0.72–0.99 px). Where the glyphs are is read from their edges: the
      // ink's extent on every side.
      const a = extent(difference(canvas, rest), canvas.width)
      const b = extent(difference(editing, rest), canvas.width)
      for (const side of ['left', 'right', 'top', 'bottom'] as const)
        expect(Math.abs(a[side] - b[side]), `at ${along}: ink ${side}`).toBeLessThanOrEqual(1)
    } else {
      expect(Math.abs(page_.x - own.x), `at ${along}: centre x`).toBeLessThanOrEqual(0.5)
      expect(Math.abs(page_.y - own.y), `at ${along}: centre y`).toBeLessThanOrEqual(0.5)
    }
  }
  await context.close()
})
