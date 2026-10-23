// TEMPORARY probe (F7, deleted after use): what opening a 300-slide deck costs, by phase.
import { writeFileSync } from 'node:fs'
import { test } from './fixtures/test'
import { installReactPerfHook } from './perf/lib/reactHook'
import { applyOps, createDeck, deckOps, photoFiles, uploadPhotos } from './perf/lib/seed'
import { launchOptions } from './perf/lib/driver'

const SLIDES = Number(process.env['F7_SLIDES'] ?? 300)
const OUT = process.env['F7_OUT'] ?? '/tmp/f7-b3'
test.use({
  viewport: { width: 1600, height: 1000 },
  launchOptions: launchOptions(),
  video: 'off',
  trace: 'off',
  screenshot: 'off',
})

test('f7 b3 open probe', async ({ browser }) => {
  test.setTimeout(15 * 60_000)
  const seedCtx = await browser.newContext()
  const id = await createDeck(seedCtx.request, `f7 b3 probe ${SLIDES}`)
  const assets = await uploadPhotos(seedCtx.request, id, photoFiles())
  const { ops, perSlide } = deckOps(SLIDES, assets)
  await applyOps(seedCtx.request, id, ops)
  const results: unknown[] = []
  for (let run = 0; run < 2; run++) {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
    await context.addInitScript(installReactPerfHook)
    const page = await context.newPage()
    const cdp = await context.newCDPSession(page)
    await cdp.send('Profiler.enable')
    await cdp.send('Profiler.setSamplingInterval', { interval: 500 })
    await cdp.send('Profiler.start')
    await page.goto(`/deck/${id}?perf=1`, { waitUntil: 'commit' })
    const r = await page.evaluate(
      async ({ ids }) => {
        const until = (cond: () => boolean): Promise<number> =>
          new Promise((resolve) => {
            const tick = (): void =>
              cond() ? resolve(performance.now()) : void requestAnimationFrame(tick)
            tick()
          })
        const mounted = await until(() => {
          const h = window.__narrative_perf_harness
          if (h === undefined) return false
          const have = new Set(h.mountedIds())
          return ids.every((i) => have.has(i))
        })
        const h = window.__narrative_perf_harness!
        const reactAtMount = h.react()
        const countersAtMount = h.counters()
        const t0 = performance.now()
        const s = await h.settle({ quietMs: 800, timeoutMs: 300_000 })
        const lt = h.longTasks() ?? []
        const react = h.react()
        const rows = document.querySelectorAll('[role="option"][data-slide-id]').length
        const imgs = document.querySelectorAll('[role="option"][data-slide-id] img').length
        return {
          mounted,
          settled: t0 + s.waitedMs - 800,
          longBefore: lt.filter((l) => l.at < mounted).map((l) => Math.round(l.ms)),
          longAfter: lt.filter((l) => l.at >= mounted).map((l) => Math.round(l.ms)),
          reactAtMount: {
            commits: reactAtMount?.commits,
            renders: reactAtMount?.renders,
            top: reactAtMount?.byName.slice(0, 25),
          },
          react: {
            commits: react?.commits,
            renders: react?.renders,
            top: react?.byName.slice(0, 25),
          },
          countersAtMount,
          counters: h.counters(),
          routes: h.routes(),
          imgproxy: performance
            .getEntriesByType('resource')
            .map((e) => e.name)
            .filter((n) => n.includes('/imgproxy/'))
            .map((n) => new URL(n).pathname + new URL(n).search),
          rows,
          imgs,
        }
      },
      { ids: perSlide[0]! },
    )
    const { profile } = await cdp.send('Profiler.stop')
    writeFileSync(`${OUT}-run${run}.cpuprofile`, JSON.stringify(profile))
    results.push(r)
    await context.close()
  }
  writeFileSync(`${OUT}.json`, JSON.stringify(results, null, 1))
  console.log('F7B3 written ' + OUT)
  await seedCtx.close()
})
