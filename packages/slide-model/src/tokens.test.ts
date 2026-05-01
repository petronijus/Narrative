/**
 * slide-model/src/tokens.test.ts
 *
 * Unit tests for M16 P2 token helpers:
 *   - isTokenRef type guard
 *   - resolveTokenValue: literal passthrough, ref resolved, missing → null,
 *     cyclic / deep textStyle.color guard
 */

import { describe, it, expect } from 'vitest'
import { isTokenRef, resolveTokenValue } from './tokens.js'
import type { TokenRef, FolderTokensSnapshot } from './tokens.js'

// ---------------------------------------------------------------------------
// isTokenRef
// ---------------------------------------------------------------------------

describe('isTokenRef', () => {
  it('returns true for a valid TokenRef object', () => {
    expect(isTokenRef({ $token: 'colors.abc1234567' })).toBe(true)
  })

  it('returns true for any non-empty $token string', () => {
    expect(isTokenRef({ $token: 'textStyles.xxxxxxxxxx' })).toBe(true)
  })

  it('returns false for a plain number', () => {
    expect(isTokenRef(0xff0000)).toBe(false)
  })

  it('returns false for a string', () => {
    expect(isTokenRef('#ff0000')).toBe(false)
  })

  it('returns false for null', () => {
    expect(isTokenRef(null)).toBe(false)
  })

  it('returns false for undefined', () => {
    expect(isTokenRef(undefined)).toBe(false)
  })

  it('returns false for an object without $token', () => {
    expect(isTokenRef({ token: 'colors.abc' })).toBe(false)
  })

  it('returns false when $token is not a string', () => {
    expect(isTokenRef({ $token: 123 })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// resolveTokenValue
// ---------------------------------------------------------------------------

function makeSnapshot(overrides?: Partial<FolderTokensSnapshot>): FolderTokensSnapshot {
  return {
    colors: {
      red: { id: 'red', name: 'Red', value: '#ff0000' },
      blue: { id: 'blue', name: 'Blue', value: '#0000ff' },
    },
    textStyles: {
      heading: {
        id: 'heading',
        name: 'Heading',
        family: 'Inter',
        size: 32,
        color: '#111111',
      },
      headingTokenColor: {
        id: 'headingTokenColor',
        name: 'Heading (token color)',
        color: { $token: 'colors.red' },
      },
      noColor: {
        id: 'noColor',
        name: 'No Color',
      },
    },
    effectStyles: {
      shadow1: {
        id: 'shadow1',
        name: 'Shadow 1',
        kind: 'shadow',
        params: { blur: 8, offsetX: 0, offsetY: 4 },
      },
    },
    ...overrides,
  }
}

describe('resolveTokenValue', () => {
  const tokens = makeSnapshot()

  it('resolves a colors ref to the hex value', () => {
    const ref: TokenRef = { $token: 'colors.red' }
    expect(resolveTokenValue(ref, tokens)).toBe('#ff0000')
  })

  it('resolves a different color token', () => {
    const ref: TokenRef = { $token: 'colors.blue' }
    expect(resolveTokenValue(ref, tokens)).toBe('#0000ff')
  })

  it('returns null for a missing color id', () => {
    const ref: TokenRef = { $token: 'colors.missing' }
    expect(resolveTokenValue(ref, tokens)).toBeNull()
  })

  it('resolves a textStyle with a literal hex color', () => {
    const ref: TokenRef = { $token: 'textStyles.heading' }
    expect(resolveTokenValue(ref, tokens)).toBe('#111111')
  })

  it('resolves a textStyle whose color is itself a TokenRef (depth 2)', () => {
    const ref: TokenRef = { $token: 'textStyles.headingTokenColor' }
    expect(resolveTokenValue(ref, tokens)).toBe('#ff0000')
  })

  it('returns null for a textStyle with no color field', () => {
    const ref: TokenRef = { $token: 'textStyles.noColor' }
    expect(resolveTokenValue(ref, tokens)).toBeNull()
  })

  it('returns null for a missing textStyle id', () => {
    const ref: TokenRef = { $token: 'textStyles.missing' }
    expect(resolveTokenValue(ref, tokens)).toBeNull()
  })

  it('returns null for effectStyles (no colour value)', () => {
    const ref: TokenRef = { $token: 'effectStyles.shadow1' }
    expect(resolveTokenValue(ref, tokens)).toBeNull()
  })

  it('returns null for an unknown category', () => {
    const ref: TokenRef = { $token: 'unknown.abc' }
    expect(resolveTokenValue(ref, tokens)).toBeNull()
  })

  it('returns null for a malformed $token with no dot', () => {
    const ref: TokenRef = { $token: 'nodot' }
    expect(resolveTokenValue(ref, tokens)).toBeNull()
  })

  it('guards against a textStyle.color that references a non-colors category (no deep recursion)', () => {
    // textStyle references another textStyle — structurally odd, but should return null
    const cyclic = makeSnapshot({
      textStyles: {
        ts1: {
          id: 'ts1',
          name: 'TS1',
          color: { $token: 'textStyles.ts1' }, // self-ref
        },
      },
    })
    const ref: TokenRef = { $token: 'textStyles.ts1' }
    expect(resolveTokenValue(ref, cyclic)).toBeNull()
  })
})
