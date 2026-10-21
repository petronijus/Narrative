/**
 * table-slide.spec.ts — layer I scenarios on a table-heavy slide
 * (docs/plans/performance.md → E5): one styled 12 × 8 table in Inter, every
 * cell with text (packages/perf scenes.ts → tableSlideOps). Showing the
 * slide, typing into a cell, dragging the table and a zoom commit. Run with
 * `just perf table.mount.styled …`; skipped otherwise. CDP-free, so
 * `--browser webkit` runs it too.
 */

import type { Page } from '@playwright/test'
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
  type Captured,
} from './lib/page'
import { applyOps, command, createDeck, TABLE_SCENE, tableSlideOps, type Box } from './lib/seed'
import type { BenchDef } from '@narrative/perf'

const IDS = [
  'table.mount.styled',
  'table.cell.type',
  'transform.move.table',
  'viewport.zoom.commit.table',
]

/** The cell typed into: a wrapping one of the italic summary column. */
const TYPED_CELL = { row: 4, col: 1 }
const TYPED = ' and the quick brown fox'

interface TableState extends SideState {
  deckId: string
  table: Box
  second: Box
  /** The typed cell's text as seeded (restored after each run). */
  typedCellText: string
}

if (PERF.gpu) test.use({ launchOptions: launchOptions() })
test.skip(!PERF.run, 'perf scenarios run through `just perf`')

function rows(page: Page) {
  return page.locator('[role="option"][data-slide-id]')
}

/** Resolves once every id is mounted and none of `gone` is. */
async function mountedOnly(page: Page, ids: readonly string[], gone: readonly string[]) {
  await page.evaluate(
    ([list, away]) =>
      new Promise<void>((resolve) => {
        const tick = (): void => {
          const have = new Set(window.__narrative_perf_harness!.mountedIds())
          if (list!.every((i) => have.has(i)) && !away!.some((i) => have.has(i))) resolve()
          else requestAnimationFrame(tick)
        }
        tick()
      }),
    [[...ids], [...gone]],
  )
}

/** A gesture's values plus the most draw calls one of its frames took. */
function tableValues(def: BenchDef<never>, c: Captured): Record<string, number> {
  return { ...gestureValues(def.metrics, c), 'frame.draws': c.recording.renders.drawsMax }
}

test('table slide', async ({ browser }) => {
  const ids = selected(IDS)
  test.skip(ids.length === 0, 'no bench of this spec selected')
  test.setTimeout(60 * 60_000)

  const states: TableState[] = []
  for (const side of PERF.sides) {
    const context = await sideContext(browser, side, { width: 1800, height: 1100 })
    const page = await context.newPage()
    const deckId = await createDeck(context.request, `perf table slide (${side.name})`)
    const { ops, boxes, second } = tableSlideOps()
    await applyOps(context.request, deckId, ops)
    const typed = ops.find((o) => {
      const cell = (o.input as { target?: { cell?: { row: number; col: number } } }).target?.cell
      return o.command === 'text.set' && cell?.row === TYPED_CELL.row && cell.col === TYPED_CELL.col
    })!
    await assertPerfOff(page, deckId, PERF.mode)
    await openDeck(page, deckId, [...boxes.keys()])
    states.push({
      side,
      page,
      deckId,
      table: boxes.get(TABLE_SCENE.id)!,
      second,
      typedCellText: (typed.input as { text: string }).text,
    })
  }

  await runScenarios<TableState>({
    browser,
    ids,
    states,
    sceneIsDefault: true,
    runs: {
      'table.mount.styled': async (s, def) => {
        // From the second slide (outside the measurement) back to the table.
        await rows(s.page).nth(1).click()
        await mountedOnly(s.page, [s.second.id], [TABLE_SCENE.id])
        await settle(s.page)
        const c = await capture(s.page, async (inputEnd) => {
          await rows(s.page).nth(0).click()
          await mountedOnly(s.page, [TABLE_SCENE.id], [s.second.id])
          await inputEnd()
        })
        s.last = c
        return tableValues(def, c)
      },
      'table.cell.type': async (s, def) => {
        await s.page.evaluate(
          (id) => window.__narrative_perf_harness!.setSelection([id]),
          TABLE_SCENE.id,
        )
        const { rows: R, cols: C, box } = TABLE_SCENE
        const p = await screenCentre(s.page, {
          x: box.x + (TYPED_CELL.col * box.width) / C,
          y: box.y + (TYPED_CELL.row * box.height) / R,
          width: box.width / C,
          height: box.height / R,
        })
        await s.page.mouse.dblclick(p.x, p.y)
        const editor = s.page.getByTestId('table-cell-editor').locator('[contenteditable="true"]')
        await expect(editor).toBeFocused()
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
        await expect(editor).toHaveCount(0)
        s.last = c
        await command(s.page.context().request, s.deckId, 'text.set', {
          target: { slide: { index: 0 }, object: TABLE_SCENE.id, cell: TYPED_CELL },
          text: s.typedCellText,
        })
        await s.page.evaluate(() => window.__narrative_perf_harness!.setSelection([]))
        await settle(s.page)
        return tableValues(def, c)
      },
      'transform.move.table': async (s, def) => {
        // Unselected: the press selects the table and the drag moves it (on
        // a selected table it would wait for tap vs drag, or pick cells).
        await s.page.evaluate(() => window.__narrative_perf_harness!.setSelection([]))
        await settle(s.page)
        const home = s.table
        const p = await screenCentre(s.page, home)
        const c = await capture(s.page, async (inputEnd) => {
          await s.page.mouse.move(p.x, p.y)
          await s.page.mouse.down()
          for (let i = 1; i <= 60; i++) {
            await s.page.mouse.move(p.x + i * 4, p.y + Math.sin(i / 6) * 40)
            await s.page.waitForTimeout(16)
          }
          await s.page.mouse.up()
          await inputEnd()
        })
        const at = await objectXY(s.page, TABLE_SCENE.id)
        expect(
          at !== null && Math.hypot(at.x - home.x, at.y - home.y) > 100,
          `${TABLE_SCENE.id} moved`,
        ).toBe(true)
        s.last = c
        await command(s.page.context().request, s.deckId, 'object.update', {
          slide: { index: 0 },
          object: TABLE_SCENE.id,
          patch: { x: home.x, y: home.y },
        })
        await expect.poll(async () => (await objectXY(s.page, TABLE_SCENE.id))?.x).toBe(home.x)
        await s.page.evaluate(() => window.__narrative_perf_harness!.setSelection([]))
        return tableValues(def, c)
      },
      'viewport.zoom.commit.table': async (s, def) => {
        // From the fitted zoom every run (viewport.zoom.commit's protocol).
        await s.page.getByRole('button', { name: 'Reset zoom to 100%' }).hover()
        await s.page.getByRole('button', { name: 'Fit to screen' }).click()
        await settle(s.page)
        const a = (await s.page.locator('.artboard').boundingBox())!
        await s.page.mouse.move(a.x + a.width * 0.5, a.y + a.height * 0.5)
        const wheel = async (dy: number): Promise<void> => {
          await s.page.keyboard.down('ControlOrMeta')
          for (let i = 0; i < 8; i++) {
            await s.page.mouse.wheel(0, dy)
            await s.page.waitForTimeout(25)
          }
          await s.page.keyboard.up('ControlOrMeta')
        }
        const c = await capture(s.page, async (inputEnd) => {
          await wheel(-50)
          await s.page.waitForTimeout(1500)
          await wheel(50)
          await inputEnd()
        })
        s.last = c
        return tableValues(def, c)
      },
    },
  })
})
