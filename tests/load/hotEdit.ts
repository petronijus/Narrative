/**
 * tests/load/hotEdit.ts
 *
 * Scenario 1: hot editing — 5 concurrent editors, 200 mutations each, on one
 * deck the scenario creates (and deletes afterwards).
 *
 * Thresholds (from the spike B verdict):
 *   - observer latency avg < 20 ms
 *   - convergence: every replica ends with the same content
 *
 * The objects live under a root type of the harness's own (`load:objects`),
 * never the slide model's, so the sync server is measured without the
 * scenario writing into the deck's model.
 *
 * Output: a JSON summary on stdout, a debug log on stderr.
 */

import * as Y from 'yjs'
import {
  createClient,
  seededRandom,
  sleep,
  percentile,
  maxOf,
  checkServerHealth,
  provisionDeck,
  canonicalJson,
  type YjsClient,
} from './yjsClient.js'

const SERVER_HTTP = process.env['NARRATIVE_SERVER_HTTP'] ?? 'http://localhost:3001'
const SERVER_WS = process.env['NARRATIVE_SERVER_WS'] ?? 'ws://localhost:3002'
const ROOT = 'load:objects'

const NUM_CLIENTS = 5
const NUM_OBJECTS = 50
const MUTATIONS_PER_CLIENT = 200
const INTER_MUTATION_MS = 60 // ~17 ops/s per client
const SEED = 42

// Thresholds from spike B
const THRESHOLD_LATENCY_AVG_MS = 20
const THRESHOLD_CONVERGENCE = true

type MutationOp = 'move' | 'resize' | 'fill' | 'add' | 'delete'
const OPS: MutationOp[] = ['move', 'resize', 'fill', 'add', 'delete']

function seedDocument(doc: Y.Doc): void {
  const objects = doc.getArray<Y.Map<unknown>>(ROOT)
  doc.transact(() => {
    for (let i = 0; i < NUM_OBJECTS; i++) {
      const obj = new Y.Map<unknown>()
      obj.set('id', `obj-${i}`)
      obj.set('type', 'rect')
      obj.set('x', Math.random() * 1200)
      obj.set('y', Math.random() * 700)
      obj.set('width', 80 + Math.random() * 120)
      obj.set('height', 40 + Math.random() * 80)
      obj.set('fill', '#aabbcc')
      objects.push([obj])
    }
  })
}

function mutate(doc: Y.Doc, rng: () => number, clientId: number): void {
  const objects = doc.getArray<Y.Map<unknown>>(ROOT)
  if (objects.length === 0) return

  const op = OPS[Math.floor(rng() * OPS.length)] ?? 'move'

  doc.transact(() => {
    switch (op) {
      case 'move': {
        const idx = Math.floor(rng() * objects.length)
        const obj = objects.get(idx)
        obj.set('x', rng() * 1200)
        obj.set('y', rng() * 700)
        break
      }
      case 'resize': {
        const idx = Math.floor(rng() * objects.length)
        const obj = objects.get(idx)
        obj.set('width', 40 + rng() * 200)
        obj.set('height', 40 + rng() * 200)
        break
      }
      case 'fill': {
        const idx = Math.floor(rng() * objects.length)
        const obj = objects.get(idx)
        const hex = Math.floor(rng() * 0xffffff)
          .toString(16)
          .padStart(6, '0')
        obj.set('fill', `#${hex}`)
        break
      }
      case 'add': {
        const obj = new Y.Map<unknown>()
        obj.set('id', `dyn-${clientId}-${Date.now()}-${Math.floor(rng() * 9999)}`)
        obj.set('type', 'rect')
        obj.set('x', rng() * 1200)
        obj.set('y', rng() * 700)
        obj.set('width', 60)
        obj.set('height', 60)
        obj.set('fill', '#ff0000')
        objects.push([obj])
        break
      }
      case 'delete': {
        if (objects.length > 1) {
          const idx = Math.floor(rng() * objects.length)
          objects.delete(idx, 1)
        }
        break
      }
    }
  })
}

