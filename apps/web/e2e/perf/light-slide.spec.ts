/**
 * light-slide.spec.ts — zoom (Mod+wheel) and drag on a light slide: one text
 * and twelve rectangles. The old perf-zoom-drag.spec.ts probe, written for the
 * Tauri/WebKit question (docs/plans/desktop-tauri-evaluation.md), now two
 * benches of packages/perf; CDP-free, so `just perf viewport.zoom.wheel.light
 * --browser webkit` measures the native WebKit against Chromium (G6).
 */

import { expect, test } from '../fixtures/test'
import {
  launchOptions,
  PERF,
  perfPage,
  runScenarios,
  selected,
  sideContext,
  type SideState,
} from './lib/driver'
import { assertPerfOff, capture, gestureValues, objectXY, openDeck, screenCentre } from './lib/page'
import { applyOps, command, createDeck, lightSlideOps, type Box } from './lib/seed'

const IDS = ['viewport.zoom.wheel.light', 'transform.move.rect.light']

interface Light extends SideState {
  deckId: string
  boxes: Map<string, Box>
}

if (PERF.gpu) test.use({ launchOptions: launchOptions() })
test.skip(!PERF.run, 'perf scenarios run through `just perf`')

test('light slide', async ({ browser }) => {
  const ids = selected(IDS)
  test.skip(ids.length === 0, 'no bench of this spec selected')
  test.setTimeout(60 * 60_000)

  const states: Light[] = []
  for (const side of PERF.sides) {
    const viewport = { width: 1600, height: 1000 }
    const context = await sideContext(browser, side, viewport)
    const page = await perfPage(context, side, viewport)
    const deckId = await createDeck(context.request, `perf light slide (${side.name})`)
    const { ops, boxes } = lightSlideOps()
    await applyOps(context.request, deckId, ops)
    await assertPerfOff(page, deckId, PERF.mode)
    await openDeck(page, deckId, [...boxes.keys()])
    states.push({ side, page, deckId, boxes })
  }

  await runScenarios<Light>({
    browser,
    ids,
    states,
    sceneIsDefault: true,
    runs: {
      'viewport.zoom.wheel.light': async (s, def) => {
        const a = (await s.page.locator('.artboard').boundingBox())!
        await s.page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
        const c = await capture(s.page, async (inputEnd) => {
          await s.page.keyboard.down('ControlOrMeta')
          for (let i = 0; i < 40; i++) {
            await s.page.mouse.wheel(0, i < 20 ? -40 : 40)
            await s.page.waitForTimeout(25)
          }
          await s.page.keyboard.up('ControlOrMeta')
          await inputEnd()
        })
        s.last = c
        return gestureValues(def.metrics, c)
      },
      'transform.move.rect.light': async (s, def) => {
        await s.page.evaluate(() => window.__narrative_perf_harness!.setSelection(['perf-r0']))
        const home = s.boxes.get('perf-r0')!
        const p = await screenCentre(s.page, home)
        const c = await capture(s.page, async (inputEnd) => {
          await s.page.mouse.move(p.x, p.y)
          await s.page.mouse.down()
          for (let i = 0; i < 60; i++) {
            await s.page.mouse.move(p.x + i * 6, p.y + Math.sin(i / 5) * 40)
            await s.page.waitForTimeout(16)
          }
          await s.page.mouse.up()
          await inputEnd()
        })
        const at = await objectXY(s.page, 'perf-r0')
        expect(at !== null && at.x !== home.x, 'perf-r0 moved').toBe(true)
        s.last = c
        await command(s.page.context().request, s.deckId, 'object.update', {
          slide: { index: 0 },
          object: 'perf-r0',
          patch: { x: home.x, y: home.y },
        })
        await expect.poll(async () => (await objectXY(s.page, 'perf-r0'))?.x).toBe(home.x)
        return gestureValues(def.metrics, c)
      },
    },
  })
})
