/**
 * shared/src/awareness.test.ts
 *
 * Testy pro awareness helpers — peerColorFromId determinism.
 */

import { describe, it, expect } from 'vitest'
import { peerColorFromId } from './awareness.js'

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
