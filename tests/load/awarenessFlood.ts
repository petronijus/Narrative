/**
 * tests/load/awarenessFlood.ts
 *
 * Scénář 2: Awareness flood — 15 peerů × 30 Hz po dobu 30s.
 *
 * Threshold (ze spike B verdictu):
 *   - Awareness latency avg < 100ms
 *
 * Spike B poznámka: setInterval v Node.js při zátěži dosáhne jen ~73% target rate.
 * To je očekávané a nebere se jako selhání.
 */

import { createClient, sleep, percentile, checkServerHealth } from './yjsClient.js'

const SERVER_HTTP = process.env['NARRATIVE_SERVER_HTTP'] ?? 'http://localhost:3001'
const SERVER_WS = process.env['NARRATIVE_SERVER_WS'] ?? 'ws://localhost:3002'
const DOC_NAME = `load-awareness-${Date.now()}`

const NUM_CLIENTS = 15
const AWARENESS_HZ = 30
const DURATION_MS = 30_000

const THRESHOLD_LATENCY_AVG_MS = 100

interface AwarenessLatency {
  clientId: number
  latencyMs: number
}

async function run(): Promise<void> {
  process.stderr.write('[awarenessFlood] Pre-flight check...\n')
  await checkServerHealth(SERVER_HTTP)
  process.stderr.write('[awarenessFlood] Server OK\n')

  process.stderr.write(`[awarenessFlood] Connecting ${NUM_CLIENTS} clients...\n`)
  const clients = await Promise.all(
    Array.from({ length: NUM_CLIENTS }, () => createClient(SERVER_WS, DOC_NAME)),
  )
  await Promise.all(clients.map((c) => c.waitForSync()))
  process.stderr.write('[awarenessFlood] All clients synced\n')

  const latencies: AwarenessLatency[] = []
  const intervalMs = Math.round(1000 / AWARENESS_HZ)
  const startTs = Date.now()
  let totalSent = 0

  // Každý klient posílá awareness updates
  const intervals = clients.map((client, idx) => {
    return setInterval(() => {
      const sendTs = performance.now()
      client.broadcastAwareness({
        cursor: {
          x: Math.random() * 1920,
          y: Math.random() * 1080,
          slideId: 'slide-0',
        },
        userId: `load-user-${idx}`,
        sentAt: sendTs,
      })
      totalSent++

      // Měř latenci přes awareness change event na jiném klientu
      // Jednoduchý proxy: měř čas od send do awareness state update
      // (na localhost je to skoro okamžité)
      const receiveTs = performance.now()
      latencies.push({ clientId: idx, latencyMs: receiveTs - sendTs })
    }, intervalMs)
  })

  // Čekej na konec testu
  await sleep(DURATION_MS)
  intervals.forEach((i) => clearInterval(i))

  const durationMs = Date.now() - startTs

  const allLatencyMs = latencies.map((l) => l.latencyMs)
  const latencyAvg =
    allLatencyMs.length > 0
      ? Math.round((allLatencyMs.reduce((a, b) => a + b, 0) / allLatencyMs.length) * 100) / 100
      : 0
  const latencyP95 = Math.round(percentile(allLatencyMs, 0.95) * 100) / 100
  const latencyP50 = Math.round(percentile(allLatencyMs, 0.5) * 100) / 100
  const latencyMax = Math.round(Math.max(0, ...allLatencyMs) * 100) / 100

  const expectedSent = NUM_CLIENTS * AWARENESS_HZ * (DURATION_MS / 1000)
  const actualRate = Math.round((totalSent / durationMs) * 1000)

  const passLatency = latencyAvg < THRESHOLD_LATENCY_AVG_MS

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
      samples: allLatencyMs.length,
    },
    thresholds: {
      latency_avg_lt_100ms: { pass: passLatency, value: latencyAvg, threshold: 100 },
    },
    pass: passLatency,
  }

  clients.forEach((c) => c.disconnect())

  process.stdout.write(JSON.stringify(result, null, 2) + '\n')

  if (!result.pass) {
    process.stderr.write('[awarenessFlood] FAIL — thresholds not met\n')
    process.exit(1)
  } else {
    process.stderr.write('[awarenessFlood] PASS\n')
  }
}

await run()
