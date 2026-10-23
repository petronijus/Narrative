/**
 * memory.spec.ts — what a long session leaves behind (docs/plans/
 * performance.md → E8): the growth benches of catalog/interaction.ts →
 * MEMORY_WORK. One run is one session in a page of its own: the scene
 * opened, a first pass (caches fill, code warms), then the same pass twice
 * more. A snapshot after each — the scene settled, then the retained JS heap after
 * a full collection and the DOM counters through CDP (Chromium), the GL
 * context's textures and their bytes, the WebGL contexts alive, the
 * elements, the object URLs (the in-page harness, every engine). What both
 * repeated passes added is the leak signal: a pass that ends where the first
 * ended must leave nothing new behind, and a leak adds with every pass, while
 * a one-off still in flight at one snapshot shows in only one of them
 * (counting the second pass alone made the budgets flap, 2026-10-23).
 *
 *   - memory.slide.switch: the 100-slide deck, down through every slide and
 *     back up from the slides panel's keys (198 switches a pass; 0 → 50 → 198
 *     → 396 in the details file);
 *   - memory.zoom.cycle: the crowded slide, five zoom commits in and out a
 *     pass (each re-rasterises every text at the new resolution);
 *   - memory.deck.reopen: the 10-slide deck closed to its folder and opened
 *     again through the app's own navigation, five times a pass;
 *   - memory.present.loop: one presentation of the photo deck, forward through
 *     every slide and back twice a pass.
 *
 * The heap is `usedSize + embedderHeapUsedSize + backingStorageSize` of
 * Runtime.getHeapUsage — V8's heap, Blink's (DOM objects) and array buffers
 * (pixel data) — never `performance.memory` (bucketed, cached for 20
 * minutes: present.spec.ts → retainedHeap). Nodes in Chromium are the
 * renderer's (`Memory.getDOMCounters` after the collections, detached nodes
 * still alive included); in WebKit the document's elements, and no heap or
 * listeners.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { BrowserContext, CDPSession, Page } from '@playwright/test'
import type { BenchDef } from '@narrative/perf'
import { MEMORY_HEAP_BOUND_MB } from '@narrative/perf'
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
import { assertPerfOff, counterValues, openDeck, settle, waitVisible } from './lib/page'
import { openPresentation, seedDeck, type PresentDeck } from './lib/presentDecks'
import {
  API_BASE,
  applyOps,
  createDeck,
  crowdedSlideOps,
  deckOps,
  photoFiles,
  uploadPhotos,
} from './lib/seed'

const IDS = [
  'memory.slide.switch',
  'memory.zoom.cycle',
  'memory.deck.reopen',
  'memory.present.loop',
]
const VIEWPORT = { width: 1600, height: 1000 }
const WEB_ORIGIN = process.env['NARRATIVE_WEB_URL'] ?? 'http://localhost:5173'
/** Zoom commits a pass (memory.zoom.cycle), reopens a pass (memory.deck.reopen), loops a pass (memory.present.loop). */
const ZOOMS = 5
const REOPENS = 5
const LOOPS = 2

if (PERF.gpu) test.use({ launchOptions: launchOptions() })
test.skip(!PERF.run, 'perf scenarios run through `just perf`')

interface Deck {
  id: string
  title: string
  perSlide: string[][]
}

interface MemoryState extends SideState {
  context: BrowserContext
  slides100?: Deck
  crowded?: Deck
  reopen?: Deck & { folderId: string }
  photo?: PresentDeck
}

/** One look at what the page holds. */
interface Snapshot {
  /** Retained heap after a full GC, bytes (0: unreadable). */
  heap: number
  textures: number
  textureBytes: number
  contexts: number
  nodes: number
  listeners: number
  blobUrls: number
}

const chromium = (page: Page): boolean =>
  PERF.shell === 'browser' && page.context().browser()?.browserType().name() === 'chromium'

async function collect(cdp: CDPSession, page: Page): Promise<void> {
  await cdp.send('HeapProfiler.collectGarbage')
  // Finalizers (FinalizationRegistry, weak callbacks) run as tasks after a
  // collection; what they drop goes with the second one.
  await page.evaluate(() => new Promise((r) => setTimeout(r, 50)))
  await cdp.send('HeapProfiler.collectGarbage')
}

