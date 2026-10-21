/**
 * tests/load/deckScale.ts
 *
 * Scenario 4 (docs/plans/performance.md → G8): real slide-model decks of 100
 * and 300 slides on the sync server. Unlike docGrowth, the deck is built with
 * the slide model's own writers (`addSlide`, `addObjects`, `updateObject`) in
 * its own layout (`slides`), the way the editor and the commands write it:
 * 12 objects a slide — six texts (a title and five bodies, rich text), four
 * rectangles, two ellipses — like the perf benches' decks.
 *
 * For each size, on a deck the scenario creates (and deletes afterwards):
 *   - the encoded size of the document;
 *   - the initial sync of 5 fresh clients (connect → synced), and the bytes
 *     each received;
 *   - an edit round on the full deck: 3 editors each move objects of the
 *     first slide 100 times (one `updateObject` transaction each, 30 ms
 *     apart); every other editor records how long each edit took to arrive
 *     (sent → applied, one process, one clock) — what the sync server's
 *     per-update work costs on a large document;
 *   - convergence: every replica's `listSlides()` is the same (structural,
 *     never encoded bytes).
 *
 * Thresholds: initial sync avg < 3000 ms and edit latency avg < 50 ms at
 * every size; every replica converges.
 */

import * as Y from 'yjs'
import {
  PARAGRAPH_SEP,
  addObjects,
  addSlide,
  getSlideObjectsCtx,
  listSlides,
  updateObject,
  type SlideMutationContext,
} from '@narrative/slide-model'
import type { EllipseObject, RectangleObject, TextObject } from '@narrative/shared'
import {
  canonicalJson,
  checkServerHealth,
  createClient,
  maxOf,
  percentile,
  provisionDeck,
  sleep,
  type YjsClient,
} from './yjsClient.js'

const SERVER_HTTP = process.env['NARRATIVE_SERVER_HTTP'] ?? 'http://localhost:3001'
const SERVER_WS = process.env['NARRATIVE_SERVER_WS'] ?? 'ws://localhost:3002'

const SIZES = (process.env['DECK_SCALE_SIZES'] ?? '100,300')
  .split(',')
  .map((s) => Number.parseInt(s, 10))
  .filter((n) => Number.isFinite(n) && n > 0)
const NUM_SYNC_CLIENTS = 5
const NUM_EDITORS = 3
const EDITS_PER_EDITOR = 100
const INTER_EDIT_MS = 30
/** Where an edit's send time travels with it (a root type of the harness's own). */
const CLOCK = 'load:clock'

const THRESHOLD_SYNC_MS = 3000
const THRESHOLD_EDIT_LATENCY_MS = 50

const deckCtx = (doc: Y.Doc): SlideMutationContext => ({
  doc,
  slides: doc.getArray('slides') as SlideMutationContext['slides'],
})

/** Write `slides` slides into `doc` through the slide model, one transaction. */
function buildDeck(doc: Y.Doc, slides: number): void {
  const deck = deckCtx(doc)
  doc.transact(() => {
    for (let n = 0; n < slides; n++) {
      const slideId = addSlide(deck).id
      const objects = getSlideObjectsCtx(deck, slideId)
      if (objects === null) throw new Error(`slide ${slideId} has no objects context`)
      const base = { rotation: 0, opacity: 1 }
      const text = (i: number): TextObject => ({
        ...base,
        id: `s${n}-t${i}`,
        type: 'text',
        x: 80,
        y: 60 + i * 100,
        width: 900,
        height: i === 0 ? 96 : 88,
        text:
          i === 0
            ? `Slide ${n + 1}: quarterly review of the programme`
            : [
                `Revenue grew in region ${i} while costs held flat.`,
                'The margin improved by three points; next year keeps the same mix.',
              ].join(PARAGRAPH_SEP),
        fontSize: i === 0 ? 48 : 24,
        fontWeight: i === 0 ? 'bold' : 'normal',
        color: 0x111111,
        align: 'left',
      })
      const rect = (i: number): RectangleObject => ({
        ...base,
        id: `s${n}-r${i}`,
        type: 'rectangle',
        x: 80 + i * 440,
        y: 760,
        width: 380,
        height: 160,
        fill: 0x335577,
      })
      const ellipse = (i: number): EllipseObject => ({
        ...base,
        id: `s${n}-e${i}`,
        type: 'ellipse',
        x: 1100 + i * 380,
        y: 160,
        width: 340,
        height: 240,
        fill: 0x775533,
      })
      addObjects(objects, [
        ...[0, 1, 2, 3, 4, 5].map(text),
        ...[0, 1, 2, 3].map(rect),
        ...[0, 1].map(ellipse),
      ])
    }
  })
}

