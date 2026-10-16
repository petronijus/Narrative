/**
 * tests/load/awarenessFlood.ts
 *
 * Scenario 2: awareness flood — 15 peers at 30 Hz for 30 s, on one deck the
 * scenario creates (and deletes afterwards).
 *
 * Threshold (from the spike B verdict):
 *   - awareness latency avg < 100 ms
 *
 * Latency is delivery latency: each state carries the `performance.now()` of
 * its sending, and every OTHER client records how long it took to arrive
 * (all clients run in this process, so they share the clock). A peer's own
 * state never counts.
 *
 * Spike B note: under load, setInterval in Node.js reaches only ~73% of the
 * target rate. That is expected and not a failure.
 */

import {
  createClient,
  sleep,
  percentile,
  maxOf,
  checkServerHealth,
  provisionDeck,
  type YjsClient,
} from './yjsClient.js'

const SERVER_HTTP = process.env['NARRATIVE_SERVER_HTTP'] ?? 'http://localhost:3001'
const SERVER_WS = process.env['NARRATIVE_SERVER_WS'] ?? 'ws://localhost:3002'

const NUM_CLIENTS = 15
const AWARENESS_HZ = 30
const DURATION_MS = 30_000
/** After the last send: time for the states still in flight to arrive. */
const DRAIN_MS = 1_000

const THRESHOLD_LATENCY_AVG_MS = 100

async function run(): Promise<void> {
  process.stderr.write('[awarenessFlood] Pre-flight check...\n')
  await checkServerHealth(SERVER_HTTP)
  process.stderr.write('[awarenessFlood] Server OK\n')

  const deck = await provisionDeck(SERVER_HTTP, `load-awareness-${Date.now()}`)
  const connected: YjsClient[] = []
  try {
    await measure(deck.docName, connected)
  } finally {
    connected.forEach((c) => c.disconnect())
    await deck.remove()
  }
}

async function measure(docName: string, connected: YjsClient[]): Promise<void> {
  process.stderr.write(`[awarenessFlood] Connecting ${NUM_CLIENTS} clients...\n`)
  const clients = await Promise.all(
    Array.from({ length: NUM_CLIENTS }, () => createClient(SERVER_WS, docName)),
  )
  connected.push(...clients)
  await Promise.all(clients.map((c) => c.waitForSync()))
  process.stderr.write('[awarenessFlood] All clients synced\n')

  // Delivery latencies, recorded by the receiving clients.
  const latencies: number[] = []
  for (const client of clients) {
    client.awareness.on(
      'change',
      ({ added, updated }: { added: number[]; updated: number[] }, origin: unknown) => {
        if (origin !== 'server') return
        const now = performance.now()
        for (const id of [...added, ...updated]) {
          if (id === client.doc.clientID) continue
          const sentAt = client.awareness.getStates().get(id)?.['sentAt']
          if (typeof sentAt === 'number') latencies.push(now - sentAt)
        }
      },
    )
  }

  const intervalMs = Math.round(1000 / AWARENESS_HZ)
  const startTs = Date.now()
  let totalSent = 0

  const intervals = clients.map((client, idx) =>
    setInterval(() => {
      client.broadcastAwareness({
        cursor: {
          x: Math.random() * 1920,
          y: Math.random() * 1080,
          slideId: 'slide-0',
        },
        userId: `load-user-${idx}`,
        sentAt: performance.now(),
      })
      totalSent++
    }, intervalMs),
  )

  await sleep(DURATION_MS)
  intervals.forEach((i) => clearInterval(i))
  const durationMs = Date.now() - startTs
  await sleep(DRAIN_MS)

  const latencyAvg =
    latencies.length > 0
      ? Math.round((latencies.reduce((a, b) => a + b, 0) / latencies.length) * 100) / 100
      : 0
  const latencyP95 = Math.round(percentile(latencies, 0.95) * 100) / 100
  const latencyP50 = Math.round(percentile(latencies, 0.5) * 100) / 100
  const latencyMax = Math.round(maxOf(latencies) * 100) / 100

  const expectedSent = NUM_CLIENTS * AWARENESS_HZ * (DURATION_MS / 1000)
  const actualRate = Math.round((totalSent / durationMs) * 1000)

  // No delivery at all is a failure, not a latency of 0.
  const passLatency = latencies.length > 0 && latencyAvg < THRESHOLD_LATENCY_AVG_MS

  const result = {
    scenario: 'awarenessFlood',
    timestamp: new Date().toISOString(),
    params: {
      numClients: NUM_CLIENTS,
      targetHz: AWARENESS_HZ,
      durationSec: DURATION_MS / 1000,
    },
    duration_ms: durationMs,
    awareness_sent: totalSent,
    awareness_expected: expectedSent,
    rate_per_sec: actualRate,
    latency: {
      avg_ms: latencyAvg,
      p50_ms: latencyP50,
      p95_ms: latencyP95,
      max_ms: latencyMax,
      samples: latencies.length,
    },
    thresholds: {
      latency_avg_lt_100ms: { pass: passLatency, value: latencyAvg, threshold: 100 },
    },
    pass: passLatency,
  }

  process.stdout.write(JSON.stringify(result, null, 2) + '\n')

  if (!result.pass) {
    process.stderr.write('[awarenessFlood] FAIL — thresholds not met\n')
    process.exitCode = 1
  } else {
    process.stderr.write('[awarenessFlood] PASS\n')
  }
}

await run()
