/**
 * deck-size.spec.ts — what the size of a deck costs (docs/plans/
 * performance.md → G3): opening a deck of 10 and of 100 slides, cold (a new
 * browser context: no HTTP cache, a new socket) and warm (the same context
 * again), and on the 100-slide deck switching slides, dragging a slide to a
 * new place and adding one. Each slide holds 6 texts, 4 rectangles and 2
 * pictures (packages/perf/src/scenes.ts → deckOps). PERF_SLIDES changes the
 * size of the slide.* benches' deck (default 100; any other size is printed,
 * not stored).
 *
 * The open metrics are taken on the page's clock (ms from navigation start):
 * first paint and socket sync from state/loadTimings.ts, every object of the
 * first slide mounted, and settled — no raster, thumbnail or load left, which
 * is "all thumbnails drawn".
 */

import type { BrowserContext, Page } from '@playwright/test'
import type { BenchDef } from '@narrative/perf'
import { expect, test } from '../fixtures/test'
import {
  launchOptions,
  PERF,
  runScenarios,
  selected,
  sideContext,
  type SideSpec,
  type SideState,
} from './lib/driver'
import {
  assertPerfOff,
  capture,
  counterValues,
  gestureValues,
  openDeck,
  QUIET_MS,
  settle,
} from './lib/page'
import { applyOps, command, createDeck, deckOps, photoFiles, uploadPhotos } from './lib/seed'

const OPEN_IDS = [
  'deck.open.cold.10',
  'deck.open.warm.10',
  'deck.open.cold.100',
  'deck.open.warm.100',
]
const SLIDE_IDS = ['slide.switch.100', 'slide.reorder.100', 'slide.add.100']
const SLIDES = Number(process.env['PERF_SLIDES'] ?? 100)
const VIEWPORT = { width: 1600, height: 1000 }

interface Deck {
  id: string
  perSlide: string[][]
}

interface DeckState extends SideState {
  context: BrowserContext
  decks: Map<number, Deck>
}

if (PERF.gpu) test.use({ launchOptions: launchOptions() })
test.skip(!PERF.run, 'perf scenarios run through `just perf`')

async function seed(context: BrowserContext, slides: number, side: SideSpec): Promise<Deck> {
  const id = await createDeck(context.request, `perf deck ${slides} slides (${side.name})`)
  const assets = await uploadPhotos(context.request, id, photoFiles())
  const { ops, perSlide } = deckOps(slides, assets)
  await applyOps(context.request, id, ops)
  return { id, perSlide }
}

const OPEN_KEYS = new Set([
  'open.firstPaint',
  'open.wsSynced',
  'open.mounted',
  'open.settled',
  'longTask.total',
  'render.count',
])

/** Open a deck in `page` and time it on the page's clock. */
async function timedOpen(
  page: Page,
  deck: Deck,
  metrics: Parameters<typeof counterValues>[0],
): Promise<Record<string, number>> {
  await page.goto(`/deck/${deck.id}?perf=1`, { waitUntil: 'commit' })
  const t = await page.evaluate(
    async ({ ids, quietMs }) => {
      const until = (cond: () => boolean, timeoutMs: number): Promise<number> =>
        new Promise((resolve, reject) => {
          const end = performance.now() + timeoutMs
          const tick = (): void => {
            if (cond()) return resolve(performance.now())
            if (performance.now() > end) return reject(new Error('timed out'))
            requestAnimationFrame(tick)
          }
          tick()
        })
      const mounted = await until(() => {
        const h = window.__narrative_perf_harness
        if (h === undefined) return false
        const have = new Set(h.mountedIds())
        return ids.every((i) => have.has(i))
      }, 120_000)
      const h = window.__narrative_perf_harness!
      const t0 = performance.now()
      const r = await h.settle({ quietMs, timeoutMs: 120_000 })
      if (!r.ok) throw new Error(`not settled: ${r.reason}`)
      const lt = h.loadTimings()
      const at = (ms: number | null | undefined): number =>
        lt === null || ms === null || ms === undefined ? -1 : lt.start + ms
      return {
        mounted,
        settled: t0 + r.waitedMs - quietMs,
        firstPaint: at(lt?.firstPaintMs),
        wsSynced: at(lt?.wsSyncedMs),
        longTasks: (h.longTasks() ?? []).reduce((a, l) => a + l.ms, 0),
        counters: h.counters(),
      }
    },
    { ids: deck.perSlide[0]!, quietMs: QUIET_MS },
  )
  return {
    'open.firstPaint': t.firstPaint,
    'open.wsSynced': t.wsSynced,
    'open.mounted': t.mounted,
    'open.settled': t.settled,
    'longTask.total': t.longTasks,
    'render.count': t.counters['editor.render'] ?? 0,
    ...counterValues(metrics, t.counters, OPEN_KEYS),
  }
}

function rows(page: Page) {
  return page.locator('[role="option"][data-slide-id]')
}

