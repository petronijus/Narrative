/**
 * slide-model/src/awareness.test.ts
 *
 * Testy pro toPeerInfo() — správné parsování Y.Awareness state, isLocal flag.
 */

import { describe, it, expect } from 'vitest'
import { toPeerInfo, generatePeerId } from './awareness.js'
import type { PeerAwarenessState } from '@narrative/shared'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(overrides?: Partial<PeerAwarenessState>): PeerAwarenessState {
  return {
    user: { id: 'abc123', name: 'User abc1', color: 'hsl(42, 70%, 55%)' },
    selectedObjectIds: [],
    cursor: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// toPeerInfo
// ---------------------------------------------------------------------------

describe('toPeerInfo', () => {
  it('parses valid state correctly', () => {
    const state = makeState()
    const result = toPeerInfo(42, state, 99)
    expect(result).not.toBeNull()
    expect(result!.clientId).toBe(42)
    expect(result!.state.user.id).toBe('abc123')
    expect(result!.state.user.name).toBe('User abc1')
    expect(result!.state.selectedObjectIds).toEqual([])
    expect(result!.state.cursor).toBeNull()
  })

  it('sets isLocal=true when clientId matches localClientId', () => {
    const result = toPeerInfo(7, makeState(), 7)
    expect(result!.isLocal).toBe(true)
  })

  it('sets isLocal=false for remote peers', () => {
    const result = toPeerInfo(7, makeState(), 99)
    expect(result!.isLocal).toBe(false)
  })

  it('parses cursor when present', () => {
    const state = makeState({ cursor: { x: 120.5, y: 300.1, slideId: 'slide-a' } })
    const result = toPeerInfo(1, state, 99)
    expect(result!.state.cursor).toEqual({ x: 120.5, y: 300.1, slideId: 'slide-a' })
  })

  it('drops cursor without slideId (legacy payload guard)', () => {
    const state = makeState({ cursor: { x: 1, y: 2 } as never })
    const result = toPeerInfo(1, state, 99)
    expect(result!.state.cursor).toBeNull()
  })

  it('passes selectedObjectIds through', () => {
    const state = makeState({ selectedObjectIds: ['obj-1', 'obj-2'] })
    const result = toPeerInfo(1, state, 99)
    expect(result!.state.selectedObjectIds).toEqual(['obj-1', 'obj-2'])
  })

  it('filters non-string values in selectedObjectIds', () => {
    const rawState = {
      user: { id: 'x', name: 'User x', color: 'hsl(0, 70%, 55%)' },
      selectedObjectIds: ['valid', 42, null, 'also-valid'],
      cursor: null,
    }
    const result = toPeerInfo(1, rawState, 99)
    expect(result!.state.selectedObjectIds).toEqual(['valid', 'also-valid'])
  })

  it('returns null for null state', () => {
    expect(toPeerInfo(1, null, 99)).toBeNull()
  })

  it('returns null for non-object state', () => {
    expect(toPeerInfo(1, 'invalid', 99)).toBeNull()
    expect(toPeerInfo(1, 42, 99)).toBeNull()
  })

  it('returns null when user field missing', () => {
    const state = { selectedObjectIds: [], cursor: null }
    expect(toPeerInfo(1, state, 99)).toBeNull()
  })

  it('returns null when user.id is not string', () => {
    const state = {
      user: { id: 42, name: 'User', color: 'hsl(0, 70%, 55%)' },
      selectedObjectIds: [],
      cursor: null,
    }
    expect(toPeerInfo(1, state, 99)).toBeNull()
  })

  it('returns null when selectedObjectIds missing', () => {
    const state = {
      user: { id: 'x', name: 'User x', color: 'hsl(0, 70%, 55%)' },
      cursor: null,
    }
    expect(toPeerInfo(1, state, 99)).toBeNull()
  })

  it('ignores invalid cursor shape gracefully', () => {
    const state = {
      user: { id: 'x', name: 'User x', color: 'hsl(0, 70%, 55%)' },
      selectedObjectIds: [],
      cursor: { x: 'bad', y: 100 }, // x není number
    }
    const result = toPeerInfo(1, state, 99)
    // cursor s nevalidním tvarem → null
    expect(result!.state.cursor).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// generatePeerId
// ---------------------------------------------------------------------------

describe('generatePeerId', () => {
  it('returns a non-empty string', () => {
    const id = generatePeerId()
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
  })

  it('generates unique IDs', () => {
    const ids = Array.from({ length: 20 }, () => generatePeerId())
    expect(new Set(ids).size).toBe(20)
  })
})
