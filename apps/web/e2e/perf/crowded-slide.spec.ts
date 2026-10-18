/**
 * crowded-slide.spec.ts — layer I scenarios on a crowded slide (the old
 * perf-heavy-slide.spec.ts probe, now benches of packages/perf with results,
 * baselines and budgets: docs/plans/perf-harness.md). Run with `just perf`
 * (`just perf transform.move.rect --mode prod`); skipped otherwise.
 *
 * The slide: PERF_TEXTS texts (120), PERF_IMAGES pictures (40, cycling
 * through the photos of PERF_PHOTOS or six generated ones), PERF_RECTS
 * rectangles (60), and three probes on top — a rectangle, a text and a
 * picture — that the gestures drive. PERF_NO_MASK=1 takes every clip mask off
 * the scene first (what do they cost?).
 */

import { expect, test } from '../fixtures/test'
import { caret } from '../fixtures/keys'
import {
  launchOptions,
  PERF,
  runScenarios,
  selected,
  sideContext,
  type SideState,
} from './lib/driver'
import {
  assertPerfOff,
  capture,
  gestureValues,
  objectXY,
  openDeck,
  screenCentre,
  settle,
} from './lib/page'
import {
  applyOps,
  command,
  createDeck,
  crowdedSlideOps,
  photoFiles,
  uploadPhotos,
  type Box,
} from './lib/seed'

const IDS = [
  'editor.idle.crowded',
  'transform.nudge.rect',
  'transform.move.rect',
  'transform.move.text',
  'transform.move.image',
  'transform.move.multi',
  'viewport.zoom.wheel',
  'viewport.zoom.commit',
  'text.type.inter',
]

const SCENE = {
  texts: Number(process.env['PERF_TEXTS'] ?? 120),
  images: Number(process.env['PERF_IMAGES'] ?? 40),
  rects: Number(process.env['PERF_RECTS'] ?? 60),
}
const SCENE_IS_DEFAULT =
  SCENE.texts === 120 &&
  SCENE.images === 40 &&
  SCENE.rects === 60 &&
  (process.env['PERF_PHOTOS'] ?? '') === '' &&
  !PERF.noMask

const PROBE_TEXT = 'Probe text box for typing and dragging'
const TYPED = 'The quick brown fox jumps over the lazy dog and keeps typing'

interface Crowded extends SideState {
  deckId: string
  boxes: Map<string, Box>
}

if (PERF.gpu) test.use({ launchOptions: launchOptions() })
test.skip(!PERF.run, 'perf scenarios run through `just perf`')

