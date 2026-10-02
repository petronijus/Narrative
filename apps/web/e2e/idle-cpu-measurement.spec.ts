/**
 * idle-cpu-measurement.spec.ts
 *
 * Regression reproducer for the idle thumbnail re-render loop (commit
 * 6b03c48 "perf(web): stop idle thumbnail re-render loop in deck editor").
 *
 * On a deck with one slide that has one object, the editor used to keep
 * re-rendering thumbnails at ~16 Hz while idle. Each pass hit
 * `extract.base64() → gl.readPixels`, which the nvidia driver flagged as
 * "GPU stall due to ReadPixels". Root cause: `useSlideThumbnails`
 * received a fresh `slideIds` array on every parent render, retriggering
 * the order-fingerprint effect on every cycle.
 *
 * The spec captures what runs on the main thread when the editor sits
 * idle on a deck with one slide, using CDP Performance.getMetrics + an
 * in-page rAF instrumentation to attribute frames to call sites. Run
 * with `SKIP_RECT=1` for a no-objects control, `LONG=1` for a 30 s window.
 *
 * Not wired into CI — diagnostic-only; invoke manually when chasing an
 * idle-CPU/GPU regression.
 */

import { test, type Page } from '@playwright/test'

async function createDeck(page: Page): Promise<string> {
  const res = await page.request.post('http://localhost:3001/decks', {
    data: { title: 'idle-cpu-measurement' },
  })
  const { id } = (await res.json()) as { id: string }
  return id
}

async function openDeckReady(page: Page, deckId: string): Promise<void> {
  await page.goto(`/deck/${deckId}`)
  await page.waitForFunction(() => typeof window.__narrative_test_api === 'object', null, {
    timeout: 15_000,
  })
}

