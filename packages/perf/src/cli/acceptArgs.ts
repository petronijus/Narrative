/**
 * cli/acceptArgs.ts — the arguments of `just perf-accept <id…> [--series S…]`.
 *
 * Without `--series` an accept takes the latest result of every series a
 * bench has on this machine (mode × runtime: `prod/chromium-browser`,
 * `prod/webkit-tauri-2x`, …) as its baseline. A series last measured on an
 * older revision (a Tauri run of last week, a compare's other side) then
 * becomes a baseline it was never meant to be. `--series` names the series
 * to take, as `baselineKey` writes them after the `@` — a comma-separated
 * list, the flag repeatable; `--series none` takes no baseline at all (only
 * the counter budget). The budget is always taken (from the latest dev
 * result, `budgetResult`).
 */

export interface AcceptArgs {
  ids: string[]
  /** The series whose baselines are taken; null: every series. */
  series: Set<string> | null
}

export function parseAcceptArgs(args: readonly string[]): AcceptArgs {
  const ids: string[] = []
  let series: Set<string> | null = null
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    let value: string | undefined
    if (a === '--series') value = args[++i]
    else if (a.startsWith('--series=')) value = a.slice('--series='.length)
    else if (a.startsWith('--')) throw new Error(`perf-accept: unknown option ${a}`)
    else {
      ids.push(a)
      continue
    }
    if (value === undefined || value === '')
      throw new Error('perf-accept: --series needs a value (mode/runtime[,…] or none)')
    series ??= new Set()
    for (const s of value.split(',').map((v) => v.trim())) {
      if (s === 'none') continue
      if (!/^[a-z]+\/[a-z0-9-]+$/.test(s))
        throw new Error(
          `perf-accept: --series ${s}: expected mode/runtime, e.g. prod/chromium-browser`,
        )
      series.add(s)
    }
  }
  return { ids, series }
}

/** Whether the series of `key` (`bench@mode/runtime`) is one `series` takes. */
export function takesSeries(series: Set<string> | null, key: string): boolean {
  if (series === null) return true
  const at = key.indexOf('@')
  return at >= 0 && series.has(key.slice(at + 1))
}