/** Settle, collect, read. */
async function snapshot(page: Page): Promise<Snapshot> {
  // Released textures leave the GPU after a grace (ResourceManager,
  // UNLOAD_GRACE_MS 5 s): wait them out, or one released just before the
  // snapshot counts as growth (memory.zoom.cycle flapped 0/1/0, 2026-10-23).
  await settle(page, { timeoutMs: 120_000, unloads: true })
  let heap = 0
  let nodes: number | null = null
  let listeners = 0
  if (chromium(page)) {
    const cdp = await page.context().newCDPSession(page)
    try {
      await collect(cdp, page)
      const h = await cdp.send('Runtime.getHeapUsage')
      heap = h.usedSize + (h.embedderHeapUsedSize ?? 0) + (h.backingStorageSize ?? 0)
      // After the collections: detached nodes still alive count, collected ones not.
      const d = await cdp.send('Memory.getDOMCounters')
      nodes = d.nodes
      listeners = d.jsEventListeners
    } finally {
      await cdp.detach()
    }
  }
  const m = await page.evaluate(() => window.__narrative_perf_harness!.memory())
  return {
    heap,
    textures: m.editor?.textures ?? 0,
    textureBytes: m.editor?.textureBytes ?? 0,
    contexts: m.contexts,
    nodes: nodes ?? m.domNodes,
    listeners,
    blobUrls: m.blobUrls,
  }
}

/**
 * PERF_HEAP_SNAPSHOTS=<dir>: a V8 heap snapshot after each pass's snapshot
 * (Chromium), for a retained-size diff of what the second pass kept
 * (`<id>-<side>-<time>-first.heapsnapshot` / `…-second…`; open both in
 * DevTools → Memory, Comparison). Slow (seconds a snapshot): a diagnostic,
 * the run's numbers are then printed only.
 */
const HEAP_SNAPSHOTS = process.env['PERF_HEAP_SNAPSHOTS'] ?? ''

async function heapSnapshot(page: Page, name: string): Promise<void> {
  if (HEAP_SNAPSHOTS === '' || !chromium(page)) return
  mkdirSync(HEAP_SNAPSHOTS, { recursive: true })
  const cdp = await page.context().newCDPSession(page)
  const chunks: string[] = []
  cdp.on('HeapProfiler.addHeapSnapshotChunk', (e) => chunks.push(e.chunk))
  try {
    await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false })
  } finally {
    await cdp.detach()
  }
  const file = path.join(HEAP_SNAPSHOTS, `${name}.heapsnapshot`)
  writeFileSync(file, chunks.join(''))
  console.log(`PERF heap snapshot → ${file}`)
}

const MB = 1e6
const round1 = (v: number): number => Math.round(v * 10) / 10

/**
 * Growth both repeated passes show: the smaller of the two, never below 0. A
 * leak adds with every pass and shows in both; a one-off left in flight at one
 * snapshot (a texture waiting for its upload, a thumbnail, a GC that had not
 * yet run) shows in one and is not counted.
 */
const repeated = (a: number, b: number): number => Math.max(0, Math.min(a, b))

/** The bench's values from the four snapshots and the second pass's counters. */
function growthValues(
  def: BenchDef<never>,
  [s0, s1, s2, s3]: readonly [Snapshot, Snapshot, Snapshot, Snapshot],
  counters: Record<string, number>,
  wallMs: number,
): Record<string, number> {
  const bound = MEMORY_HEAP_BOUND_MB[def.id]
  if (bound === undefined) throw new Error(`${def.id}: no MEMORY_HEAP_BOUND_MB`)
  const growMB = (s2.heap - s1.heap) / MB
  const values: Record<string, number> = {
    'mem.heapMB': round1(s0.heap / MB),
    'mem.heap.firstMB': round1((s1.heap - s0.heap) / MB),
    'mem.heap.growMB': round1(growMB),
    'mem.textures': s2.textures,
    'mem.textures.first': s1.textures - s0.textures,
    'mem.textures.grow': s2.textures - s1.textures,
    'mem.textureMB': round1(s2.textureBytes / MB),
    'mem.textureMB.grow': round1((s2.textureBytes - s1.textureBytes) / MB),
    'mem.contexts': s2.contexts,
    'mem.nodes': s2.nodes,
    'mem.nodes.grow': s2.nodes - s1.nodes,
    'mem.listeners': s2.listeners,
    'mem.listeners.grow': s2.listeners - s1.listeners,
    'mem.blobUrls': s2.blobUrls,
    'mem.blobUrls.grow': s2.blobUrls - s1.blobUrls,
    wall: wallMs,
    // The budgeted growth: what both repeated passes added, the heap only above its bound.
    'mem.leak.heapMB': Math.ceil(repeated(growMB - bound, (s3.heap - s2.heap) / MB - bound)),
    'mem.leak.textures': repeated(s2.textures - s1.textures, s3.textures - s2.textures),
    'mem.leak.textureMB': Math.ceil(
      repeated((s2.textureBytes - s1.textureBytes) / MB, (s3.textureBytes - s2.textureBytes) / MB),
    ),
    'mem.leak.contexts': repeated(s2.contexts - s1.contexts, s3.contexts - s2.contexts),
    'mem.leak.nodes': repeated(s2.nodes - s1.nodes, s3.nodes - s2.nodes),
    'mem.leak.listeners': repeated(s2.listeners - s1.listeners, s3.listeners - s2.listeners),
    'mem.leak.blobUrls': repeated(s2.blobUrls - s1.blobUrls, s3.blobUrls - s2.blobUrls),
  }
  return { ...counterValues(def.metrics, counters, new Set(Object.keys(values))), ...values }
}