async function run(): Promise<void> {
  process.stderr.write('[hotEdit] Pre-flight check...\n')
  await checkServerHealth(SERVER_HTTP)
  process.stderr.write('[hotEdit] Server OK\n')

  const deck = await provisionDeck(SERVER_HTTP, `load-hotedit-${Date.now()}`)
  const connected: YjsClient[] = []
  try {
    await measure(deck.docName, connected)
  } finally {
    connected.forEach((c) => c.disconnect())
    await deck.remove()
  }
}

async function measure(docName: string, connected: YjsClient[]): Promise<void> {
  // The seed client writes the starting objects.
  process.stderr.write('[hotEdit] Connecting seed client...\n')
  const seedClient = await createClient(SERVER_WS, docName)
  connected.push(seedClient)
  await seedClient.waitForSync()
  seedDocument(seedClient.doc)
  process.stderr.write(`[hotEdit] Seed document created (${NUM_OBJECTS} objects)\n`)

  // Let the seed reach the server.
  await sleep(500)

  process.stderr.write(`[hotEdit] Connecting ${NUM_CLIENTS} editor clients...\n`)
  const editorClients = await Promise.all(
    Array.from({ length: NUM_CLIENTS }, () => createClient(SERVER_WS, docName)),
  )
  connected.push(...editorClients)

  await Promise.all(editorClients.map((c) => c.waitForSync()))
  process.stderr.write(`[hotEdit] All clients synced\n`)

  const allLatencies: number[] = []
  const startTs = Date.now()

  // Every client mutates at once.
  await Promise.all(
    editorClients.map(async (client, idx) => {
      const rng = seededRandom(SEED + idx * 1000)
      for (let m = 0; m < MUTATIONS_PER_CLIENT; m++) {
        mutate(client.doc, rng, idx)
        await sleep(INTER_MUTATION_MS)
      }
    }),
  )

  // Let the last updates arrive.
  await sleep(1000)

  const durationMs = Date.now() - startTs

  // The latencies of every client.
  for (const c of editorClients) {
    for (const latency of c.stats.updateLatencies) allLatencies.push(latency)
  }

  // Convergence: every replica holds the same content.
  const contents = [...editorClients, seedClient].map((c) =>
    canonicalJson(c.doc.getArray(ROOT).toJSON()),
  )
  const allEqual = contents.every((c) => c === contents[0])

  const latencyAvg =
    allLatencies.length > 0
      ? Math.round((allLatencies.reduce((a, b) => a + b, 0) / allLatencies.length) * 100) / 100
      : 0
  const latencyP95 = Math.round(percentile(allLatencies, 0.95) * 100) / 100
  const latencyMax = Math.round(maxOf(allLatencies) * 100) / 100

  const totalMutations = NUM_CLIENTS * MUTATIONS_PER_CLIENT
  const opsPerSec = Math.round((totalMutations / durationMs) * 1000)

  const passLatency = latencyAvg < THRESHOLD_LATENCY_AVG_MS
  const passConvergence = allEqual === THRESHOLD_CONVERGENCE

  const result = {
    scenario: 'hotEdit',
    timestamp: new Date().toISOString(),
    params: { numClients: NUM_CLIENTS, mutationsPerClient: MUTATIONS_PER_CLIENT },
    duration_ms: durationMs,
    ops_per_sec: opsPerSec,
    total_mutations: totalMutations,
    latency: {
      avg_ms: latencyAvg,
      p95_ms: latencyP95,
      max_ms: latencyMax,
      samples: allLatencies.length,
    },
    convergence: allEqual,
    doc_size_bytes: Y.encodeStateAsUpdate(editorClients[0]!.doc).byteLength,
    thresholds: {
      latency_avg_lt_20ms: { pass: passLatency, value: latencyAvg, threshold: 20 },
      convergence: { pass: passConvergence, value: allEqual },
    },
    pass: passLatency && passConvergence,
  }

  process.stdout.write(JSON.stringify(result, null, 2) + '\n')

  if (!result.pass) {
    process.stderr.write('[hotEdit] FAIL — thresholds not met\n')
    process.exitCode = 1
  } else {
    process.stderr.write('[hotEdit] PASS\n')
  }
}

await run()
