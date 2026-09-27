/**
 * agent/opRedaction.test.ts — what `agent_ops` keeps of an op's input and
 * result: no inline file bytes, no URL secrets, same structure.
 */

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { BASE64_HEURISTIC_MIN_CHARS, redactForAudit, stripUrlSecrets } from './opRedaction.js'

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

describe('redactForAudit', () => {
  it('replaces a { base64 } file source with the size and digest of the decoded bytes', () => {
    const input = { file: { base64: png.toString('base64'), filename: 'dot.png' } }
    expect(redactForAudit(input)).toEqual({
      file: {
        base64: { redacted: 'base64', bytes: png.byteLength, sha256: sha(png) },
        filename: 'dot.png',
      },
    })
  })

  it('replaces data: URLs under any key, base64 or percent-encoded', () => {
    const b64 = `data:image/png;base64,${png.toString('base64')}`
    const text = 'data:text/plain,hello%20world'
    expect(redactForAudit({ source: { base64: b64 }, other: text })).toEqual({
      source: {
        base64: {
          redacted: 'data-url',
          mediaType: 'image/png',
          bytes: png.byteLength,
          sha256: sha(png),
        },
      },
      other: {
        redacted: 'data-url',
        mediaType: 'text/plain',
        bytes: 11,
        sha256: sha(Buffer.from('hello world')),
      },
    })
  })

  it('catches long base64 under keys the schemas do not name yet, but leaves short strings', () => {
    const blob = Buffer.alloc(BASE64_HEURISTIC_MIN_CHARS, 7)
    const encoded = blob.toString('base64')
    const out = redactForAudit({ data: encoded, id: 'r1', colour: '#ff0000', b: 'QUJD' }) as Record<
      string,
      unknown
    >
    expect(out['data']).toEqual({ redacted: 'base64', bytes: blob.byteLength, sha256: sha(blob) })
    expect(out['id']).toBe('r1')
    expect(out['colour']).toBe('#ff0000')
    expect(out['b']).toBe('QUJD')
  })

  it('never treats long prose as base64', () => {
    const prose = 'word '.repeat(400)
    expect(redactForAudit({ text: prose })).toEqual({ text: prose })
  })

  it('strips query strings, fragments and credentials from URLs, keeping the path', () => {
    const input = {
      pptx: { url: 'https://files.example.com/deck.pptx?X-Amz-Signature=abc&token=s3cr3t#page=2' },
      link: 'https://user:pass@example.com/a/b',
      plain: 'https://example.com/ok',
    }
    expect(redactForAudit(input)).toEqual({
      pptx: { url: 'https://files.example.com/deck.pptx' },
      link: 'https://example.com/a/b',
      plain: 'https://example.com/ok',
    })
  })

  it('keeps the structure of an ops.apply batch and of results', () => {
    const batch = {
      atomic: true,
      ops: [
        { command: 'object.update', input: { slide: 's1', object: 'r1', patch: { x: 5 } } },
        {
          command: 'media.upload',
          input: { file: { url: 'https://cdn.example.com/a.png?sig=1' } },
        },
      ],
    }
    expect(redactForAudit(batch)).toEqual({
      atomic: true,
      ops: [
        { command: 'object.update', input: { slide: 's1', object: 'r1', patch: { x: 5 } } },
        { command: 'media.upload', input: { file: { url: 'https://cdn.example.com/a.png' } } },
      ],
    })
    const exportResult = {
      delivery: 'url',
      url: 'https://minio.example.com/narrative-media/decks/d1/exports/x/deck.pptx?X-Amz-Credential=k',
      sizeBytes: 10,
    }
    expect(redactForAudit(exportResult)).toEqual({
      delivery: 'url',
      url: 'https://minio.example.com/narrative-media/decks/d1/exports/x/deck.pptx',
      sizeBytes: 10,
    })
  })

  it('passes scalars, null and undefined through', () => {
    expect(redactForAudit(undefined)).toBeUndefined()
    expect(redactForAudit(null)).toBeNull()
    expect(redactForAudit(3)).toBe(3)
    expect(redactForAudit(true)).toBe(true)
    expect(redactForAudit('s1')).toBe('s1')
  })
})

describe('stripUrlSecrets', () => {
  it('leaves non-URLs and clean URLs untouched', () => {
    expect(stripUrlSecrets('not a url?x=1')).toBe('not a url?x=1')
    expect(stripUrlSecrets('ftp://example.com/?a')).toBe('ftp://example.com/?a')
    expect(stripUrlSecrets('https://example.com/a')).toBe('https://example.com/a')
  })

  it('still drops the query of an unparseable http URL', () => {
    expect(stripUrlSecrets('http://[bad/x?token=1')).toBe('http://[bad/x')
  })
})
