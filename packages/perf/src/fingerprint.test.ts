import { describe, expect, it } from 'vitest'
import { comparability, fingerprintWarnings, refuseToRun, type Fingerprint } from './fingerprint.js'
import {
  parseLowPowerMode,
  parsePowerSource,
  machineName,
  collectFingerprint,
} from './node/fingerprint.js'

function fp(over: Partial<Fingerprint> = {}): Fingerprint {
  return {
    machine: 'petrs-macbook-pro',
    git: { sha: 'a'.repeat(40), dirty: false },
    build: { mode: 'prod', source: { kind: 'local', version: 'abc1234' } },
    os: { platform: 'darwin', release: '27.0.0', arch: 'arm64' },
    cpu: { model: 'Apple M3 Pro', cores: 12 },
    loadAvg: [1, 1, 1],
    node: 'v24.15.0',
    power: { source: 'ac', lowPowerMode: false },
    takenAt: '2026-10-18T10:00:00.000Z',
    ...over,
  }
}

const deployed = (version: string, origin = 'https://narrative.example.com') =>
  ({ mode: 'prod', source: { kind: 'deployed', origin, version } }) as const

describe('comparability', () => {
  it('two runs on one machine and build mode compare, whatever their shas', () => {
    expect(comparability(fp(), fp({ git: { sha: 'b'.repeat(40), dirty: true } }))).toEqual({
      ok: true,
    })
  })

  it('never across machines', () => {
    const r = comparability(fp(), fp({ machine: 'petronijus-pc' }))
    expect(r).toEqual({ ok: false, reasons: [expect.stringMatching(/different machines/)] })
  })

  it('never across build modes, not even in an A/B', () => {
    for (const [a, b] of [
      ['dev', 'prod'],
      ['prod', 'profiling'],
      ['dev', 'profiling'],
    ] as const) {
      const x = fp({ build: { mode: a, source: { kind: 'local' } } })
      const y = fp({ build: { mode: b, source: { kind: 'local' } } })
      for (const ab of [false, true]) {
        const r = comparability(x, y, { ab })
        expect(r.ok).toBe(false)
        expect(!r.ok && r.reasons.join()).toMatch(/build modes .* never compared/)
      }
    }
  })

  it('a local build vs a deployed one, or two deployed versions, only in an A/B', () => {
    const local = fp()
    const v1 = fp({ build: deployed('0.15.0') })
    const v2 = fp({ build: deployed('0.15.1') })
    const other = fp({ build: deployed('0.15.0', 'https://staging.example.com') })
    expect(comparability(local, v1).ok).toBe(false)
    expect(comparability(v1, v2)).toEqual({
      ok: false,
      reasons: [expect.stringMatching(/deployed versions \(0.15.0 vs 0.15.1\)/)],
    })
    expect(comparability(v1, other)).toEqual({
      ok: false,
      reasons: [expect.stringMatching(/different origins/)],
    })
    expect(comparability(v1, fp({ build: deployed('0.15.0') }))).toEqual({ ok: true })
    for (const [a, b] of [
      [local, v1],
      [v1, v2],
      [v1, other],
    ])
      expect(comparability(a!, b!, { ab: true })).toEqual({ ok: true })
  })

  it('never across power states, browsers, shells or GL renderers', () => {
    const chrome = {
      name: 'chromium',
      version: '140',
      engine: 'chromium',
      shell: 'browser',
    } as const
    const cases: Array<[Partial<Fingerprint>, Partial<Fingerprint>, RegExp]> = [
      [{}, { power: { source: 'battery', lowPowerMode: false } }, /power sources/],
      [{}, { power: { source: 'ac', lowPowerMode: true } }, /Low Power Mode/],
      [{ browser: chrome }, {}, /browser result vs a Node result/],
      [{ browser: chrome }, { browser: { ...chrome, version: '141' } }, /chromium versions/],
      [
        { browser: chrome },
        { browser: { ...chrome, engine: 'webkit', name: 'webkit' } },
        /browsers/,
      ],
      [{ browser: chrome }, { browser: { ...chrome, shell: 'tauri' } }, /shells/],
      [
        { gl: { vendor: 'Apple', renderer: 'ANGLE Metal' } },
        { gl: { vendor: 'Google', renderer: 'SwiftShader' } },
        /GL renderers/,
      ],
    ]
    for (const [a, b, why] of cases) {
      const r = comparability(fp(a), fp(b), { ab: true })
      expect(r.ok).toBe(false)
      expect(!r.ok && r.reasons.join()).toMatch(why)
    }
  })

  it('lists every reason at once', () => {
    const r = comparability(
      fp(),
      fp({ machine: 'x', build: { mode: 'dev', source: { kind: 'local' } } }),
    )
    expect(!r.ok && r.reasons).toHaveLength(2)
  })
})