/** Wait until every id is mounted on the canvas. */
async function mountedAll(page: Page, ids: readonly string[]): Promise<void> {
  await page.evaluate(
    (list) =>
      new Promise<void>((resolve, reject) => {
        const end = performance.now() + 60_000
        const tick = (): void => {
          const have = new Set(window.__narrative_perf_harness!.mountedIds())
          if (list.every((i) => have.has(i))) return resolve()
          if (performance.now() > end) return reject(new Error('slide never mounted'))
          requestAnimationFrame(tick)
        }
        tick()
      }),
    [...ids],
  )
}

async function folderCommand<T>(
  context: BrowserContext,
  target: Record<string, string>,
  name: string,
  input: unknown,
): Promise<T> {
  const res = await context.request.post(`${API_BASE}/commands`, {
    headers: { Origin: WEB_ORIGIN },
    data: { target, command: name, input },
    timeout: 120_000,
  })
  const body = (await res.json()) as { ok: boolean; result: T; error?: { message: string } }
  expect(body.ok, `${name}: ${body.error?.message ?? res.status()}`).toBe(true)
  return body.result
}

async function seedSlides(
  context: BrowserContext,
  slides: number,
  title: string,
  folderId?: string,
): Promise<Deck> {
  let id: string
  if (folderId === undefined) id = await createDeck(context.request, title)
  else {
    const res = await context.request.post(`${API_BASE}/decks`, { data: { title, folderId } })
    expect(res.ok(), `deck creation failed: ${res.status()}`).toBe(true)
    id = ((await res.json()) as { id: string }).id
  }
  const assets = await uploadPhotos(context.request, id, photoFiles())
  const { ops, perSlide } = deckOps(slides, assets)
  await applyOps(context.request, id, ops)
  return { id, title, perSlide }
}

async function seedCrowded(context: BrowserContext, title: string): Promise<Deck> {
  const id = await createDeck(context.request, title)
  const assets = await uploadPhotos(context.request, id, photoFiles())
  const { ops, boxes } = crowdedSlideOps({ texts: 120, images: 40, rects: 60 }, assets)
  await applyOps(context.request, id, ops)
  return { id, title, perSlide: [[...boxes.keys()]] }
}

/** The slides panel's keys: down to the last slide, back up to the first. */
async function switchPass(
  page: Page,
  deck: Deck,
  onSwitch?: (n: number) => Promise<void>,
): Promise<void> {
  const n = deck.perSlide.length
  let switches = 0
  const step = async (key: string, to: number): Promise<void> => {
    await page.keyboard.press(key)
    await mountedAll(page, deck.perSlide[to]!)
    switches++
    await onSwitch?.(switches)
  }
  for (let i = 1; i < n; i++) await step('ArrowDown', i)
  for (let i = n - 2; i >= 0; i--) await step('ArrowUp', i)
}

