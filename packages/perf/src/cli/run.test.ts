import { describe, expect, it } from 'vitest'
import { parseArgs, resolveIds } from './run.js'

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
