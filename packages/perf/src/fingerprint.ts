/**
 * fingerprint.ts — the environment a result was measured in, and whether two
 * results may be compared at all (docs/plans/perf-harness.md → Measuring
 * time precisely, Decisions).
 *
 * The Node layers collect the machine half (`@narrative/perf/node` →
 * collectFingerprint); the browser layers add `browser` and `gl`. This file
 * is types and pure functions only, so the `/bench` chunk can carry it.
 *
 * Comparability, strictest first:
 *   - never across machines (a baseline is per machine);
 *   - never across build modes — dev, prod and profiling builds measure
 *     different React and Vite code (Decisions: "results of different modes
 *     are never compared with each other"), not even in an A/B;
 *   - never across browsers, engines, shells or GL renderers, nor across
 *     power states (AC vs battery, Low Power Mode on vs off);
 *   - across build sources (a local build vs a deployed origin) and across
 *     versions of the same origin only in an explicit A/B — that is what an
 *     A/B of two releases is; against a baseline it is refused.
 * The git sha is not a comparability field: a baseline and a candidate (or
 * the two sides of an A/B) differ in it by definition.
 */

export type BuildMode = 'dev' | 'prod' | 'profiling'

export const BUILD_MODES: readonly BuildMode[] = ['dev', 'prod', 'profiling']

/**
 * Where the measured build came from. `local`: built from this checkout (the
 * Vite dev server, or a `vite build` served by `vite preview`); `deployed`: a
 * build served by an origin, identified by its `/version.json`.
 */
export type BuildSource =
  | { kind: 'local'; /** `/version.json` of the local build, when it has one. */ version?: string }
  | { kind: 'deployed'; origin: string; version: string }

export interface BuildInfo {
  mode: BuildMode
  source: BuildSource
}

export type PowerSource = 'ac' | 'battery' | 'ups' | 'unknown'

export interface Fingerprint {
  /** Directory name under ~/.cache/narrative-perf; stable per machine. */
  machine: string
  /** The harness checkout; for a deployed build the build's identity is `build.source`. */
  git: { sha: string; dirty: boolean } | null
  build: BuildInfo
  os: { platform: string; release: string; arch: string }
  cpu: { model: string; cores: number }
  /** 1, 5 and 15 minute load averages at the start of the run. */
  loadAvg: readonly [number, number, number]
  node: string
  /** macOS: from `pmset -g`; null where it is not read. */
  power: { source: PowerSource; lowPowerMode: boolean | null } | null
  /** Filled by the browser layers (B, I). */
  browser?: {
    name: string
    version: string
    engine: 'chromium' | 'webkit' | 'gecko'
    shell: 'browser' | 'tauri' | 'electron'
  }
  gl?: { vendor: string; renderer: string }
  /** ISO time the fingerprint was taken. */
  takenAt: string
}

export type Comparability = { ok: true } | { ok: false; reasons: string[] }

export interface ComparabilityOptions {
  /**
   * An explicit A/B (perf-compare): the two sides may differ in build source
   * and version — that is the point of it. Mode, machine, browser and power
   * must still match.
   */
  ab?: boolean
}

function describeSource(s: BuildSource): string {
  return s.kind === 'local'
    ? `a local build${s.version === undefined ? '' : ` (${s.version})`}`
    : `${s.origin} ${s.version}`
}

/** Whether results taken under `a` and `b` may be compared, and if not, every reason why. */
export function comparability(
  a: Fingerprint,
  b: Fingerprint,
  options: ComparabilityOptions = {},
): Comparability {
  const reasons: string[] = []
  if (a.machine !== b.machine) reasons.push(`different machines (${a.machine} vs ${b.machine})`)
  if (a.build.mode !== b.build.mode)
    reasons.push(
      `different build modes (${a.build.mode} vs ${b.build.mode}); modes are never compared`,
    )

  const sa = a.build.source
  const sb = b.build.source
  if (!options.ab) {
    if (sa.kind !== sb.kind)
      reasons.push(
        `different build sources (${describeSource(sa)} vs ${describeSource(sb)}); only an A/B compares them`,
      )
    else if (sa.kind === 'deployed' && sb.kind === 'deployed') {
      if (sa.origin !== sb.origin)
        reasons.push(`different origins (${sa.origin} vs ${sb.origin}); only an A/B compares them`)
      else if (sa.version !== sb.version)
        reasons.push(
          `different deployed versions (${sa.version} vs ${sb.version}); only an A/B compares them`,
        )
    }
  }

  if (a.os.platform !== b.os.platform || a.os.arch !== b.os.arch)
    reasons.push(`different OS (${a.os.platform}/${a.os.arch} vs ${b.os.platform}/${b.os.arch})`)
  if (a.cpu.model !== b.cpu.model) reasons.push(`different CPUs (${a.cpu.model} vs ${b.cpu.model})`)

  const pa = a.power
  const pb = b.power
  if (pa !== null && pb !== null) {
    if (pa.source !== pb.source)
      reasons.push(`different power sources (${pa.source} vs ${pb.source})`)
    if (pa.lowPowerMode !== pb.lowPowerMode)
      reasons.push(
        `Low Power Mode differs (${String(pa.lowPowerMode)} vs ${String(pb.lowPowerMode)})`,
      )
  } else if ((pa === null) !== (pb === null))
    reasons.push('the power state is known for one side only')

  const ba = a.browser
  const bb = b.browser
  if ((ba === undefined) !== (bb === undefined)) reasons.push('a browser result vs a Node result')
  else if (ba !== undefined && bb !== undefined) {
    if (ba.engine !== bb.engine || ba.name !== bb.name)
      reasons.push(`different browsers (${ba.name}/${ba.engine} vs ${bb.name}/${bb.engine})`)
    else if (ba.version !== bb.version)
      reasons.push(`different ${ba.name} versions (${ba.version} vs ${bb.version})`)
    if (ba.shell !== bb.shell) reasons.push(`different shells (${ba.shell} vs ${bb.shell})`)
  }
  if (a.gl?.renderer !== b.gl?.renderer)
    reasons.push(
      `different GL renderers (${a.gl?.renderer ?? 'none'} vs ${b.gl?.renderer ?? 'none'})`,
    )

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons }
}

/**
 * Why a run must not be taken at all under this fingerprint, or an empty list.
 * WebKit in macOS Low Power Mode is capped at 30 fps (performance.md → Ground
 * rules): its numbers would measure the cap.
 */
export function refuseToRun(fp: Fingerprint): string[] {
  const reasons: string[] = []
  if (fp.browser?.engine === 'webkit' && fp.power?.lowPowerMode === true)
    reasons.push('WebKit in Low Power Mode is capped at 30 fps: switch Low Power Mode off')
  return reasons
}

/** Load average per core above which timings are flagged as taken on a busy machine. */
export const BUSY_LOAD_PER_CORE = 0.5

/** Warnings that do not refuse a result but belong next to it. */
export function fingerprintWarnings(fp: Fingerprint): string[] {
  const warnings: string[] = []
  if (fp.git?.dirty === true) warnings.push('the checkout has uncommitted changes')
  if (fp.cpu.cores > 0 && fp.loadAvg[0] / fp.cpu.cores > BUSY_LOAD_PER_CORE)
    warnings.push(`busy machine: load ${fp.loadAvg[0].toFixed(1)} on ${fp.cpu.cores} cores`)
  if (fp.power?.source === 'battery') warnings.push('on battery')
  return warnings
}
