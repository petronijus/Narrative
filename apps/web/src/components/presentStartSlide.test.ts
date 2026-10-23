// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { presentStartSlideId } from './presentStartSlide'

const slides = [{ id: 's1' }, { id: 's2' }, { id: 's3' }]

describe('presentStartSlideId', () => {
  it('maps a 1-based slide number to that slide', () => {
    expect(presentStartSlideId('1', slides)).toBe('s1')
    expect(presentStartSlideId('3', slides)).toBe('s3')
    expect(presentStartSlideId(' 2 ', slides)).toBe('s2')
  })

  it('clamps a number past the end to the last slide', () => {
    expect(presentStartSlideId('4', slides)).toBe('s3')
    expect(presentStartSlideId('9'.repeat(400), slides)).toBe('s3')
  })

  it.each([null, '', '0', '-1', '1.5', '2e1', 'abc', '0x2'])('ignores %j', (param) => {
    expect(presentStartSlideId(param, slides)).toBeNull()
  })

  it('returns null for an empty deck', () => {
    expect(presentStartSlideId('1', [])).toBeNull()
  })
})
