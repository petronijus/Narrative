/**
 * text-engine-spike.spec.ts — the E7 spike's text engines against HTMLText
 * (docs/plans/performance.md → E7; the page is `/text-engine-spike.html`,
 * dev server only, `src/renderer/experimental/textEngine/`).
 *
 * Fidelity: every text of a scene is drawn by HTMLText (the app's text
 * renderer, as on the canvas) and by a candidate engine, and the two rasters
 * are compared pixel by pixel (over white, at the same resolution):
 *
 *   - `dom`   — the browser's layout read as glyph runs, Canvas2D in a worker;
 *   - `block` — layout without the DOM (Canvas2D measurements), in a worker;
 *   - `sdf`   — SDF glyph atlases (only checked to draw the text).
 *
 * The bench (`TEXT_SPIKE_BENCH=1`, numbers in the test's output directory and
 * on stdout) mounts the crowded and present scenes per engine, zooms 1× → 2×
 * → 1× and switches the slide three times, in fresh pages, three runs each.
 * Chromium with the GPU: `TEXT_SPIKE_BENCH=1 just e2e text-engine-spike`
 * (the spec launches its own browser with the perf driver's GPU flags);
 * WebKit: `PW_WEBKIT=1 TEXT_SPIKE_BENCH=1 just e2e text-engine-spike
 * --project webkit` (Low Power Mode off).
 *
 * No backend, no seeding: the scenes are built in the page.
 */
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures/test'

interface Row {
  id: string
  inkA: number
  inkB: number
  differing: number
  ratio: number
  layout?: { lines: [number, number]; height: [number, number]; runTextsEqual: boolean }
}

type Engine = 'html' | 'dom' | 'block' | 'sdf'
type Scene = 'crowded' | 'present' | 'features'

interface SpikeApi {
  ready: Promise<unknown>
  fidelity(engine: Engine, scene: Scene, resolution: number): Promise<{ rows: Row[] }>
  mount(engine: Engine, scene: Scene, resolution: number): Promise<Record<string, unknown>>
  zoom(resolution: number): Promise<Record<string, unknown>>
  heapMb(): number
}

declare global {
  interface Window {
    __textSpike: SpikeApi
  }
}

async function open(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1920, height: 1200 })
  await page.goto('/text-engine-spike.html')
  await page.waitForFunction(() => window.__textSpike !== undefined)
  await page.evaluate(() => window.__textSpike.ready)
}

async function fidelity(
  page: Page,
  engine: Engine,
  scene: Scene,
  resolution: number,
): Promise<Row[]> {
  const out = await page.evaluate(([e, s, r]) => window.__textSpike.fidelity(e, s, r), [
    engine,
    scene,
    resolution,
  ] as const)
  return out.rows
}

/** Rows HTMLText drew (WebKit sometimes rasterises an embedded face as nothing; reported, not compared). */
const drawn = (rows: Row[]): Row[] => rows.filter((r) => r.inkA > 0)

const share = (rows: Row[]): number =>
  rows.reduce((s, r) => s + r.differing, 0) /
  Math.max(
    1,
    rows.reduce((s, r) => s + Math.max(r.inkA, r.inkB), 0),
  )

test.describe('text engine spike — fidelity', () => {
  test.skip(process.env['TEXT_SPIKE_BENCH'] === '1', 'bench run')
  test.setTimeout(180_000)

  test('glyph runs read from the DOM layout draw the crowded slide as HTMLText does', async ({
    page,
  }) => {
    await open(page)
    const rows = drawn(await fidelity(page, 'dom', 'crowded', 1))
    expect(rows.length).toBeGreaterThan(100)
    const exact = rows.filter((r) => r.differing === 0).length
    // Measured 121 of 121 pixel-identical in Chromium and WebKit (2026-10-20).
    expect(exact / rows.length).toBeGreaterThanOrEqual(0.95)
    expect(share(rows)).toBeLessThan(0.005)
  })

  test('glyph runs read from the DOM layout cover the text features at 1× and 2×', async ({
    page,
  }) => {
    await open(page)
    for (const resolution of [1, 2]) {
      const rows = drawn(await fidelity(page, 'dom', 'features', resolution))
      // Left: underline geometry (no metrics API), WebKit's text stroke, sub-1/64 px kerning.
      expect(share(rows), `differing ink at ${resolution}×`).toBeLessThan(0.02)
    }
  })

  test('the DOM-free layout breaks the crowded slide’s lines where the browser does', async ({
    page,
  }) => {
    await open(page)
    const rows = drawn(await fidelity(page, 'block', 'crowded', 1))
    for (const r of rows) {
      expect(r.layout?.runTextsEqual, r.id).toBe(true)
      expect(r.layout?.height[1], r.id).toBe(r.layout?.height[0])
    }
    expect(share(rows)).toBeLessThan(0.01)
  })

  test('SDF glyph atlases draw every feature’s text', async ({ page }) => {
    await open(page)
    const rows = drawn(await fidelity(page, 'sdf', 'features', 1))
    // Not exact by construction (another rasteriser); the ink is the text's.
    // The stroked box draws no stroke in this candidate.
    for (const r of rows.filter((x) => x.id !== 'stroke')) {
      expect(r.inkB / r.inkA, r.id).toBeGreaterThan(0.6)
      expect(r.inkB / r.inkA, r.id).toBeLessThan(1.6)
    }
  })
})

