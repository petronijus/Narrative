/**
 * shared/src/awareness.test.ts
 *
 * Testy pro awareness helpers — peerColorFromId determinism.
 */

import { describe, it, expect } from 'vitest'
import {
  AGENT_PRINCIPAL_MESSAGE_TYPE,
  agentPrincipalKeyInput,
  parseAgentPrincipalMessage,
  peerColorFromId,
  sanitizePeerLabel,
} from './awareness.js'

describe('peerColorFromId', () => {
  it('returns same color for same id (deterministic)', () => {
    const id = 'abc123XY'
    expect(peerColorFromId(id)).toBe(peerColorFromId(id))
  })

  it('returns hsl string', () => {
    const color = peerColorFromId('test-id')
    expect(color).toMatch(/^hsl\(\d+, 70%, 55%\)$/)
  })

  it('hue is in 0-359 range', () => {
    const ids = ['a', 'bb', 'ccc', 'z9z9z9', 'ABCDEF', '00000000']
    for (const id of ids) {
      const color = peerColorFromId(id)
      const hue = parseInt(color.replace('hsl(', ''), 10)
      expect(hue).toBeGreaterThanOrEqual(0)
      expect(hue).toBeLessThan(360)
    }
  })

  it('different ids produce different hues (collision check for 15 peers)', () => {
    // Simulace 15 peer IDs — každý musí mít unikátní hue (v praxi nemusí být 100%
    // unikátní, ale pro 15 hodnot z rozsahu 0-359 to je silný předpoklad).
    const ids = Array.from({ length: 15 }, (_, i) => `peer-${i.toString().padStart(4, '0')}`)
    const hues = ids.map((id) => {
      const color = peerColorFromId(id)
      return parseInt(color.replace('hsl(', ''), 10)
    })
    const uniqueHues = new Set(hues)
    // Alespoň 13 z 15 musí být unikátních (2 kolize jsou přijatelné pro hash funkci)
    expect(uniqueHues.size).toBeGreaterThanOrEqual(13)
  })

  it('empty string produces valid color', () => {
    const color = peerColorFromId('')
    expect(color).toMatch(/^hsl\(\d+, 70%, 55%\)$/)
  })

  it('multiple calls return identical result', () => {
    const id = 'stable-session-id-xyz'
    const results = Array.from({ length: 5 }, () => peerColorFromId(id))
    expect(new Set(results).size).toBe(1)
  })
})

describe('agentPrincipalKeyInput', () => {
  it('is domain-separated, versioned and scoped to the document', () => {
    // The server MACs exactly this string (agent/presence.ts, HMAC-SHA256
    // with AGENT_PRINCIPAL_KEY_SECRET).
    expect(agentPrincipalKeyInput('deck_abc', '108234567890123456789')).toBe(
      'narrative:agent-principal:v2\ndeck_abc\n108234567890123456789',
    )
    expect(agentPrincipalKeyInput('deck_a', 'u')).not.toBe(agentPrincipalKeyInput('deck_b', 'u'))
  })
})

describe('parseAgentPrincipalMessage', () => {
  const key = 'Nr0FXJtfxptAS_duWznRdk'
  const msg = (extra: Record<string, unknown>): string =>
    JSON.stringify({
      type: AGENT_PRINCIPAL_MESSAGE_TYPE,
      documentName: 'deck_1',
      principalKey: key,
      ...extra,
    })

  it('parses a well-formed message', () => {
    expect(parseAgentPrincipalMessage(msg({}))).toEqual({
      type: AGENT_PRINCIPAL_MESSAGE_TYPE,
      documentName: 'deck_1',
      principalKey: key,
    })
  })

  it('ignores other messages and malformed payloads without throwing', () => {
    expect(parseAgentPrincipalMessage('{"type":"narrative.editorShow","slideId":"s"}')).toBeNull()
    expect(parseAgentPrincipalMessage('not json')).toBeNull()
    expect(parseAgentPrincipalMessage(42)).toBeNull()
    expect(parseAgentPrincipalMessage('[]')).toBeNull()
    expect(parseAgentPrincipalMessage(msg({ principalKey: 'short' }))).toBeNull()
    expect(parseAgentPrincipalMessage(msg({ principalKey: 'x'.repeat(21) + '/' }))).toBeNull()
    expect(parseAgentPrincipalMessage(msg({ documentName: '' }))).toBeNull()
    expect(parseAgentPrincipalMessage(msg({ documentName: 7 }))).toBeNull()
  })
})

describe('sanitizePeerLabel', () => {
  it('strips control, format and markup characters and collapses whitespace', () => {
    expect(sanitizePeerLabel('  a\u0000b\u200Bc\u202Ed  <x>`y`  ', 40)).toBe('abcd xy')
    expect(sanitizePeerLabel('tab\tand\nnewline', 40)).toBe('tab and newline')
  })

  it('returns null for nothing left, or for a non-string', () => {
    expect(sanitizePeerLabel('\u202E\u200B', 40)).toBeNull()
    expect(sanitizePeerLabel(null, 40)).toBeNull()
    expect(sanitizePeerLabel(undefined, 40)).toBeNull()
  })

  it('truncates by code points with an ellipsis', () => {
    const long = sanitizePeerLabel('é'.repeat(50), 40)!
    expect(Array.from(long)).toHaveLength(40)
    expect(long.endsWith('…')).toBe(true)
  })
})
