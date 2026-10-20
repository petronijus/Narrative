/**
 * coverage.test.ts — the coverage guard (docs/plans/perf-harness.md → Design
 * principles 2): every user action and every command is benched or exempted
 * in coverage.ts, with a reason. A new action or command fails here until it
 * is listed.
 */

import { describe, expect, it } from 'vitest'
import { coverageInput, repoCoverage } from './cli/checks.js'
import { coverageOk, coverageReport, NOT_YET_BENCHED } from './coverage.js'

describe('the coverage guard', () => {
  const report = repoCoverage()

  it('every user action and command is benched or exempted (packages/perf/src/coverage.ts)', () => {
    expect(report.uncovered).toEqual([])
  })

  it('exempts nothing that is gone or already benched', () => {
    expect(report.staleExemptions).toEqual([])
    expect(report.redundantExemptions).toEqual([])
  })

  it('benches name only actions and commands that exist', () => {
    expect(report.unknownTargets).toEqual([])
  })

  it('says why something is not benched', () => {
    expect(report.weakReasons).toEqual([])
  })

  it('sees the whole catalog and registry', () => {
    const input = coverageInput()
    expect(input.actions.length).toBeGreaterThan(80)
    expect(input.commands.length).toBeGreaterThan(140)
  })
})

describe('coverageReport', () => {
  const base = {
    actions: ['object.delete', 'object.copy'],
    commands: ['object.delete', 'object.create'],
    benches: [] as Array<{ id: string; actions?: string[]; commands?: string[] }>,
    actionExemptions: { 'object.delete': NOT_YET_BENCHED, 'object.copy': NOT_YET_BENCHED },
    commandExemptions: { 'object.delete': NOT_YET_BENCHED, 'object.create': NOT_YET_BENCHED },
  }

  it('passes when everything is exempted', () => {
    expect(coverageOk(coverageReport(base))).toBe(true)
  })

  it('fails on a new action or command nobody listed', () => {
    const r = coverageReport({
      ...base,
      actions: [...base.actions, 'object.flip'],
      commands: [...base.commands, 'object.flip'],
    })
    expect(r.uncovered).toEqual(['action object.flip', 'command object.flip'])
    expect(coverageOk(r)).toBe(false)
  })

  it('a bench covers what it names; its exemption must then go', () => {
    const benches = [
      { id: 'transform.move.rect', actions: ['object.delete'], commands: ['object.create'] },
    ]
    const r = coverageReport({ ...base, benches })
    expect(r.redundantExemptions).toEqual([
      'action object.delete (benched by transform.move.rect)',
      'command object.create (benched by transform.move.rect)',
    ])
    const fixed = coverageReport({
      ...base,
      benches,
      actionExemptions: { 'object.copy': NOT_YET_BENCHED },
      commandExemptions: { 'object.delete': NOT_YET_BENCHED },
    })
    expect(coverageOk(fixed)).toBe(true)
    expect(fixed.benchedBy.commands).toEqual({ 'object.create': ['transform.move.rect'] })
  })

  it('fails on stale exemptions, unknown targets and reasons that say nothing', () => {
    const r = coverageReport({
      ...base,
      benches: [{ id: 'x.y.z', commands: ['object.nope'] }],
      actionExemptions: { ...base.actionExemptions, 'object.gone': NOT_YET_BENCHED },
      commandExemptions: { ...base.commandExemptions, 'object.delete': 'trivial' },
    })
    expect(r.staleExemptions).toEqual(['action object.gone'])
    expect(r.unknownTargets).toEqual(['x.y.z: command object.nope'])
    expect(r.weakReasons).toEqual(['command object.delete'])
  })
})