async function rowIds(page: Page): Promise<string[]> {
  return rows(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-slide-id')!))
}

async function mountedAll(page: Page, ids: readonly string[]): Promise<void> {
  await page.evaluate(
    (list) =>
      new Promise<void>((resolve) => {
        const tick = (): void => {
          const have = new Set(window.__narrative_perf_harness!.mountedIds())
          if (list.every((i) => have.has(i))) resolve()
          else requestAnimationFrame(tick)
        }
        tick()
      }),
    [...ids],
  )
}

test('deck size', async ({ browser }) => {
  const ids = selected([...OPEN_IDS, ...SLIDE_IDS])
  test.skip(ids.length === 0, 'no bench of this spec selected')
  test.setTimeout(120 * 60_000)

  const sizes = new Set<number>()
  for (const id of ids) {
    if (id.endsWith('.10')) sizes.add(10)
    else if (id.startsWith('deck.open')) sizes.add(100)
    else sizes.add(SLIDES)
  }
  const states: DeckState[] = []
  for (const side of PERF.sides) {
    const context = await sideContext(browser, side, VIEWPORT)
    const page = await context.newPage()
    const decks = new Map<number, Deck>()
    for (const n of sizes) {
      const t = Date.now()
      decks.set(n, await seed(context, n, side))
      console.log(`PERF scene deck of ${n} slides [${side.name}] seeded in ${Date.now() - t} ms`)
    }
    // A page with the harness for the fingerprint, and the counter-off probe.
    const first = decks.get(Math.max(...sizes))!
    await assertPerfOff(page, first.id, PERF.mode)
    await openDeck(page, first.id, first.perSlide[0]!)
    states.push({ side, page, context, decks })
  }

  /** The 100-slide (PERF_SLIDES) deck open on the side's page, slide 1 active. */
  const onSlideDeck = async (s: DeckState): Promise<Deck> => {
    const deck = s.decks.get(SLIDES)!
    if (!s.page.url().includes(deck.id)) await openDeck(s.page, deck.id, deck.perSlide[0]!)
    return deck
  }

  const open = (size: number, cold: boolean) => async (s: DeckState, def: BenchDef<never>) => {
    const deck = s.decks.get(size)!
    if (!cold) return timedOpen(s.page, deck, def.metrics)
    const context = await sideContext(browser, s.side, VIEWPORT)
    try {
      return await timedOpen(await context.newPage(), deck, def.metrics)
    } finally {
      await context.close()
    }
  }

  await runScenarios<DeckState>({
    browser,
    ids,
    states,
    sceneIsDefault: SLIDES === 100 || !ids.some((i) => SLIDE_IDS.includes(i)),
    runs: {
      'deck.open.cold.10': open(10, true),
      'deck.open.warm.10': open(10, false),
      'deck.open.cold.100': open(100, true),
      'deck.open.warm.100': open(100, false),
      'slide.switch.100': async (s, def) => {
        const deck = await onSlideDeck(s)
        const c = await capture(s.page, async (inputEnd) => {
          await rows(s.page).nth(1).click()
          await mountedAll(s.page, deck.perSlide[1]!)
          await rows(s.page).nth(0).click()
          await mountedAll(s.page, deck.perSlide[0]!)
          await inputEnd()
        })
        s.last = c
        return gestureValues(def.metrics, c)
      },
      'slide.reorder.100': async (s, def) => {
        const deck = await onSlideDeck(s)
        const before = await rowIds(s.page)
        const moved = before[2]!
        const from = (await rows(s.page).nth(2).boundingBox())!
        const to = (await rows(s.page).nth(5).boundingBox())!
        const c = await capture(s.page, async (inputEnd) => {
          const x = from.x + from.width / 2
          const y = from.y + from.height / 2
          await s.page.mouse.move(x, y)
          await s.page.mouse.down()
          await s.page.mouse.move(x, y + 20, { steps: 4 })
          await s.page.mouse.move(x, to.y + to.height / 2 + 6, { steps: 12 })
          await s.page.mouse.up()
          await expect.poll(async () => (await rowIds(s.page)).indexOf(moved)).toBe(5)
          await inputEnd()
        })
        s.last = c
        await command(s.context.request, deck.id, 'slide.move', { slides: [moved], toIndex: 2 })
        await expect.poll(() => rowIds(s.page)).toEqual(before)
        await settle(s.page)
        return gestureValues(def.metrics, c)
      },
      'slide.add.100': async (s, def) => {
        const deck = await onSlideDeck(s)
        const before = await rowIds(s.page)
        const c = await capture(s.page, async (inputEnd) => {
          await s.page.getByRole('button', { name: 'Add slide' }).click()
          await expect.poll(async () => (await rowIds(s.page)).length).toBe(before.length + 1)
          await inputEnd()
        })
        s.last = c
        const added = (await rowIds(s.page)).filter((i) => !before.includes(i))
        await command(s.context.request, deck.id, 'slide.delete', { slides: added })
        await expect.poll(() => rowIds(s.page)).toEqual(before)
        await rows(s.page).nth(0).click()
        await mountedAll(s.page, deck.perSlide[0]!)
        await settle(s.page)
        return gestureValues(def.metrics, c)
      },
    },
  })
})