/**
 * A replica's slides as plain data: `listSlides()` hands rich text back as
 * live Yjs types, which are projected to their JSON.
 */
function slidesOf(doc: Y.Doc): string {
  const plain = (v: unknown): unknown => {
    if (v instanceof Y.AbstractType) return v.toJSON()
    if (Array.isArray(v)) return v.map(plain)
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]))
    }
    return v
  }
  return canonicalJson(plain(listSlides(deckCtx(doc))))
}

/** Resolves once `client`'s document holds `slides` slides (the seed arrived). */
async function waitForSlides(client: YjsClient, slides: number, timeoutMs = 60_000): Promise<void> {
  const end = performance.now() + timeoutMs
  while (deckCtx(client.doc).slides.length < slides) {
    if (performance.now() > end) throw new Error(`the deck never reached ${slides} slides`)
    await sleep(50)
  }
}

interface SizeResult {
  slides: number
  objects: number
  encoded_size_bytes: number
  build_ms: number
  sync: { avg_ms: number; max_ms: number; avg_bytes_received: number }
  edits: { sent: number; delivered: number; avg_ms: number; p95_ms: number; max_ms: number }
  convergence: boolean
  pass: boolean
}

async function measureSize(slides: number): Promise<SizeResult> {
  const deck = await provisionDeck(SERVER_HTTP, `load-deck-scale-${slides}-${Date.now()}`)
  const connected: YjsClient[] = []
  try {
    // Seed: one client writes the whole deck.
    const seed = await createClient(SERVER_WS, deck.docName)
    connected.push(seed)
    await seed.waitForSync()
    const before = deckCtx(seed.doc).slides.length
    const buildStart = performance.now()
    buildDeck(seed.doc, slides)
    const buildMs = Math.round(performance.now() - buildStart)
    const total = before + slides
    const encoded = Y.encodeStateAsUpdate(seed.doc).byteLength
    process.stderr.write(
      `[deckScale] ${slides} slides built in ${buildMs} ms, ${Math.round(encoded / 1024)} kB\n`,
    )
    // The seed reached the server once a fresh client sees all of it.
    const probe = await createClient(SERVER_WS, deck.docName)
    connected.push(probe)
    await probe.waitForSync()
    await waitForSlides(probe, total)

    // Initial sync of fresh clients.
    const syncs = await Promise.all(
      Array.from({ length: NUM_SYNC_CLIENTS }, async () => {
        const start = performance.now()
        const client = await createClient(SERVER_WS, deck.docName)
        connected.push(client)
        await client.waitForSync()
        return { client, ms: performance.now() - start }
      }),
    )
    const syncTimes = syncs.map((s) => s.ms)
    const syncBytes = syncs.map((s) => s.client.stats.bytesReceived)

    // The edit round: editors move the first slide's objects.
    const editors = syncs.slice(0, NUM_EDITORS).map((s) => s.client)
    const latencies: number[] = []
    for (const editor of editors) {
      editor.doc.getMap<number>(CLOCK).observe((event, tr) => {
        if (tr.local) return
        const now = performance.now()
        for (const key of event.keysChanged) {
          const sent = editor.doc.getMap<number>(CLOCK).get(key)
          if (typeof sent === 'number') latencies.push(now - sent)
        }
      })
    }
    const firstSlide = listSlides(deckCtx(editors[0]!.doc))[0]!
    const ids = firstSlide.objects.map((o) => o.id)
    let sent = 0
    await Promise.all(
      editors.map(async (editor, e) => {
        const objects = getSlideObjectsCtx(deckCtx(editor.doc), firstSlide.id)!
        for (let i = 0; i < EDITS_PER_EDITOR; i++) {
          const id = ids[(e * 7 + i) % ids.length]!
          editor.doc.transact(() => {
            updateObject(objects, id, { x: 80 + ((i * 37 + e * 11) % 900) })
            editor.doc.getMap<number>(CLOCK).set(`${editor.id}:${i}`, performance.now())
          }, 'load-edit')
          sent++
          await sleep(INTER_EDIT_MS)
        }
      }),
    )
    // Let the last edits arrive.
    const expected = sent * (NUM_EDITORS - 1)
    const settleEnd = performance.now() + 10_000
    while (latencies.length < expected && performance.now() < settleEnd) await sleep(50)
    await sleep(500)

    const reference = slidesOf(probe.doc)
    const replicas = [seed, ...syncs.map((s) => s.client)]
    const convergence = replicas.every((c) => slidesOf(c.doc) === reference)

    const avg = (xs: number[]): number =>
      xs.length === 0 ? 0 : Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100
    const result: SizeResult = {
      slides: total,
      objects: total * 12,
      encoded_size_bytes: encoded,
      build_ms: buildMs,
      sync: {
        avg_ms: avg(syncTimes),
        max_ms: Math.round(maxOf(syncTimes) * 10) / 10,
        avg_bytes_received: Math.round(avg(syncBytes)),
      },
      edits: {
        sent,
        delivered: latencies.length,
        avg_ms: avg(latencies),
        p95_ms: Math.round(percentile(latencies, 0.95) * 100) / 100,
        max_ms: Math.round(maxOf(latencies) * 100) / 100,
      },
      convergence,
      pass: false,
    }
    result.pass =
      convergence &&
      result.sync.avg_ms < THRESHOLD_SYNC_MS &&
      result.edits.delivered === expected &&
      result.edits.avg_ms < THRESHOLD_EDIT_LATENCY_MS
    return result
  } finally {
    connected.forEach((c) => c.disconnect())
    await deck.remove()
  }
}

