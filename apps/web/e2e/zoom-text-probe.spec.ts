/**
 * e2e/zoom-text-probe.spec.ts — diagnostic probe, not a regression test.
 *
 * Asserts nothing: it prints measurements. Kept in the repo because the text
 * alignment bug it was built for (a re-rasterisation moves the glyph block
 * because `applyVerticalAlign` / `applyHorizontalAlign` computed the offset
 * from a measurement that is never refreshed — see
 * docs/handoff/0.9.x-production-hardening.md) is still open, and rebuilding
 * this harness costs more than keeping it.
 *
 * Editor zoom is a CSS transform on `.artboard`; the only thing zoom changes
 * inside Pixi is `renderer.resolution` (Canvas.tsx), which then forces every
 * HTMLText node to re-rasterise. This isolates that step: the CSS zoom stays
 * at 100 % and only the resolution changes, so the two artboard screenshots
 * are directly comparable pixel-for-pixel.
 *
 * Needs a deck to point at, so it SKIPS unless one is named. Run it against a
 * locally imported copy of the deck under investigation:
 *
 *   PROBE_DECK_ID=<deckId> PROBE_SLIDE=3 PROBE_SHOT_DIR=/tmp \
 *     PLAYWRIGHT_USE_SYSTEM_CHROME=1 PLAYWRIGHT_NO_VIDEO=1 \
 *     pnpm --filter web test:e2e zoom-text-probe
 */

import { test, expect } from './fixtures/test'

/**
 * The shapes this probe reads off the dev-only `window.__narrative_scene_graph`
 * handle. Deliberately minimal and structural — the probe touches a handful of
 * Pixi internals (`anchor`, `_didTextUpdate`) that the public typings do not
 * expose, and naming them here beats scattering `any` through the file.
 */
interface ProbeTextNode {
  anchor?: { x: number }
  x: number
  y: number
  width: number
  height: number
  style?: { align?: string; fontFamily?: string }
  text?: string
}

interface ProbeContainer {
  x: number
  y: number
  children?: ProbeTextNode[]
}

interface ProbeSceneGraph {
  getApp(): {
    renderer: { resolution: number; resize(w: number, h: number): void }
    canvas: HTMLCanvasElement
  }
  getContainer(id: string): ProbeContainer | undefined
  getMountedIds(): string[]
  forceTextResolutionRefresh(): void
  markDirty(): void
}

declare global {
  interface Window {
    __narrative_scene_graph?: ProbeSceneGraph
  }
}

const DECK_ID = process.env['PROBE_DECK_ID'] ?? ''
const SLIDE_INDEX = Number(process.env['PROBE_SLIDE'] ?? '3') - 1
const SHOT_DIR = process.env['PROBE_SHOT_DIR'] ?? '/tmp'

test('imported deck: fonts + geometry', async ({ page }) => {
  test.skip(DECK_ID === '', 'diagnostic probe — set PROBE_DECK_ID to run it')
  test.setTimeout(120_000)

  await page.goto(`/deck/${DECK_ID}`)
  await expect
    .poll(() => page.evaluate(() => typeof window.__narrative_test_api), { timeout: 30_000 })
    .toBe('object')

  const options = page.getByRole('option')
  await expect.poll(() => options.count(), { timeout: 20_000 }).toBeGreaterThan(SLIDE_INDEX)
  await options.nth(SLIDE_INDEX).click()
  await page.waitForTimeout(5000)

  console.log(
    'FONTS ' +
      JSON.stringify(
        await page.evaluate(async () => {
          await document.fonts.ready
          const faces: string[] = []
          document.fonts.forEach((f) => faces.push(`${f.family}|${f.weight}|${f.status}`))
          const sg = window.__narrative_scene_graph!
          const api = window.__narrative_test_api!
          const slide = api.listSlideIds()[2]
          const texts: unknown[] = []
          for (const id of sg.getMountedIds()) {
            const c = sg.getContainer(id)
            const t = c?.children?.find((ch) => ch.anchor !== undefined && '_didTextUpdate' in ch)
            if (!t) continue
            const m = api.getObject(id, slide) as Record<string, unknown> | null
            texts.push({
              id: id.slice(0, 8),
              modelFamily: m?.['fontFamily'],
              pixiFamily: t.style?.fontFamily,
              htmlSnippet: String(t.text ?? '').slice(0, 120),
            })
          }
          return { faces, texts }
        }),
      ),
  )

  console.log(
    'MODEL_VS_MEASURED ' +
      JSON.stringify(
        await page.evaluate(() => {
          const sg = window.__narrative_scene_graph!
          const api = window.__narrative_test_api!
          const slide =
            api.listSlideIds()[Number(new URLSearchParams(location.search).get('s') ?? '2')]
          const out: unknown[] = []
          for (const id of sg.getMountedIds()) {
            const c = sg.getContainer(id)
            const t = c?.children?.find((ch) => ch.anchor !== undefined && '_didTextUpdate' in ch)
            if (!t) continue
            const m = api.getObject(id, slide) as Record<string, unknown> | null
            out.push({
              id: id.slice(0, 8),
              modelH: m?.['height'],
              measuredH: Number(t.height.toFixed(1)),
              modelW: m?.['width'],
              measuredW: Number(t.width.toFixed(1)),
              vAlign: m?.['vAlign'],
              align: m?.['align'],
              textY: Number(t.y.toFixed(1)),
              fontSize: m?.['fontSize'],
              family: String(t.style?.fontFamily ?? '').slice(0, 24),
            })
          }
          return out
        }),
      ),
  )

  const artboard = page.locator('.artboard').first()
  await artboard.screenshot({ path: `${SHOT_DIR}/res-before.png` })

  const before = await page.evaluate(() => {
    const sg = window.__narrative_scene_graph!
    return { resolution: sg.getApp().renderer.resolution }
  })

  // Bump ONLY the renderer resolution, exactly as the zoom effect does.
  await page.evaluate(() => {
    const sg = window.__narrative_scene_graph!
    const app = sg.getApp()
    const el = app.canvas as HTMLCanvasElement
    app.renderer.resolution = 2.2
    app.renderer.resize(
      el.clientWidth || parseFloat(getComputedStyle(el).width),
      el.clientHeight || parseFloat(getComputedStyle(el).height),
    )
    sg.forceTextResolutionRefresh()
    sg.markDirty()
  })
  await page.waitForTimeout(4000)

  await artboard.screenshot({ path: `${SHOT_DIR}/res-after.png` })
  const after = await page.evaluate(() => {
    const sg = window.__narrative_scene_graph!
    return { resolution: sg.getApp().renderer.resolution }
  })
  console.log('RES ' + JSON.stringify({ before, after }))
})
