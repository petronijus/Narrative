/**
 * tests/load/runAll.mjs
 *
 * Spouští všechny load scénáře sekvenčně.
 * Výstup: souhrnný JSON s pass/fail per scénář.
 *
 * Použití: node tests/load/runAll.mjs
 * nebo přes root: pnpm load:all
 *
 * Baseline regression tracking
 *   If `tests/load/baselines.json` exists, each scenario's headline metrics
 *   are compared against the committed baseline. Drift > 20% (or per-metric
 *   override) emits a non-fatal warning so you can see slow regressions
 *   that don't yet trip the absolute thresholds. Threshold breaches still
 *   fail the run as before.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// Baseline regression check
// ---------------------------------------------------------------------------

const BASELINE_PATH = path.join(__dirname, 'baselines.json')
const DEFAULT_TOLERANCE = 0.2 // ±20% drift before warning

/**
 * Returns the committed baseline metrics, or null if baselines.json
 * hasn't been initialised yet (use tests/load/baselines.example.json
 * as the template).
 */
function loadBaselines() {
  if (!existsSync(BASELINE_PATH)) return null
  try {
    const json = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
    return json.scenarios ?? null
  } catch {
    console.error('[runAll] baselines.json present but unparseable — skipping regression check')
    return null
  }
}

/**
 * Walk a scenario's result + its baseline and emit drift warnings to stderr.
 * Returns the array of detected drifts so the caller can include them in
 * the JSON summary.
 */
function checkRegressions(scenario, parsed, baselineForScenario) {
  const drifts = []
  if (parsed === null || baselineForScenario === undefined) return drifts
  // Walk well-known headline metrics — keep this list short. Anything
  // not listed here is not a regression-tracked metric (yet).
  const candidates = [
    ['latency_avg_ms', parsed.latency?.avg_ms],
    ['latency_p95_ms', parsed.latency?.p95_ms],
    ['ops_per_sec', parsed.ops_per_sec],
    ['doc_size_bytes_after_run', parsed.doc_size_bytes],
    ['events_per_sec', parsed.events_per_sec],
    ['initial_sync_ms', parsed.initial_sync_ms ?? parsed.avg_sync_ms],
    ['doc_size_bytes', parsed.doc_size_bytes],
  ]
  for (const [key, current] of candidates) {
    const baseline = baselineForScenario[key]
    if (baseline === undefined || typeof current !== 'number') continue
    const drift = (current - baseline) / baseline
    const tolerance = baselineForScenario._toleranceFactor ?? DEFAULT_TOLERANCE
    // Only warn on the "bad" direction: latency / size higher than baseline,
    // throughput lower than baseline. Keep the heuristic dumb but obvious.
    const isWorse =
      key.includes('latency') || key.includes('size') || key.includes('sync')
        ? drift > tolerance
        : drift < -tolerance
    if (isWorse) {
      const pct = (drift * 100).toFixed(1)
      console.error(
        `[runAll] REGRESSION ${scenario}/${key}: ${current} vs baseline ${baseline} (${pct}%)`,
      )
      drifts.push({ key, current, baseline, drift_pct: Number(pct) })
    }
  }
  return drifts
}

const baselines = loadBaselines()

const scenarios = [
  { name: 'hotEdit', file: 'hotEdit.ts' },
  { name: 'awarenessFlood', file: 'awarenessFlood.ts' },
  { name: 'docGrowth', file: 'docGrowth.ts' },
]

const results = []

for (const scenario of scenarios) {
  console.error(`\n${'='.repeat(60)}`)
  console.error(`Running: ${scenario.name}`)
  console.error('='.repeat(60))

  const result = spawnSync(
    'node',
    ['--loader', 'ts-node/esm', path.join(__dirname, scenario.file)],
    {
      stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env },
      cwd: __dirname,
    },
  )

  let parsed = null
  let pass = false

  if (result.stdout) {
    const stdout = result.stdout.toString().trim()
    if (stdout) {
      try {
        parsed = JSON.parse(stdout)
        pass = parsed.pass === true
        console.log(stdout) // Re-emit JSON to stdout
      } catch {
        console.error(`[runAll] Could not parse JSON output from ${scenario.name}`)
      }
    }
  }

  if (result.status !== 0 && !pass) {
    pass = false
  }

  const regressions =
    baselines !== null ? checkRegressions(scenario.name, parsed, baselines[scenario.name]) : []

  results.push({
    scenario: scenario.name,
    pass,
    exit_code: result.status,
    result: parsed,
    regressions,
  })
}

const allPass = results.every((r) => r.pass)
const totalRegressions = results.reduce((acc, r) => acc + (r.regressions?.length ?? 0), 0)

const summary = {
  timestamp: new Date().toISOString(),
  scenarios: results.map(({ scenario, pass, exit_code, regressions }) => ({
    scenario,
    pass,
    exit_code,
    regressions_count: regressions?.length ?? 0,
  })),
  all_pass: allPass,
  total_regressions: totalRegressions,
  baselines_loaded: baselines !== null,
}

console.error('\n' + '='.repeat(60))
console.error('SUMMARY')
console.error('='.repeat(60))
for (const r of results) {
  const regressionTag = r.regressions?.length
    ? ` (${r.regressions.length} regression${r.regressions.length === 1 ? '' : 's'})`
    : ''
  console.error(`  ${r.scenario}: ${r.pass ? 'PASS' : 'FAIL'}${regressionTag}`)
}
console.error(`\nOverall: ${allPass ? 'PASS' : 'FAIL'}`)
if (baselines === null) {
  console.error('(baselines.json not found — copy baselines.example.json after a clean run)')
}

console.log('\n' + JSON.stringify(summary, null, 2))

if (!allPass) {
  process.exit(1)
}