/** In by eight wheel steps, a rest for the commit and its staging, out again, settled; then fitted. */
async function zoomPass(page: Page): Promise<void> {
  for (let z = 0; z < ZOOMS; z++) {
    const a = (await page.locator('.artboard').boundingBox())!
    await page.mouse.move(a.x + a.width * 0.47, a.y + a.height * 0.5)
    const wheel = async (dy: number): Promise<void> => {
      await page.keyboard.down('ControlOrMeta')
      for (let i = 0; i < 8; i++) {
        await page.mouse.wheel(0, dy)
        await page.waitForTimeout(25)
      }
      await page.keyboard.up('ControlOrMeta')
    }
    await wheel(-50)
    await page.waitForTimeout(1500)
    await wheel(50)
    await settle(page, { timeoutMs: 60_000 })
    await page.getByRole('button', { name: 'Reset zoom to 100%' }).hover({ timeout: 30_000 })
    await page.getByRole('button', { name: 'Fit to screen' }).click({ timeout: 30_000 })
    await settle(page, { timeoutMs: 60_000 })
  }
}

/** Back to the folder and into the deck again, through the app's own navigation. */
async function reopenPass(page: Page, deck: Deck & { folderId: string }): Promise<void> {
  for (let r = 0; r < REOPENS; r++) {
    // Every wait bounded: an action that cannot happen must fail the run, not hold the queue.
    await page.getByRole('button', { name: 'Back to deck list' }).click({ timeout: 30_000 })
    await expect(page).toHaveURL(new RegExp(`/folder/${deck.folderId}`))
    const card = page.getByText(deck.title, { exact: true })
    await expect(card).toBeVisible({ timeout: 60_000 })
    await settle(page, { timeoutMs: 60_000 })
    await card.click({ timeout: 30_000 })
    await expect(page).toHaveURL(new RegExp(`/deck/${deck.id}`))
    await waitVisible(page, '.artboard', 60_000)
    await mountedAll(page, deck.perSlide[0]!)
    await settle(page, { timeoutMs: 60_000 })
  }
}

/** Forward through every slide and back, LOOPS times: each advance shown and quiet. */
async function presentPass(page: Page, deck: PresentDeck): Promise<void> {
  const n = deck.slideIds.length
  const advance = async (key: string, to: number): Promise<void> => {
    await page.keyboard.press(key)
    await page.evaluate(
      async ({ target }) => {
        await new Promise<void>((resolve, reject) => {
          const end = performance.now() + 30_000
          const tick = (): void => {
            const el = document.querySelector('[data-testid="slide-container"]')
            if (el?.getAttribute('data-active-slide-id') === target) return resolve()
            if (performance.now() > end) return reject(new Error(`slide ${target} never shown`))
            requestAnimationFrame(tick)
          }
          tick()
        })
        const r = await window.__narrative_perf_harness!.settle({ quietMs: 300, timeoutMs: 60_000 })
        if (!r.ok) throw new Error(`slide ${target} did not settle: ${r.reason}`)
      },
      { target: deck.slideIds[to]! },
    )
  }
  for (let l = 0; l < LOOPS; l++) {
    for (let i = 1; i < n; i++) await advance('ArrowRight', i)
    for (let i = n - 2; i >= 0; i--) await advance('ArrowLeft', i)
  }
}