// The underline geometry HTMLText draws, per font, size and resolution
// (ADR 0018 → decorations): `TEXT_SPIKE_DECORATIONS=1`, rows written to the
// test's output (`decorations.json`).
test.describe('text engine spike — decoration probe', () => {
  test.skip(
    process.env['TEXT_SPIKE_DECORATIONS'] !== '1',
    'TEXT_SPIKE_DECORATIONS=1 runs the probe',
  )
  test.setTimeout(20 * 60_000)

  test('underline bands', async ({ page, browserName }, testInfo) => {
    await open(page)
    const families = (
      process.env['TEXT_SPIKE_FAMILIES'] ??
      'Inter,Arial,Georgia,Times New Roman,Courier New,Verdana'
    ).split(',')
    const sizes = (
      process.env['TEXT_SPIKE_SIZES'] ??
      '8,9,10,11,12,13,14,15,16,18,20,22,24,26,28,30,32,36,40,48,56,64,72,96,120,160'
    )
      .split(',')
      .map(Number)
    const resolutions = (process.env['TEXT_SPIKE_RES'] ?? '1,1.5,2,3').split(',').map(Number)
    const cases = []
    for (const family of families)
      for (const size of sizes)
        for (const resolution of resolutions) cases.push({ family, size, resolution })
    const ink = process.env['TEXT_SPIKE_INK_TEXT']
    if (ink !== undefined)
      for (const family of families)
        for (const resolution of resolutions)
          cases.push({ family, size: 32, resolution, text: ink })
    const rows = await page.evaluate(
      (cs) =>
        (
          window as unknown as {
            __textSpike: { decorationProbe(c: unknown[]): Promise<unknown[]> }
          }
        ).__textSpike.decorationProbe(cs),
      cases,
    )
    const path = testInfo.outputPath(`decorations-${browserName}.json`)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(path, JSON.stringify(rows))
    console.log(`decoration rows: ${rows.length} → ${path}`)
  })
})

// Not `@serial`: that project depends on the whole parallel one, and the bench
// launches browsers of its own anyway — run it with nothing else on the machine.
test.describe('text engine spike — bench', () => {
  test.skip(process.env['TEXT_SPIKE_BENCH'] !== '1', 'TEXT_SPIKE_BENCH=1 runs the bench')
  test.setTimeout(30 * 60_000)

  const GPU_ARGS =
    process.platform === 'darwin'
      ? ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization']
      : ['--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-gpu-rasterization']
  const ENGINES: Engine[] = ['html', 'dom', 'block', 'sdf']
  const SCENES: Scene[] = ['crowded', 'present']
  const RUNS = Number(process.env['TEXT_SPIKE_RUNS'] ?? '3')

  test('mount, zoom and switch per engine', async ({ browserName, playwright }, testInfo) => {
    const type = browserName === 'webkit' ? playwright.webkit : playwright.chromium
    const results: Array<Record<string, unknown>> = []
    for (const scene of SCENES) {
      for (const engine of ENGINES) {
        for (let run = 0; run < RUNS; run++) {
          const browser = await type.launch(browserName === 'chromium' ? { args: GPU_ARGS } : {})
          const page = await browser.newPage({ deviceScaleFactor: 1 })
          await open(page)
          const out = await page.evaluate(
            async ([e, s]) => {
              const t = window.__textSpike
              const pause = (): Promise<void> => new Promise((r) => setTimeout(r, 300))
              const mount = await t.mount(e, s, 1)
              await pause()
              const zoomIn = await t.zoom(2)
              await pause()
              const zoomOut = await t.zoom(1)
              const switches = []
              for (let i = 0; i < 3; i++) {
                await pause()
                switches.push(await t.mount(e, s, 1))
              }
              return { mount, zoomIn, zoomOut, switches, heapMb: t.heapMb() }
            },
            [engine, scene] as const,
          )
          results.push({ browser: browserName, scene, engine, run, ...out })
          await browser.close()
        }
      }
    }
    const file = testInfo.outputPath(`text-engine-spike-${browserName}.json`)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, JSON.stringify(results, null, 1))
    console.log(`text engine spike bench: ${results.length} runs → ${file}`)
  })
})