describe('refusals and warnings', () => {
  it('refuses WebKit in Low Power Mode', () => {
    const webkit = { name: 'webkit', version: '26', engine: 'webkit', shell: 'tauri' } as const
    expect(
      refuseToRun(fp({ browser: webkit, power: { source: 'ac', lowPowerMode: true } })),
    ).toHaveLength(1)
    expect(refuseToRun(fp({ browser: webkit }))).toEqual([])
    expect(refuseToRun(fp({ power: { source: 'ac', lowPowerMode: true } }))).toEqual([])
  })

  it('warns on a dirty checkout, a busy machine and battery', () => {
    const w = fingerprintWarnings(
      fp({
        git: { sha: 'a', dirty: true },
        loadAvg: [9, 9, 9],
        power: { source: 'battery', lowPowerMode: false },
      }),
    )
    expect(w).toHaveLength(3)
    expect(fingerprintWarnings(fp())).toEqual([])
  })
})

describe('collecting the fingerprint', () => {
  it('reads the power source and Low Power Mode from pmset', () => {
    expect(parsePowerSource("Now drawing from 'AC Power'\n -InternalBattery-0 89%")).toBe('ac')
    expect(parsePowerSource("Now drawing from 'Battery Power'")).toBe('battery')
    expect(parsePowerSource('')).toBe('unknown')
    expect(
      parseLowPowerMode('System-wide power settings:\n sleep 1\n lowpowermode         1\n'),
    ).toBe(true)
    expect(parseLowPowerMode(' lowpowermode 0\n')).toBe(false)
    expect(parseLowPowerMode(' powermode 2\n')).toBe(false)
    expect(parseLowPowerMode(' sleep 1\n')).toBeNull()
  })

  it('names the machine from the host name or NARRATIVE_PERF_MACHINE', () => {
    expect(machineName({}, 'Petrs-MacBook-Pro.local')).toBe('petrs-macbook-pro')
    expect(machineName({ NARRATIVE_PERF_MACHINE: 'Linux Desktop' }, 'x')).toBe('linux-desktop')
    expect(() => machineName({}, '...')).toThrow(/NARRATIVE_PERF_MACHINE/)
  })

  it('records git, the build and the environment', () => {
    const calls: string[] = []
    const f = collectFingerprint({
      build: { mode: 'profiling', source: { kind: 'local' } },
      env: { NARRATIVE_PERF_MACHINE: 'test-box' },
      now: () => new Date('2026-10-18T12:00:00Z'),
      exec: (file, args) => {
        calls.push(`${file} ${args.join(' ')}`)
        if (file === 'git' && args[0] === 'rev-parse') return 'f'.repeat(40) + '\n'
        if (file === 'git') return ' M packages/perf/src/stats.ts\n'
        if (args[1] === 'batt') return "Now drawing from 'AC Power'"
        return ' lowpowermode 0\n'
      },
    })
    expect(f).toMatchObject({
      machine: 'test-box',
      git: { sha: 'f'.repeat(40), dirty: true },
      build: { mode: 'profiling', source: { kind: 'local' } },
      node: process.version,
      takenAt: '2026-10-18T12:00:00.000Z',
    })
    expect(f.cpu.cores).toBeGreaterThan(0)
    if (process.platform === 'darwin')
      expect(f.power).toEqual({ source: 'ac', lowPowerMode: false })
    else expect(f.power).toBeNull()
  })

  it('a checkout without git records null, not a fake sha', () => {
    const f = collectFingerprint({
      build: { mode: 'dev', source: { kind: 'local' } },
      env: { NARRATIVE_PERF_MACHINE: 'm' },
      exec: () => null,
    })
    expect(f.git).toBeNull()
  })
})