test('memory growth', async ({ browser }) => {
  const ids = selected(IDS)
  test.skip(ids.length === 0, 'no bench of this spec selected')
  test.setTimeout(180 * 60_000)

  const states: MemoryState[] = []
  for (const side of PERF.sides) {
    const context = await sideContext(browser, side, VIEWPORT)
    // The harness follows texture bindings and allocations (bytes) on these pages.
    await context.addInitScript(() => {
      ;(window as unknown as { __narrative_perf_residency?: boolean }).__narrative_perf_residency =
        true
    })
    const page = await perfPage(context, side, VIEWPORT)
    const s: MemoryState = { side, page, context }
    const t = Date.now()
    const label = `${side.name} ${Date.now()}`
    if (ids.includes('memory.slide.switch'))
      s.slides100 = await seedSlides(context, 100, `perf memory 100 slides (${label})`)
    if (ids.includes('memory.zoom.cycle'))
      s.crowded = await seedCrowded(context, `perf memory crowded (${label})`)
    if (ids.includes('memory.deck.reopen')) {
      const folder = await folderCommand<{ id: string }>(context, {}, 'folder.create', {
        // Named apart from its deck: the folder page shows both names.
        name: `perf memory folder (${label})`,
      })
      const deck = await seedSlides(context, 10, `perf memory reopen (${label})`, folder.id)
      s.reopen = { ...deck, folderId: folder.id }
    }
    if (ids.includes('memory.present.loop')) s.photo = await seedDeck(context, 'photo', label)
    console.log(`PERF scene memory [${side.name}] seeded in ${Date.now() - t} ms`)
    const first = s.slides100 ?? s.crowded ?? s.reopen
    if (first !== undefined) {
      await assertPerfOff(page, first.id, PERF.mode)
      // A page with the harness, for the fingerprint.
      await openDeck(page, first.id, first.perSlide[0]!)
    } else await openPresentation(page, s.photo!)
    states.push(s)
  }

  /**
   * One session in a page of its own (its heap is the page's alone; the
   * side's page waits on about:blank meanwhile): open, snapshot, a pass,
   * snapshot, the counters zeroed, the same pass, snapshot.
   */
  const session =
    (
      open: (page: Page, s: MemoryState) => Promise<void>,
      pass: (page: Page, s: MemoryState, notes: Record<string, number>) => Promise<void>,
    ) =>
    async (s: MemoryState, def: BenchDef<never>): Promise<Record<string, number>> => {
      const page = PERF.shell === 'browser' ? await s.context.newPage() : s.page
      if (page !== s.page) await s.page.goto('about:blank')
      try {
        await open(page, s)
        const notes: Record<string, number> = {}
        const s0 = await snapshot(page)
        await pass(page, s, notes)
        const s1 = await snapshot(page)
        const stamp = Date.now()
        await heapSnapshot(page, `${def.id}-${s.side.name}-${stamp}-first`)
        await page.evaluate(() => window.__narrative_perf_harness!.reset())
        const t0 = Date.now()
        await pass(page, s, {})
        const wallMs = Date.now() - t0
        const s2 = await snapshot(page)
        await heapSnapshot(page, `${def.id}-${s.side.name}-${stamp}-second`)
        // The second pass's counters, before a third pass adds to them.
        const counters = await page.evaluate(() => window.__narrative_perf_harness!.counters())
        // A third, identical pass: a leak repeats with every pass, a one-off (a
        // texture or thumbnail still in flight at a snapshot) does not, so only
        // growth that both repeated passes show is counted (growthValues).
        await pass(page, s, {})
        const s3 = await snapshot(page)
        const fmt = (x: Snapshot): string =>
          `heap ${round1(x.heap / MB)} MB, textures ${x.textures} (${round1(x.textureBytes / MB)} MB), ` +
          `contexts ${x.contexts}, nodes ${x.nodes}, listeners ${x.listeners}, URLs ${x.blobUrls}`
        console.log(
          `PERF memory ${def.id} [${s.side.name}] open: ${fmt(s0)} | first: ${fmt(s1)} | second: ${fmt(s2)} | third: ${fmt(s3)}`,
        )
        s.notes = { snapshots: { open: s0, first: s1, second: s2, third: s3 }, firstPass: notes }
        return growthValues(def, [s0, s1, s2, s3], counters, wallMs)
      } finally {
        if (page !== s.page) await page.close()
      }
    }

  await runScenarios<MemoryState>({
    browser,
    ids,
    states,
    // A heap snapshot holds the page up for seconds: such a run is printed, not stored.
    sceneIsDefault: HEAP_SNAPSHOTS === '',
    runs: {
      'memory.slide.switch': session(
        async (page, s) => {
          await openDeck(page, s.slides100!.id, s.slides100!.perSlide[0]!)
          // A pointer-down in the list gives the slides panel the keys.
          await page.locator('[role="option"][data-slide-id]').first().click({ timeout: 30_000 })
          await settle(page)
        },
        async (page, s, notes) => {
          await switchPass(page, s.slides100!, async (n) => {
            // The heap halfway down (slide 50), for the shape of the series.
            if (n === 50 && chromium(page) && Object.keys(notes).length === 0) {
              const snap = await snapshot(page)
              notes['heapMB.at50'] = round1(snap.heap / MB)
              notes['textures.at50'] = snap.textures
            }
          })
        },
      ),
      'memory.zoom.cycle': session(
        async (page, s) => openDeck(page, s.crowded!.id, s.crowded!.perSlide[0]!),
        async (page) => zoomPass(page),
      ),
      'memory.deck.reopen': session(
        async (page, s) => openDeck(page, s.reopen!.id, s.reopen!.perSlide[0]!),
        async (page, s) => reopenPass(page, s.reopen!),
      ),
      'memory.present.loop': session(
        async (page, s) => {
          await openPresentation(page, s.photo!)
        },
        async (page, s) => presentPass(page, s.photo!),
      ),
    },
  })
})
