#!/usr/bin/env node
// Run one package.json script in a set of workspace packages, at most N at a
// time — what `pnpm -r --no-sort --workspace-concurrency=N <script>` did, which
// Bun has no equivalent for (`bun run --filter` orders by dependencies,
// `--parallel` starts every package at once). The justfile's typecheck, lint
// and test recipes and tools/dev/check-affected.sh go through it.
//
//   workspace-run.mjs [--concurrency N] <script> [selector...]
//   workspace-run.mjs --count <script> [selector...]   how many would run (≤ N)
//
// Selectors (the ones the recipes took when pnpm ran them):
//   web, @narrative/web        a package by its name, the @narrative/ scope optional
//   ./apps/web, {./apps/web}   the package in that directory
//   ...{./apps/web}            that package and every package that depends on it,
//                              transitively (dependencies and devDependencies)
// No selector: every workspace package. Packages without the script are
// skipped; an unknown selector is an error, as it was for pnpm.
//
// Each line of a package's output is prefixed with its name; the exit code is
// 1 when any package failed (the others still finish, so one run shows every
// failure), and a line per package says how it ended.
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
const rootPkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))

// The workspace globs are `<dir>/*` only (package.json `workspaces`).
const packages = []
for (const glob of rootPkg.workspaces) {
  const base = glob.replace(/\/\*$/, '')
  for (const entry of readdirSync(path.join(root, base), { withFileTypes: true })) {
    const file = path.join(root, base, entry.name, 'package.json')
    if (!entry.isDirectory() || !existsSync(file)) continue
    const pkg = JSON.parse(readFileSync(file, 'utf8'))
    packages.push({ name: pkg.name, dir: `${base}/${entry.name}`, pkg })
  }
}
const byName = new Map(packages.map((p) => [p.name, p]))
const byDir = new Map(packages.map((p) => [p.dir, p]))

const deps = (p) =>
  Object.keys({ ...p.pkg.dependencies, ...p.pkg.devDependencies }).filter((n) => byName.has(n))
const dependents = (name) => packages.filter((p) => deps(p).includes(name)).map((p) => p.name)

function resolve(selector) {
  let s = selector
  const withDependents = s.startsWith('...')
  if (withDependents) s = s.slice(3)
  if (s.startsWith('{') && s.endsWith('}')) s = s.slice(1, -1)
  const found =
    s.startsWith('./') || (s.includes('/') && !s.startsWith('@'))
      ? byDir.get(path.posix.normalize(s.replace(/^\.\//, '')).replace(/\/$/, ''))
      : (byName.get(s) ?? byName.get(`@narrative/${s}`))
  if (!found) {
    console.error(`workspace-run: no workspace package matches "${selector}"`)
    process.exit(64)
  }
  const out = new Set([found.name])
  if (withDependents) {
    const queue = [found.name]
    while (queue.length > 0) {
      for (const d of dependents(queue.shift())) {
        if (!out.has(d)) {
          out.add(d)
          queue.push(d)
        }
      }
    }
  }
  return out
}

const args = process.argv.slice(2)
let concurrency = 4
let countOnly = false
if (args[0] === '--count') {
  countOnly = true
  args.shift()
} else if (args[0] === '--concurrency') {
  concurrency = Math.max(1, Number.parseInt(args[1], 10) || 1)
  args.splice(0, 2)
}
const script = args.shift()
if (script === undefined) {
  console.error('usage: workspace-run.mjs [--concurrency N] <script> [selector...]')
  process.exit(64)
}
// Arguments may arrive as one word with spaces (run-parallel.sh splits recipe
// words, `just test "...{./apps/web} ...{./packages/shared}"`).
const selectors = args.flatMap((a) => a.split(/\s+/)).filter(Boolean)
const selected =
  selectors.length === 0
    ? packages.map((p) => p.name)
    : [...new Set(selectors.flatMap((s) => [...resolve(s)]))]
const queue = selected
  .map((n) => byName.get(n))
  .filter((p) => p.pkg.scripts?.[script] !== undefined)

if (countOnly) {
  console.log(Math.max(1, Math.min(queue.length, concurrency)))
  process.exit(0)
}

const width = Math.max(0, ...queue.map((p) => p.name.length))
const results = []
function runOne(p) {
  return new Promise((done) => {
    const started = Date.now()
    const child = spawn('bun', ['run', script], {
      cwd: path.join(root, p.dir),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const prefix = `${p.name.padEnd(width)} | `
    for (const stream of [child.stdout, child.stderr]) {
      readline
        .createInterface({ input: stream })
        .on('line', (l) => process.stdout.write(prefix + l + '\n'))
    }
    child.on('close', (code, signal) => {
      const secs = ((Date.now() - started) / 1000).toFixed(1)
      results.push({
        name: p.name,
        ok: code === 0,
        how: code === 0 ? `ok ${secs}s` : `failed (${signal ?? code}) ${secs}s`,
      })
      done()
    })
  })
}
async function worker() {
  for (let p = queue.shift(); p !== undefined; p = queue.shift()) await runOne(p)
}
await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker))
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name} ${script}: ${r.how}`)
process.exit(results.every((r) => r.ok) ? 0 : 1)
