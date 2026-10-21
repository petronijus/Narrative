/**
 * report.ts — the terminal output: compact, aligned `PERF …` lines in the
 * style of the crowded-slide probe (apps/web/e2e/perf-heavy-slide.spec.ts),
 * one per bench metric, one per comparison, one per counter change. Returns
 * strings; the caller prints them.
 */

import type { CounterDiff } from './budgets.js'
import { formatCounterDiff } from './budgets.js'
import type { BenchDef } from './defineBench.js'
import { fingerprintWarnings, type Fingerprint } from './fingerprint.js'
import type { BenchResult, MetricComparison } from './result.js'

/** A number for a table cell: 3 significant digits, no exponent below 1e9. */
export function fmt(n: number): string {
  if (!Number.isFinite(n)) return n > 0 ? '∞' : n < 0 ? '-∞' : 'NaN'
  if (Number.isInteger(n) && Math.abs(n) < 1e9) return String(n)
  const abs = Math.abs(n)
  if (abs >= 100) return n.toFixed(0)
  if (abs >= 10) return n.toFixed(1)
  if (abs >= 1) return n.toFixed(2)
  return n.toPrecision(3)
}

function pct(x: number): string {
  if (!Number.isFinite(x)) return x > 0 ? '+∞%' : '-∞%'
  return `${x > 0 ? '+' : ''}${(x * 100).toFixed(1)}%`
}

/** Columns padded to their widest cell; the last column is not padded. */
export function table(rows: ReadonlyArray<readonly string[]>, prefix = 'PERF '): string[] {
  const widths: number[] = []
  for (const r of rows) r.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, c.length)))
  return rows.map(
    (r) =>
      prefix +
      r
        .map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!)))
        .join('  ')
        .trimEnd(),
  )
}

/** One line per metric: `PERF fill.solid.mount  frameMs  median=12.3ms  p90=14.1  mad=0.4  n=15`. */
export function formatResult(def: Pick<BenchDef<never>, 'metrics'>, result: BenchResult): string[] {
  const rows = Object.entries(result.summary).map(([m, s]) => {
    const unit = def.metrics[m]?.unit ?? ''
    const u = unit === 'count' ? '' : unit
    return [
      result.benchId,
      m,
      `median=${fmt(s.median)}${u}`,
      `p90=${fmt(s.p90)}`,
      `mad=${fmt(s.mad)}`,
      `n=${s.n}`,
    ]
  })
  return table(rows)
}

const MARK: Record<MetricComparison['verdict'], string> = {
  regression: 'REGRESSION',
  improvement: 'improvement',
  'no-change': 'no change',
}

/** `PERF fill.solid.mount  frameMs  12.3 → 13.1ms  +6.5%  CI [+0.4, +1.2]  REGRESSION`. */
export function formatComparisons(
  benchId: string,
  comparisons: readonly MetricComparison[],
): string[] {
  return table(
    comparisons.map((c) => {
      const u = c.unit === 'count' ? '' : c.unit
      return [
        benchId,
        c.metric,
        `${fmt(c.base)} → ${fmt(c.candidate)}${u}`,
        pct(c.relative),
        `CI [${fmt(c.interval.low)}, ${fmt(c.interval.high)}]`,
        `${MARK[c.verdict]}${c.verdict === 'no-change' ? ` (${c.reason})` : ''}`,
      ]
    }),
  )
}

/** `PERF budget fill.solid.mount: text.rasters: 0 → 120 (+120)`, or one `ok` line. */
export function formatBudgetCheck(benchId: string, diff: CounterDiff): string[] {
  if (diff.ok) return [`PERF budget ${benchId}: ok`]
  return formatCounterDiff(diff).map((line) => `PERF budget ${benchId}: ${line}`)
}

/** The fingerprint in one line, with its warnings. */
export function formatFingerprint(fp: Fingerprint): string[] {
  const src = fp.build.source
  const build =
    src.kind === 'local'
      ? `${fp.build.mode} (local${src.version === undefined ? '' : ` ${src.version}`})`
      : `${fp.build.mode} (${src.origin} ${src.version})`
  const parts = [
    fp.machine,
    fp.git === null ? 'no git' : `${fp.git.sha.slice(0, 10)}${fp.git.dirty ? '+' : ''}`,
    build,
    `${fp.os.platform}/${fp.os.arch}`,
    fp.cpu.model,
    `load ${fp.loadAvg.map((l) => l.toFixed(1)).join(' ')}`,
    `node ${fp.node}`,
  ]
  if (fp.power !== null)
    parts.push(`power ${fp.power.source}${fp.power.lowPowerMode === true ? ' LOW-POWER' : ''}`)
  if (fp.browser !== undefined)
    parts.push(
      `${fp.browser.name} ${fp.browser.version} (${fp.browser.shell}${
        fp.browser.headed === true ? ', headed' : ''
      }${(fp.browser.deviceScale ?? 1) !== 1 ? `, ${fp.browser.deviceScale}×` : ''})`,
    )
  if (fp.gl !== undefined) parts.push(fp.gl.renderer)
  return [`PERF env ${parts.join(' · ')}`, ...fingerprintWarnings(fp).map((w) => `PERF warn ${w}`)]
}
