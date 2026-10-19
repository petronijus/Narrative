/**
 * perfCounters.ts — the work counters of the performance harness (layer C,
 * docs/plans/perf-harness.md → The counters).
 *
 * Counter sites in the renderer, the slide model and the editor's state call
 * `perfCount('text.raster.started')` at the points where work happens. With
 * the harness off — every production page without `?perf=1`, the server, the
 * render worker, the unit suites — `counts` is null and a call is one function
 * call and one comparison: nothing is allocated, no key string is built
 * (`perfCountFor` concatenates only when counting).
 *
 * The web app switches counting on (apps/web/src/perf/activation.ts); the
 * lazily loaded harness chunk reads, resets and snapshots the counts. This
 * module is the only part of the harness the eager bundle carries, and it
 * lives here because counter sites sit in packages too (slide-model), which
 * cannot import the web app.
 *
 * Keys are dotted lowercase names (`sg.mount.text`, `gl.texUpload`); a
 * snapshot is a plain record, missing keys are zero.
 *
 * The record lives on `globalThis[PERF_COUNTS_KEY]`, not in a module variable:
 * the web app's boot code switches counting on by setting it
 * (apps/web/src/perf/activation.ts) without importing this module, which
 * would otherwise become a chunk of its own on the editor's critical path.
 *
 * The key is a registered symbol, not a string: a string-named global can be
 * clobbered by the page itself — every element with an `id` or `name` is
 * reachable as `window[thatName]` (named access) while no own property
 * shadows it, and in a production page without `?perf=1` none does. An
 * element `id="__narrative_perf_counts"` in deck content would then switch
 * counting "on" and have every site write expandos onto it. Named access
 * never yields a symbol-keyed property; `Symbol.for` keeps the key the same
 * across the separately bundled chunks (and in a Playwright `evaluate`).
 */

/** Where the counts live; null or absent = counting is off. */
export const PERF_COUNTS_KEY: unique symbol = Symbol.for('narrative.perf.counts')

type CountsHolder = { [PERF_COUNTS_KEY]?: Record<string, number> | null }
const holder = globalThis as CountsHolder

/** Add `n` (default 1) to a counter, when counting is on. */
export function perfCount(key: string, n = 1): void {
  const counts = holder[PERF_COUNTS_KEY]
  if (counts == null) return
  counts[key] = (counts[key] ?? 0) + n
}

/** `perfCount(`${key}.${sub}`, n)` without building the key when counting is off. */
export function perfCountFor(key: string, sub: string, n = 1): void {
  const counts = holder[PERF_COUNTS_KEY]
  if (counts == null) return
  const k = `${key}.${sub}`
  counts[k] = (counts[k] ?? 0) + n
}

/** Whether counting is on (a site with work of its own to count can skip it when not). */
export function perfCountersOn(): boolean {
  return holder[PERF_COUNTS_KEY] != null
}

/** Switch counting on; idempotent — counts kept so far stay. */
export function startPerfCounters(): void {
  holder[PERF_COUNTS_KEY] ??= {}
}

/** Switch counting off and drop the counts. */
export function stopPerfCounters(): void {
  holder[PERF_COUNTS_KEY] = null
}

/** Zero every counter (counting stays on, if it was). */
export function resetPerfCounters(): void {
  if (holder[PERF_COUNTS_KEY] != null) holder[PERF_COUNTS_KEY] = {}
}

/** A copy of the counts so far; empty when counting is off. */
export function readPerfCounters(): Record<string, number> {
  const counts = holder[PERF_COUNTS_KEY]
  return counts == null ? {} : { ...counts }
}
