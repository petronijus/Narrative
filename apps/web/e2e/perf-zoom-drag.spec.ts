/**
 * perf-zoom-drag.spec.ts — frame times while zooming (Mod+wheel) and dragging,
 * per engine. Opt-in (`PERF_PROBE=1`): it measures rather than asserts, and a
 * shared machine makes its numbers noisy. Written for the Tauri question
 * (docs/plans/desktop-tauri-evaluation.md): the app felt slow on the MacBook,
 * where `PERF_PROBE=1 just e2e-webkit e2e/perf-zoom-drag.spec.ts` runs the
 * native WebKit — compare with `PERF_PROBE=1 just e2e e2e/perf-zoom-drag.spec.ts`.
 *
 * It prints one `PERF <engine> <gesture> …` line per gesture: frame count,
 * median, 90th percentile and longest frame, and how many frames took over
 * 50 ms (a frame over 50 ms is a visible stutter). Linux (2026-10-16, WebKit
 * in Playwright's container, Chromium on SwiftShader): zoom p90 130 ms in
 * WebKit vs 50 ms in Chromium, 25 of 66 frames over 50 ms vs 6 of 139.
 */

import { expect, test, type Page } from './fixtures/test'
import { provisionDeckWithText } from './fixtures/provisionDeck'

test.skip(process.env['PERF_PROBE'] !== '1', 'opt-in: PERF_PROBE=1')

async function startProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __probing: boolean }
    w.__frames = []
    w.__probing = true
    let last = performance.now()
    const tick = (now: number) => {
      w.__frames.push(now - last)
      last = now
      if (w.__probing) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

async function stopProbe(page: Page): Promise<string> {
  const frames = await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __probing: boolean }
    w.__probing = false
    return w.__frames.slice(1)
  })
  frames.sort((a, b) => a - b)
  const at = (p: number) => frames[Math.min(frames.length - 1, Math.floor(frames.length * p))]!
  const slow = frames.filter((f) => f > 50).length
  return (
    `frames=${frames.length} p50=${at(0.5).toFixed(0)}ms p90=${at(0.9).toFixed(0)}ms ` +
    `max=${at(1).toFixed(0)}ms over50ms=${slow}`
  )
}

test('frame times while zooming and dragging', async ({ page, browserName }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1600, height: 1000 })
  await provisionDeckWithText(page, {
    title: 'perf zoom drag',
    objectId: 'perf-text',
    text: 'The quick brown fox jumps over the lazy dog, again and again',
    x: 100,
    y: 100,
    width: 800,
    height: 120,
  })
  // A slide with some weight: a dozen shapes beside the text.
  await page.evaluate(() => {
    const api = window.__narrative_test_api!
    for (let i = 0; i < 12; i++) {
      api.addRect({
        id: `perf-r${i}`,
        x: 100 + (i % 6) * 280,
        y: 400 + Math.floor(i / 6) * 260,
        w: 220,
        h: 200,
        fill: 0x3366cc,
      })
    }
  })
  await page.waitForTimeout(2500) // first rasters

  const artboard = (await page.locator('.artboard').boundingBox())!
  await page.mouse.move(artboard.x + artboard.width / 2, artboard.y + artboard.height / 2)

  // Zoom in and back out with the wheel, as a trackpad pinch does.
  await startProbe(page)
  await page.keyboard.down('ControlOrMeta')
  for (let i = 0; i < 40; i++) {
    await page.mouse.wheel(0, i < 20 ? -40 : 40)
    await page.waitForTimeout(25)
  }
  await page.keyboard.up('ControlOrMeta')
  console.log('PERF', browserName, 'zoom', await stopProbe(page))
  await page.waitForTimeout(1500)

  // Drag the first shape along a wavy path.
  await page.evaluate(() => window.__narrative_test_api!.setSelection(['perf-r0']))
  const board = (await page.locator('.artboard').boundingBox())!
  const sx = board.x + board.width * 0.12
  const sy = board.y + board.height * 0.5
  await startProbe(page)
  await page.mouse.move(sx, sy)
  await page.mouse.down()
  for (let i = 0; i < 60; i++) {
    await page.mouse.move(sx + i * 6, sy + Math.sin(i / 5) * 40)
    await page.waitForTimeout(16)
  }
  await page.mouse.up()
  console.log('PERF', browserName, 'drag', await stopProbe(page))
  expect(await page.evaluate(() => window.__narrative_test_api!.objectCount())).toBeGreaterThan(0)
})
