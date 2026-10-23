/**
 * cli/main.ts — the harness's command line, behind the justfile recipes:
 *
 *   counters          `just perf-counters`: the coverage guard, the budget files
 *                     against the benches, and each budget against this
 *                     machine's latest measured counters
 *   run, compare, bisect, profile
 *                     `just perf`, `just perf-compare`, `just perf-bisect`,
 *                     `just perf-profile` (cli/run.ts)
 *   accept <id…>      `just perf-accept`: the latest result of each bench on this
 *                     machine becomes its counter budget (work metrics, committed)
 *                     and its baseline (time metrics, ~/.cache)
 *
 * Exit code 1 on anything to fix. Output is `PERF …` lines (report.ts).
 */

import { BUDGET_MODE, budgetResult, diffCounters, formatCounterDiff } from '../budgets.js'
import { coverageOk, NOT_YET_BENCHED } from '../coverage.js'
import { readBudget, writeBudget } from '../node/budgetFiles.js'
import { machineName } from '../node/fingerprint.js'
import { baselineKey, openResultStore } from '../node/store.js'
import { formatBudgetCheck, table } from '../report.js'
import { benchRegistry, budgetStatus, coverageInput, repoCoverage } from './checks.js'
import { lighthouse } from './lighthouse.js'
import { parseArgs, RUN_COMMANDS } from './run.js'

function counters(): number {
  const registry = benchRegistry()
  const input = coverageInput(registry)
  const report = repoCoverage(registry)
  const store = openResultStore({ machine: machineName() })
  let failed = false

  const count = (
    ids: readonly string[],
    benched: Record<string, string[]>,
    exempt: Readonly<Record<string, string>>,
  ) => {
    const notYet = ids.filter(
      (id) => benched[id] === undefined && exempt[id] === NOT_YET_BENCHED,
    ).length
    const other = ids.filter(
      (id) =>
        benched[id] === undefined && exempt[id] !== undefined && exempt[id] !== NOT_YET_BENCHED,
    ).length
    return [
      `${ids.length}`,
      `${Object.keys(benched).length} benched`,
      `${notYet} not yet benched`,
      `${other} exempt with a reason`,
    ]
  }
  for (const line of table([
    [
      'coverage',
      'actions',
      ...count(input.actions, report.benchedBy.actions, input.actionExemptions),
    ],
    [
      'coverage',
      'commands',
      ...count(input.commands, report.benchedBy.commands, input.commandExemptions),
    ],
  ]))
    console.log(line)
  if (!coverageOk(report)) {
    failed = true
    const sections: Array<[string, string[]]> = [
      ['neither benched nor exempted (packages/perf/src/coverage.ts)', report.uncovered],
      ['exempted but gone', report.staleExemptions],
      ['exempted but benched (delete the exemption)', report.redundantExemptions],
      ['benches naming what does not exist', report.unknownTargets],
      ['reasons that do not say why', report.weakReasons],
    ]
    for (const [title, items] of sections)
      if (items.length > 0)
        console.log(`PERF coverage ${title}:\n${items.map((i) => `  ${i}`).join('\n')}`)
  }

  const status = budgetStatus(registry, undefined, store)
  for (const p of status.problems) console.log(`PERF budget ${p}`)
  if (status.problems.length > 0) failed = true
  for (const { id, diff } of status.diffs) {
    if (diff === null) console.log(`PERF budget ${id}: not measured on ${store.machine} yet`)
    else {
      for (const line of formatBudgetCheck(id, diff)) console.log(line)
      if (!diff.ok) failed = true
    }
  }
  if (status.diffs.length === 0) console.log(`PERF budget none committed yet (perf/budgets/)`)
  return failed ? 1 : 0
}

function accept(ids: readonly string[]): number {
  if (ids.length === 0) {
    console.error('perf-accept: name the benches (just perf-accept <id…>)')
    return 1
  }
  const registry = benchRegistry()
  const store = openResultStore({ machine: machineName() })
  let failed = false
  for (const id of ids) {
    const bench = registry.get(id)
    if (bench === undefined) {
      console.error(`perf-accept: no bench ${id}`)
      failed = true
      continue
    }
    const series = store.latestPerSeries(id)
    if (series.length === 0) {
      console.error(`perf-accept: no result of ${id} recorded on ${store.machine} (${store.dir})`)
      failed = true
      continue
    }
    // The budget: the latest counters measured in the budget mode (dev), in a
    // runtime that counts every work metric exactly (a display-paced run
    // times the bench's perFrame counts: its snapshot would drop them).
    const forBudget = budgetResult(bench.metrics, store.results({ benchId: id }))
    if (Object.values(bench.metrics).some((m) => m.kind === 'work')) {
      if (forBudget?.counters === undefined) {
        console.error(
          `perf-accept: ${id} has no ${BUDGET_MODE} result to take its budget from (just perf ${id} --mode ${BUDGET_MODE}${
            Object.values(bench.metrics).some((m) => m.perFrame === true)
              ? ' in headless Chromium'
              : ''
          })`,
        )
        failed = true
      } else {
        const before = readBudget(id)?.counters ?? {}
        const diff = diffCounters(before, forBudget.counters)
        const file = writeBudget(id, forBudget.counters)
        console.log(`PERF accept ${id}: budget ${diff.ok ? 'unchanged' : 'rewritten'} (${file})`)
        for (const line of formatCounterDiff(diff)) console.log(`  ${line}`)
      }
    }
    // The baselines: the latest result of every series (mode × browser) measured here.
    if (Object.values(bench.metrics).some((m) => m.kind === 'time')) {
      for (const result of series) {
        const previous = store.accept(result)
        console.log(
          `PERF accept ${id}: baseline ${baselineKey(id, result.fingerprint)} ${previous === undefined ? 'set' : `replaced (was ${previous.result.at})`}`,
        )
      }
    }
  }
  return failed ? 1 : 0
}

const [command, ...args] = process.argv.slice(2)
const commands: Record<string, () => number | Promise<number>> = {
  counters,
  accept: () => accept(args),
  lighthouse: () => lighthouse(args),
  ...Object.fromEntries(
    Object.entries(RUN_COMMANDS).map(([name, fn]) => [name, () => fn(parseArgs(args))]),
  ),
}
const run = command === undefined ? undefined : commands[command]
if (run === undefined) {
  console.error(`usage: perf <${Object.keys(commands).join('|')}> [args]`)
  process.exitCode = 1
} else {
  Promise.resolve()
    .then(run)
    .then(
      (code) => (process.exitCode = code),
      (err: unknown) => {
        console.error(`perf ${command}: ${err instanceof Error ? err.message : String(err)}`)
        process.exitCode = 1
      },
    )
}