async function run(): Promise<void> {
  await checkServerHealth(SERVER_HTTP)
  const sizes: SizeResult[] = []
  for (const n of SIZES) sizes.push(await measureSize(n))
  const at = (n: number): SizeResult | undefined => sizes.find((s) => s.slides >= n)
  const largest = sizes.at(-1)
  const result = {
    scenario: 'deckScale',
    timestamp: new Date().toISOString(),
    params: {
      sizes: SIZES,
      objectsPerSlide: 12,
      numSyncClients: NUM_SYNC_CLIENTS,
      numEditors: NUM_EDITORS,
      editsPerEditor: EDITS_PER_EDITOR,
    },
    sizes,
    // Headline metrics for runAll's baseline check (the largest deck).
    sync_largest_avg_ms: largest?.sync.avg_ms,
    edit_latency_largest_avg_ms: largest?.edits.avg_ms,
    doc_size_largest_bytes: largest?.encoded_size_bytes,
    sync_100_avg_ms: at(100)?.sync.avg_ms,
    thresholds: {
      initial_sync_lt_3000ms: sizes.every((s) => s.sync.avg_ms < THRESHOLD_SYNC_MS),
      edit_latency_lt_50ms: sizes.every((s) => s.edits.avg_ms < THRESHOLD_EDIT_LATENCY_MS),
    },
    pass: sizes.length > 0 && sizes.every((s) => s.pass),
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  if (!result.pass) {
    process.stderr.write('[deckScale] FAIL — thresholds not met\n')
    process.exitCode = 1
  } else {
    process.stderr.write('[deckScale] PASS\n')
  }
}

await run()
