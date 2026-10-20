/**
 * cli/checks.ts — the inputs of the coverage guard and the budget check,
 * shared by their tests (in `just check`) and `just perf-counters`.
 *
 * The user actions come from the web app's catalog by path: it is a plain
 * data module, and an app is not a workspace dependency of a package.
 * tools/dev/check-affected.sh runs this package's tests when it changes.
 */

import { createDefaultRegistry } from '@narrative/commands'
import { USER_ACTIONS } from '../../../../apps/web/src/actions/catalog.js'
import { ALL_BENCHES } from '../benches.js'
import {
  BUDGET_MODE,
  budgetProblems,
  diffCounters,
  type CounterBudget,
  type CounterDiff,
} from '../budgets.js'
import {
  ACTION_EXEMPTIONS,
  COMMAND_EXEMPTIONS,
  coverageReport,
  type CoverageInput,
  type CoverageReport,
} from '../coverage.js'
import { createBenchRegistry, type BenchRegistry } from '../defineBench.js'
import { readBudgets } from '../node/budgetFiles.js'
import type { ResultStore } from '../node/store.js'

export function benchRegistry(): BenchRegistry {
  return createBenchRegistry(ALL_BENCHES)
}

export function coverageInput(registry = benchRegistry()): CoverageInput {
  return {
    actions: Object.keys(USER_ACTIONS),
    commands: createDefaultRegistry()
      .list()
      .map((c) => c.id),
    benches: registry.list(),
    actionExemptions: ACTION_EXEMPTIONS,
    commandExemptions: COMMAND_EXEMPTIONS,
  }
}

export function repoCoverage(registry = benchRegistry()): CoverageReport {
  return coverageReport(coverageInput(registry))
}

export interface BudgetStatus {
  problems: string[]
  /** Per budgeted bench: its diff against this machine's latest counters, or null when never measured here. */
  diffs: Array<{ id: string; diff: CounterDiff | null }>
}

export function budgetStatus(
  registry = benchRegistry(),
  budgets: readonly CounterBudget[] = readBudgets(),
  store?: ResultStore,
): BudgetStatus {
  return {
    problems: budgetProblems(registry.list(), budgets),
    diffs: budgets.map((b) => {
      const counters = store?.latest(b.id, { mode: BUDGET_MODE })?.counters
      return { id: b.id, diff: counters === undefined ? null : diffCounters(b.counters, counters) }
    }),
  }
}
