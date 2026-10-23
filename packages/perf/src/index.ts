/**
 * @narrative/perf — the performance harness core (docs/plans/perf-harness.md):
 * bench definitions, statistics, fingerprints, counter budgets and the
 * terminal reporter. Pure, with no side effects at import time, so the
 * web app can pull it into a lazily loaded chunk (`/bench`, `?perf=1`).
 * Node-only parts are `@narrative/perf/node`; the coverage guard's data is
 * `src/coverage.ts`, read by its test and the CLI only.
 */

export * from './benches.js'
export * from './budgets.js'
export * from './catalog/interaction.js'
export * from './catalog/server.js'
export * from './catalog/system.js'
export * from './defineBench.js'
export * from './disturbance.js'
export * from './fingerprint.js'
export * from './report.js'
export * from './result.js'
export * from './scenes.js'
export * from './stats.js'
