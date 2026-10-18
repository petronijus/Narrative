/**
 * node/budgetFiles.ts — the committed counter budgets, `perf/budgets/<id>.json`
 * at the repo root (budgets.ts has the format and the diff). Git keeps their
 * history: `just perf-accept` rewrites a file in place and the diff is the
 * review.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseBudget, serializeBudget, type CounterBudget } from '../budgets.js'

/** The repo root: the nearest directory up from `from` holding pnpm-workspace.yaml. */
export function repoRoot(from = process.cwd()): string {
  let dir = path.resolve(from)
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) throw new Error(`no pnpm-workspace.yaml above ${from}`)
    dir = parent
  }
}

export function budgetsDir(root = repoRoot()): string {
  return path.join(root, 'perf', 'budgets')
}

/** Every budget file, parsed and validated (a malformed one throws, naming the file). */
export function readBudgets(dir = budgetsDir()): CounterBudget[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => parseBudget(readFileSync(path.join(dir, f), 'utf8'), f.slice(0, -'.json'.length)))
}

export function readBudget(id: string, dir = budgetsDir()): CounterBudget | undefined {
  const file = path.join(dir, `${id}.json`)
  return existsSync(file) ? parseBudget(readFileSync(file, 'utf8'), id) : undefined
}

/** Write (or rewrite) a budget; returns the file's path. */
export function writeBudget(
  id: string,
  counters: Readonly<Record<string, number>>,
  dir = budgetsDir(),
): string {
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${id}.json`)
  writeFileSync(file, serializeBudget(id, counters))
  return file
}
