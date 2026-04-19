/**
 * tests/load/runAll.mjs
 *
 * Spouští všechny load scénáře sekvenčně.
 * Výstup: souhrnný JSON s pass/fail per scénář.
 *
 * Použití: node tests/load/runAll.mjs
 * nebo přes root: pnpm load:all
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

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

  results.push({
    scenario: scenario.name,
    pass,
    exit_code: result.status,
    result: parsed,
  })
}

const allPass = results.every((r) => r.pass)

const summary = {
  timestamp: new Date().toISOString(),
  scenarios: results.map(({ scenario, pass, exit_code }) => ({ scenario, pass, exit_code })),
  all_pass: allPass,
}

console.error('\n' + '='.repeat(60))
console.error('SUMMARY')
console.error('='.repeat(60))
for (const r of results) {
  console.error(`  ${r.scenario}: ${r.pass ? 'PASS' : 'FAIL'}`)
}
console.error(`\nOverall: ${allPass ? 'PASS' : 'FAIL'}`)

console.log('\n' + JSON.stringify(summary, null, 2))

if (!allPass) {
  process.exit(1)
}
