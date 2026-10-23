import { describe, expect, it } from 'vitest'
import { parseArgs, regressed, resolveIds } from './run.js'

describe('perf run arguments', () => {
  it('takes flags with values in both spellings and boolean flags', () => {
    const a = parseArgs(['transform.move.rect', '--mode', 'profiling', '--runs=3', '--no-build'])
    expect(a.positional).toEqual(['transform.move.rect'])
    expect(a.flags.get('mode')).toBe('profiling')
    expect(a.flags.get('runs')).toBe('3')
    expect(a.flags.get('no-build')).toBe(true)
  })

  it('resolves named benches, every layer I bench, or the ones with counters', () => {
    expect(resolveIds(['transform.move.rect'], undefined)).toEqual(['transform.move.rect'])
    expect(() => resolveIds(['no.such.bench'], undefined)).toThrow(/no bench/)
    const all = resolveIds([], undefined)
    expect(all).toContain('deck.open.cold.100')
    expect(all).not.toContain('deck.open.lighthouse')
    expect(resolveIds([], 'C').length).toBeGreaterThan(10)
  })
})

describe('the bisect predicate', () => {
  const v = {
    bench: 'present.advance.text',
    regressions: ['frame.max', 'react.commits'],
    improvements: [],
    counterChanges: [],
  }

  it('counts any regression or counter change without --metric', () => {
    expect(regressed(v)).toBe(true)
    expect(regressed({ ...v, regressions: [], counterChanges: ['sg.mount'] })).toBe(true)
    expect(regressed({ ...v, regressions: [] })).toBe(false)
  })

  it('counts only the named metrics with --metric', () => {
    expect(regressed(v, new Set(['react.commits']))).toBe(true)
    expect(regressed({ ...v, regressions: ['frame.max'] }, new Set(['react.commits']))).toBe(false)
    expect(
      regressed({ ...v, regressions: [], counterChanges: ['sg.mount'] }, new Set(['sg.mount'])),
    ).toBe(true)
  })

  it('takes --metric with a value in both spellings', () => {
    expect(parseArgs(['--metric', 'react.commits']).flags.get('metric')).toBe('react.commits')
    expect(parseArgs(['--metric=a,b']).flags.get('metric')).toBe('a,b')
  })
})
