import { describe, expect, it } from 'vitest'
import {
  CONNECT_TOKEN_SENTINEL,
  DOCUMENT_EPOCH_MESSAGE_TYPE,
  claimedDocumentEpoch,
  connectToken,
  formatDocumentEpoch,
  isDocumentEpoch,
  parseDocumentEpoch,
  parseDocumentEpochMessage,
} from './documentEpoch.js'

describe('document epoch wire format (ADR 0017)', () => {
  it('formats and parses the two parts', () => {
    const epoch = formatDocumentEpoch({ generation: 1792540000, docEpoch: 3 })
    expect(epoch).toBe('1792540000.3')
    expect(parseDocumentEpoch(epoch)).toEqual({ generation: 1792540000, docEpoch: 3 })
    expect(() => formatDocumentEpoch({ generation: 0, docEpoch: 1 })).toThrow()
    expect(() => formatDocumentEpoch({ generation: 1, docEpoch: 1.5 })).toThrow()
  })

  it('claims nothing for an empty document, an epoch otherwise, and reads it back', () => {
    expect(connectToken(null)).toBe(CONNECT_TOKEN_SENTINEL)
    expect(claimedDocumentEpoch(connectToken(null))).toBeNull()
    for (const epoch of ['1.1', '1792540000.2', '999999999999999.999999999999999']) {
      expect(claimedDocumentEpoch(connectToken(epoch))).toEqual(parseDocumentEpoch(epoch))
    }
  })

  it('refuses to claim what is not an epoch', () => {
    for (const bad of ['1', '0.1', '1.0', '1.1.1', '01.1', '1.1 ', 'a.b', '']) {
      expect(isDocumentEpoch(bad)).toBe(false)
      expect(() => connectToken(bad)).toThrow()
    }
    expect(isDocumentEpoch(3)).toBe(false)
  })

  it('reads any other token as no claim', () => {
    for (const token of [
      '',
      'cookie;',
      'cookie;epoch=',
      'cookie;epoch=1',
      'cookie;epoch=0.1',
      'cookie;epoch=1.1;x',
      ' cookie;epoch=1.1',
      'nrt_whatever',
      `cookie;epoch=1.${'9'.repeat(16)}`,
    ]) {
      expect(claimedDocumentEpoch(token)).toBeNull()
    }
  })

  it('parses the epoch message and nothing else', () => {
    const message = { type: DOCUMENT_EPOCH_MESSAGE_TYPE, documentName: 'deck-1', epoch: '5.3' }
    expect(parseDocumentEpochMessage(JSON.stringify(message))).toEqual(message)
    for (const payload of [
      undefined,
      42,
      'not json',
      JSON.stringify([message]),
      JSON.stringify({ ...message, type: 'narrative.agentPrincipal' }),
      JSON.stringify({ ...message, documentName: '' }),
      JSON.stringify({ ...message, documentName: 'x'.repeat(257) }),
      JSON.stringify({ ...message, epoch: 3 }),
      JSON.stringify({ ...message, epoch: '3' }),
    ]) {
      expect(parseDocumentEpochMessage(payload)).toBeNull()
    }
  })
})