test('crowded slide', async ({ browser }) => {
  const ids = selected(IDS)
  test.skip(ids.length === 0, 'no bench of this spec selected')
  test.setTimeout(90 * 60_000)

  const states: Crowded[] = []
  for (const side of PERF.sides) {
    const context = await sideContext(browser, side, { width: 1800, height: 1100 })
    const page = await context.newPage()
    const deckId = await createDeck(context.request, `perf crowded slide (${side.name})`)
    const assets = await uploadPhotos(context.request, deckId, photoFiles())
    const { ops, boxes } = crowdedSlideOps(SCENE, assets)
    await applyOps(context.request, deckId, ops)
    const t0 = Date.now()
    await assertPerfOff(page, deckId, PERF.mode)
    await openDeck(page, deckId, [...boxes.keys()])
    console.log(
      `PERF scene crowded slide [${side.name}]: ${boxes.size} objects, open+settle ${Date.now() - t0} ms`,
    )
    if (PERF.noMask)
      console.log(
        'PERF masks removed:',
        await page.evaluate(() => window.__narrative_perf_harness!.stripMasks()),
      )
    states.push({ side, page, deckId, boxes })
  }

  /** Put objects back where the scene has them (through the command API, as the seed did). */
  const restore = async (s: Crowded, list: readonly string[]): Promise<void> => {
    await command(s.page.context().request, s.deckId, 'ops.apply', {
      ops: list.map((id) => {
        const b = s.boxes.get(id)!
        return {
          command: 'object.update',
          input: { slide: { index: 0 }, object: id, patch: { x: b.x, y: b.y } },
        }
      }),
    })
    await expect
      .poll(async () => {
        for (const id of list) {
          const at = await objectXY(s.page, id)
          const b = s.boxes.get(id)!
          if (at === null || at.x !== b.x || at.y !== b.y) return false
        }
        return true
      })
      .toBe(true)
  }

  const drag = (id: string, steps: number, selection?: readonly string[]) => async (s: Crowded) => {
    const list = selection ?? [id]
    await s.page.evaluate((l) => window.__narrative_perf_harness!.setSelection(l), [...list])
    const c = await screenCentre(s.page, s.boxes.get(id)!)
    const captured = await capture(s.page, async (inputEnd) => {
      await s.page.mouse.move(c.x, c.y)
      await s.page.mouse.down()
      for (let i = 1; i <= steps; i++) {
        await s.page.mouse.move(c.x + i * 5, c.y + Math.sin(i / 6) * 50)
        await s.page.waitForTimeout(8)
      }
      await s.page.mouse.up()
      await inputEnd()
    })
    const moved = await objectXY(s.page, id)
    const home = s.boxes.get(id)!
    expect(
      moved !== null && Math.hypot(moved.x - home.x, moved.y - home.y) > 100,
      `${id} moved`,
    ).toBe(true)
    s.last = captured
    await restore(s, list)
    return captured
  }

  const crowd = [
    'probe-rect',
    ...Array.from({ length: Math.min(19, SCENE.texts) }, (_, i) => `text-${i}`),
  ]

  await runScenarios<Crowded>({
    browser,
    ids,
    states,
    sceneIsDefault: SCENE_IS_DEFAULT,
    runs: {
      'editor.idle.crowded': async (s, def) => {
        const c = await capture(s.page, async (inputEnd) => {
          await s.page.waitForTimeout(3000)
          await inputEnd()
        })
        s.last = c
        return gestureValues(def.metrics, c)
      },
      'transform.nudge.rect': async (s, def) => {
        // Select by a click (the canvas then has the keyboard), outside the measurement.
        const c0 = await screenCentre(s.page, s.boxes.get('probe-rect')!)
        await s.page.mouse.click(c0.x, c0.y)
        await settle(s.page)
        const c = await capture(s.page, async (inputEnd) => {
          await s.page.keyboard.press('ArrowRight')
          await inputEnd()
        })
        const at = await objectXY(s.page, 'probe-rect')
        expect(at?.x, 'probe-rect nudged').toBe(s.boxes.get('probe-rect')!.x + 1)
        s.last = c
        await restore(s, ['probe-rect'])
        return gestureValues(def.metrics, c)
      },
      'transform.move.rect': async (s, def) =>
        gestureValues(def.metrics, await drag('probe-rect', 90)(s)),
      'transform.move.text': async (s, def) =>
        gestureValues(def.metrics, await drag('probe-text', 90)(s)),
      'transform.move.image': async (s, def) =>
        gestureValues(def.metrics, await drag('probe-img', 90)(s)),
      'transform.move.multi': async (s, def) =>
        gestureValues(def.metrics, await drag('probe-rect', 90, crowd)(s)),
      'viewport.zoom.wheel': async (s, def) => {
        const a = (await s.page.locator('.artboard').boundingBox())!
        await s.page.mouse.move(a.x + a.width * 0.47, a.y + a.height * 0.5)
        const c = await capture(s.page, async (inputEnd) => {
          await s.page.keyboard.down('ControlOrMeta')
          for (let i = 0; i < 40; i++) {
            await s.page.mouse.wheel(0, i < 20 ? -50 : 50)
            await s.page.waitForTimeout(25)
          }
          await s.page.keyboard.up('ControlOrMeta')
          await inputEnd()
        })
        s.last = c
        return gestureValues(def.metrics, c)
      },
      'viewport.zoom.commit': async (s, def) => {
        // From the fitted zoom every run: the wheel bench leaves the zoom at
        // its minimum, from where eight steps would not reach 100 % (no
        // resolution change, nothing to commit).
        await s.page.getByRole('button', { name: 'Reset zoom to 100%' }).hover()
        await s.page.getByRole('button', { name: 'Fit to screen' }).click()
        await settle(s.page)
        const a = (await s.page.locator('.artboard').boundingBox())!
        await s.page.mouse.move(a.x + a.width * 0.47, a.y + a.height * 0.5)
        const wheel = async (dy: number): Promise<void> => {
          await s.page.keyboard.down('ControlOrMeta')
          for (let i = 0; i < 8; i++) {
            await s.page.mouse.wheel(0, dy)
            await s.page.waitForTimeout(25)
          }
          await s.page.keyboard.up('ControlOrMeta')
        }
        const c = await capture(s.page, async (inputEnd) => {
          // In, then a rest long enough for the commit and its staging to run…
          await wheel(-50)
          await s.page.waitForTimeout(1500)
          // …and back out (the second commit's staging is the settle).
          await wheel(50)
          await inputEnd()
        })
        s.last = c
        return gestureValues(def.metrics, c)
      },
      'text.type.inter': async (s, def) => {
        const box = s.boxes.get('probe-text')!
        const p = await screenCentre(s.page, box)
        await s.page.mouse.dblclick(p.x, p.y)
        await expect(
          s.page.locator('[data-shortcut-scope="canvas"] [contenteditable="true"]').first(),
        ).toBeVisible()
        await s.page.keyboard.press(caret.textEnd)
        await settle(s.page)
        const c = await capture(s.page, async (inputEnd) => {
          for (const ch of TYPED) {
            await s.page.keyboard.type(ch)
            await s.page.waitForTimeout(35)
          }
          await inputEnd()
          await s.page.keyboard.press('Escape')
        })
        s.last = c
        await command(s.page.context().request, s.deckId, 'object.update', {
          slide: { index: 0 },
          object: 'probe-text',
          patch: { text: PROBE_TEXT },
        })
        await settle(s.page)
        return gestureValues(def.metrics, c)
      },
    },
  })
})