test('idle CPU/GPU profile — 10s window', { tag: '@serial' }, async ({ page }) => {
  test.setTimeout(120_000)

  // Capture console + errors so we can see what the page is logging.
  const consoleLines: string[] = []
  page.on('console', (msg) => {
    consoleLines.push(`[${msg.type()}] ${msg.text()}`)
  })
  page.on('pageerror', (err) => {
    consoleLines.push(`[pageerror] ${err.message}`)
  })

  // Patch BEFORE the page loads so we catch any ticker that starts at init.
  await page.addInitScript(() => {
    // @ts-expect-error - test-only globals
    window.__tickerStartLog = [] as Array<{ when: number; stack: string }>
    // @ts-expect-error - test-only globals
    window.__tickerInstances = [] as unknown[]

    // Capture EVERY rAF callback body that ever gets registered.
    const origRAF = window.requestAnimationFrame.bind(window)
    // @ts-expect-error - test-only globals
    window.__earlyRafSrcs = new Set<string>()
    // @ts-expect-error - test-only globals
    window.__earlyRafLog = [] as Array<{ when: number; src: string; stack: string }>
    window.requestAnimationFrame = function (cb: FrameRequestCallback): number {
      const src = (cb as { name?: string }).name ?? '(anon)'
      const body = cb.toString().slice(0, 120).replace(/\s+/g, ' ')
      const key = `${src} :: ${body}`
      // @ts-expect-error - test-only globals
      ;(window.__earlyRafSrcs as Set<string>).add(key)
      const stack = (new Error().stack ?? '').split('\n').slice(1, 12).join(' | ')
      // @ts-expect-error - test-only globals
      window.__earlyRafLog.push({ when: performance.now(), src: key, stack })
      return origRAF(cb)
    }
  })

  const deckId = await createDeck(page)
  await openDeckReady(page, deckId)

  // Seed: add a single rect so there's something to render. Toggle via env.
  if (process.env.SKIP_RECT !== '1') {
    await page.evaluate(() => {
      window.__narrative_test_api!.addRect({
        id: 'idle-rect',
        x: 100,
        y: 100,
        w: 400,
        h: 300,
        fill: 0x3366ff,
      })
    })
  }

  // Let things settle.
  await page.waitForTimeout(2000)

  // Hook setLocalState to find awareness churn.
  await page.evaluate(() => {
    // @ts-expect-error - test-only globals
    window.__awarenessUpdates = [] as Array<{ when: number; state: string }>
    // The test API stores awareness on window or ctx. Just scan everything.
    const w = window as unknown as Record<string, unknown>
    // Look for any object with `setLocalState` method
    function deepSearchAwareness(obj: unknown, depth: number): unknown {
      if (depth > 3) return null
      if (obj === null || typeof obj !== 'object') return null
      const r = obj as Record<string, unknown>
      if (typeof r.setLocalState === 'function' && typeof r.getLocalState === 'function') {
        return r
      }
      for (const k of Object.keys(r)) {
        try {
          const found = deepSearchAwareness(r[k], depth + 1)
          if (found) return found
        } catch {}
      }
      return null
    }
    // No-op for now; would need test API support
    void w
    void deepSearchAwareness
  })

  // Detect signal of "what is dirtying the Y.Doc". Patch slideObserve flush
  // and the deck event subscriber by counting their calls.
  await page.evaluate(() => {
    // Capture every Y transaction by hooking Doc.transact via window.__narrative_test_api?
    // The cleanest probe: count Yjs `update` events on the deck doc.
    const w = window as unknown as {
      __narrative_test_api?: {
        getYDoc?: () => unknown
        getDeckCtx?: () => unknown
      }
    }
    // @ts-expect-error - test-only globals
    window.__yUpdateCount = 0
    // @ts-expect-error - test-only globals
    window.__yUpdateOrigins = [] as Array<{ when: number; origin: unknown }>
    // Find Yjs doc via test API if available
    const doc = w.__narrative_test_api?.getYDoc?.() as
      | { on?: (ev: string, fn: (...a: unknown[]) => void) => void }
      | undefined
    if (doc && typeof doc.on === 'function') {
      doc.on('update', (_update: unknown, origin: unknown) => {
        // @ts-expect-error - test-only globals
        window.__yUpdateCount++
        // @ts-expect-error - test-only globals
        if (window.__yUpdateOrigins.length < 50) {
          // @ts-expect-error - test-only globals
          window.__yUpdateOrigins.push({
            when: performance.now(),
            origin:
              origin == null
                ? null
                : typeof origin === 'object'
                  ? origin.constructor.name
                  : String(origin),
          })
        }
      })
    }
  })

  // Find ALL canvas elements in DOM and offscreen — gives us a count of how
  // many Pixi Applications are live.
  const canvasInfo = await page.evaluate(() => {
    const canvases = document.querySelectorAll('canvas')
    return {
      count: canvases.length,
      details: Array.from(canvases).map((c) => ({
        width: c.width,
        height: c.height,
        clientWidth: c.clientWidth,
        clientHeight: c.clientHeight,
        inDom: c.isConnected,
        parentTag: c.parentElement?.tagName ?? null,
        dataAttrs: Array.from(c.attributes).map((a) => `${a.name}=${a.value}`),
      })),
    }
  })
  console.log('Canvas elements:', JSON.stringify(canvasInfo, null, 2))

  // Probe what's actually subscribed to the live Pixi ticker.
  const tickerState = await page.evaluate(() => {
    const w = window as unknown as {
      __narrative_perf?: { app?: { ticker?: unknown; stage?: unknown } }
      __narrative_scene_graph?: unknown
    }
    const app = w.__narrative_perf?.app as
      | {
          ticker?: {
            started?: boolean
            FPS?: number
            count?: number
            _head?: { next?: { _fn?: { name?: string } | null } | null }
          }
        }
      | undefined
    if (!app || !app.ticker) return { state: 'no app/ticker' }
    const ticker = app.ticker
    const listeners: string[] = []
    let cur = ticker._head?.next ?? null
    let safety = 0
    while (cur && safety < 50) {
      const fn = (cur as { _fn?: ((...a: unknown[]) => unknown) | null })._fn
      const name = fn && typeof fn === 'function' ? fn.name || '(anon)' : '(null)'
      const src = fn && typeof fn === 'function' ? fn.toString().slice(0, 200) : ''
      listeners.push(`${name} :: ${src.replace(/\s+/g, ' ').slice(0, 160)}`)
      cur = (cur as { next?: unknown }).next as typeof cur
      safety++
    }
    return {
      started: ticker.started ?? null,
      fps: ticker.FPS ?? null,
      listenerCount: listeners.length,
      listeners,
    }
  })
  console.log('Live Pixi ticker state:', JSON.stringify(tickerState, null, 2))

  // Monkey-patch Application.start/stop to track when tickers get started.
  // We do this BEFORE the measurement window so we can confirm whether
  // anything pokes them after init.
  await page.evaluate(() => {
    // @ts-expect-error - test-only globals
    window.__tickerStartLog = [] as Array<{ when: number; stack: string }>
    // Patch ALL existing Tickers — find one through the live Pixi app.
    const w = window as unknown as { __narrative_perf?: { app?: { ticker?: unknown } } }
    const ticker = w.__narrative_perf?.app?.ticker as
      | {
          start?: () => void
          _requestIfNeeded?: () => void
          _tick?: (t: number) => void
          constructor: { prototype: { start: () => void; _requestIfNeeded: () => void } }
        }
      | undefined
    if (ticker) {
      const proto = ticker.constructor.prototype
      const origStart = proto.start
      proto.start = function (this: unknown) {
        // @ts-expect-error - test-only globals
        window.__tickerStartLog.push({
          when: performance.now(),
          stack: (new Error().stack ?? '').split('\n').slice(1, 6).join(' | '),
        })
        return origStart.call(this)
      }
      const origReq = proto._requestIfNeeded
      proto._requestIfNeeded = function (this: unknown) {
        // @ts-expect-error - test-only globals
        window.__tickerStartLog.push({
          when: performance.now(),
          stack:
            '_requestIfNeeded: ' + (new Error().stack ?? '').split('\n').slice(1, 5).join(' | '),
        })
        return origReq.call(this)
      }
    }
  })

  // Install fetch + XHR + console.log instrumentation to catch network/log noise.
  await page.evaluate(() => {
    // @ts-expect-error - test-only globals
    window.__networkCalls = [] as string[]
    const origFetch = window.fetch.bind(window)
    window.fetch = function (...args: Parameters<typeof fetch>) {
      const url =
        typeof args[0] === 'string' ? args[0] : ((args[0] as Request).url ?? String(args[0]))
      // @ts-expect-error - test-only globals
      window.__networkCalls.push(url)
      return origFetch(...args)
    }
  })

  // Install rAF instrumentation BEFORE we start the measurement window.
  await page.evaluate(() => {
    // @ts-expect-error - test-only globals
    window.__rafCounts = {} as Record<string, number>
    // @ts-expect-error - test-only globals
    window.__rafTotal = 0

    const origRAF = window.requestAnimationFrame.bind(window)
    window.requestAnimationFrame = function (cb: FrameRequestCallback): number {
      // Capture a small stack frame slice as the bucket key.
      const stack = new Error().stack ?? '(no stack)'
      const lines = stack.split('\n')
      // Drop the first 2 lines (Error, this wrapper) and keep next 2 frames.
      const key = lines
        .slice(2, 5)
        .map((l) => l.trim())
        .join(' <- ')
      return origRAF((t: number) => {
        // @ts-expect-error - test-only globals
        window.__rafCounts[key] = (window.__rafCounts[key] ?? 0) + 1
        // @ts-expect-error - test-only globals
        window.__rafTotal++
        try {
          cb(t)
        } catch (e) {
          // swallow — measurement must not crash
        }
      })
    }

    // Also count setInterval callers.
    // @ts-expect-error - test-only globals
    window.__intervalCounts = {} as Record<string, { hits: number; ms: number }>
    const origInterval = window.setInterval.bind(window)
    // @ts-expect-error - swap with our wrapper
    window.setInterval = function (handler: TimerHandler, ms?: number, ...args: unknown[]) {
      const stack = new Error().stack ?? '(no stack)'
      const lines = stack.split('\n')
      const key = lines
        .slice(2, 5)
        .map((l) => l.trim())
        .join(' <- ')
      const wrapped =
        typeof handler === 'function'
          ? () => {
              // @ts-expect-error - test-only globals
              const slot = window.__intervalCounts[key] ?? { hits: 0, ms: ms ?? 0 }
              slot.hits++
              // @ts-expect-error - test-only globals
              window.__intervalCounts[key] = slot
              try {
                ;(handler as (...a: unknown[]) => unknown)(...args)
              } catch (e) {
                // swallow
              }
            }
          : handler
      return origInterval(wrapped, ms, ...args)
    }
  })

  // Open CDP session for Performance metrics.
  const client = await page.context().newCDPSession(page)
  await client.send('Performance.enable')

  const baseline = (await client.send('Performance.getMetrics')) as {
    metrics: Array<{ name: string; value: number }>
  }
  const baselineMap = new Map(baseline.metrics.map((m) => [m.name, m.value]))

  // Reset rAF counters now so we measure the next 10s exactly.
  await page.evaluate(() => {
    // @ts-expect-error - test-only globals
    window.__rafCounts = {}
    // @ts-expect-error - test-only globals
    window.__rafTotal = 0
    // @ts-expect-error - test-only globals
    window.__intervalCounts = {}
    // @ts-expect-error - test-only globals
    window.__networkCalls = []
  })

  const startWall = Date.now()
  await page.waitForTimeout(process.env.LONG === '1' ? 30_000 : 10_000)
  const wallMs = Date.now() - startWall

  const final = (await client.send('Performance.getMetrics')) as {
    metrics: Array<{ name: string; value: number }>
  }
  const finalMap = new Map(final.metrics.map((m) => [m.name, m.value]))

  const delta = (name: string): number => (finalMap.get(name) ?? 0) - (baselineMap.get(name) ?? 0)

  const metrics = {
    wallMs,
    ScriptDuration: delta('ScriptDuration'),
    LayoutDuration: delta('LayoutDuration'),
    RecalcStyleDuration: delta('RecalcStyleDuration'),
    TaskDuration: delta('TaskDuration'),
    V8CompileDuration: delta('V8CompileDuration'),
    JSHeapUsedSize: finalMap.get('JSHeapUsedSize') ?? 0,
    JSHeapTotalSize: finalMap.get('JSHeapTotalSize') ?? 0,
    DomNodes: finalMap.get('Nodes') ?? 0,
    LayoutCount: delta('LayoutCount'),
    RecalcStyleCount: delta('RecalcStyleCount'),
    Frames: delta('Frames'),
  }

  const rafCounts = (await page.evaluate(() => {
    // @ts-expect-error - test-only globals
    const counts = (window.__rafCounts ?? {}) as Record<string, number>
    // @ts-expect-error - test-only globals
    const total = (window.__rafTotal ?? 0) as number
    return { counts, total }
  })) as { counts: Record<string, number>; total: number }

  const intervalCounts = (await page.evaluate(() => {
    // @ts-expect-error - test-only globals
    return (window.__intervalCounts ?? {}) as Record<string, { hits: number; ms: number }>
  })) as Record<string, { hits: number; ms: number }>

  const networkCalls = (await page.evaluate(() => {
    // @ts-expect-error - test-only globals
    return (window.__networkCalls ?? []) as string[]
  })) as string[]

  // Re-probe ticker state at the END of the window — was it started during?
  const tickerStateAfter = await page.evaluate(() => {
    const w = window as unknown as {
      __narrative_perf?: { app?: { ticker?: unknown } }
    }
    const app = w.__narrative_perf?.app as
      | { ticker?: { started?: boolean; FPS?: number; _requestId?: number | null } }
      | undefined
    if (!app || !app.ticker) return { state: 'no app/ticker' }
    return {
      started: app.ticker.started ?? null,
      fps: app.ticker.FPS ?? null,
      requestId: app.ticker._requestId ?? null,
    }
  })
  console.log('Live Pixi MAIN ticker state AFTER window:', JSON.stringify(tickerStateAfter))

  // Dump ticker start log.
  const tickerLog = (await page.evaluate(() => {
    // @ts-expect-error - test-only globals
    return (window.__tickerStartLog ?? []) as Array<{ when: number; stack: string }>
  })) as Array<{ when: number; stack: string }>
  console.log(`\nTicker start/_requestIfNeeded events (${tickerLog.length} total):`)
  // Group by stack.
  const tickerGroups = new Map<string, number>()
  for (const e of tickerLog) {
    tickerGroups.set(e.stack, (tickerGroups.get(e.stack) ?? 0) + 1)
  }
  const sortedTicker = [...tickerGroups.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
  for (const [stack, count] of sortedTicker) {
    console.log(`  ${count.toString().padStart(4)}  ${stack}`)
  }

  // Dump the FIRST occurrence of each distinct rAF body, with stack.
  const firstRafCalls = (await page.evaluate(() => {
    // @ts-expect-error - test-only globals
    const log = (window.__earlyRafLog ?? []) as Array<{
      when: number
      src: string
      stack: string
    }>
    // Group by src key, keep first.
    const firstBySrc = new Map<string, { when: number; src: string; stack: string }>()
    for (const e of log) {
      if (!firstBySrc.has(e.src)) firstBySrc.set(e.src, e)
    }
    return Array.from(firstBySrc.values())
  })) as Array<{ when: number; src: string; stack: string }>

  console.log(`\nFirst-occurrence rAF schedules (${firstRafCalls.length}):`)
  for (const e of firstRafCalls) {
    console.log(`  T+${e.when.toFixed(0)}ms`)
    console.log(`    cb: ${e.src.slice(0, 120)}`)
    console.log(`    stack: ${e.stack}`)
  }

  // Sort rAF entries by count descending and print top 15.
  const sortedRaf = Object.entries(rafCounts.counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)

  const sortedIntervals = Object.entries(intervalCounts)
    .sort((a, b) => b[1].hits - a[1].hits)
    .slice(0, 20)

  console.log('\n========================================')
  console.log('IDLE CPU/GPU MEASUREMENT — 10s window')
  console.log('========================================')
  console.log('CDP Performance metrics (delta over window):')
  console.log(JSON.stringify(metrics, null, 2))
  console.log('\nTotal rAF callbacks fired:', rafCounts.total)
  console.log('rAF call rate:', (rafCounts.total / (wallMs / 1000)).toFixed(1), 'cb/sec')
  console.log('\nTop rAF call sites (count, stack key):')
  for (const [key, count] of sortedRaf) {
    console.log(`  ${count.toString().padStart(5)}  ${key}`)
  }
  console.log('\nTop setInterval call sites (hits, interval ms, stack key):')
  for (const [key, slot] of sortedIntervals) {
    console.log(`  ${slot.hits.toString().padStart(5)} @ ${slot.ms}ms  ${key}`)
  }

  // Group applyFilterEffects rAF schedules by their FULL stack (10 frames)
  // so we can identify which call-path is the actual culprit.
  const filterStacks = (await page.evaluate(() => {
    // @ts-expect-error - test-only globals
    const log = (window.__earlyRafLog ?? []) as Array<{
      when: number
      src: string
      stack: string
    }>
    const grouped: Record<string, number> = {}
    for (const e of log) {
      if (!e.stack.includes('applyFilterEffects')) continue
      grouped[e.stack] = (grouped[e.stack] ?? 0) + 1
    }
    return grouped
  })) as Record<string, number>
  const sortedFilterStacks = Object.entries(filterStacks)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
  console.log('\napplyFilterEffects unique stacks (top 5):')
  for (const [stack, count] of sortedFilterStacks) {
    console.log(`  ===== ${count} hits =====`)
    console.log(`  ${stack.replace(/ \| /g, '\n  ')}`)
  }

  // Bucket applyFilterEffects rAF schedules into 1-second bins to see
  // whether they're a one-off burst or a sustained rate.
  const filterBuckets = (await page.evaluate(() => {
    // @ts-expect-error - test-only globals
    const log = (window.__earlyRafLog ?? []) as Array<{
      when: number
      src: string
      stack: string
    }>
    const buckets: Record<number, number> = {}
    for (const e of log) {
      if (!e.stack.includes('applyFilterEffects')) continue
      const sec = Math.floor(e.when / 1000)
      buckets[sec] = (buckets[sec] ?? 0) + 1
    }
    return buckets
  })) as Record<number, number>
  console.log('\napplyFilterEffects rAF schedules per second (sec -> count):')
  const sortedBuckets = Object.entries(filterBuckets)
    .map(([s, c]) => ({ s: Number(s), c }))
    .sort((a, b) => a.s - b.s)
  for (const { s, c } of sortedBuckets) {
    console.log(`  T+${s}s: ${c}`)
  }

  // Group network calls by URL.
  const netCounts = new Map<string, number>()
  for (const u of networkCalls) {
    netCounts.set(u, (netCounts.get(u) ?? 0) + 1)
  }
  const sortedNet = [...netCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
  console.log('\nNetwork calls during window (top 15):')
  for (const [url, count] of sortedNet) {
    console.log(`  ${count.toString().padStart(4)}  ${url}`)
  }
  console.log(`  TOTAL: ${networkCalls.length}`)
  console.log('========================================\n')

  // Filter console output for anything that looks like it logs every frame.
  const noisyConsole = consoleLines.filter(
    (l) =>
      l.includes('render') ||
      l.includes('frame') ||
      l.includes('tick') ||
      l.includes('warn') ||
      l.includes('error'),
  )
  if (noisyConsole.length > 0) {
    console.log('Noisy console lines (first 30):')
    for (const l of noisyConsole.slice(0, 30)) console.log('  ', l)
  }
})
