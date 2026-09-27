/**
 * media/uploadPolicy.test.ts — storage-key extensions (M5): whatever the
 * client calls its file, the extension that lands in an S3 key is 1–8
 * lower-case ASCII letters or digits, or `bin`.
 */

import { describe, it, expect } from 'vitest'
import { extensionFromMimeOrFilename } from './uploadPolicy.js'

describe('extensionFromMimeOrFilename', () => {
  it('prefers the MIME map', () => {
    expect(extensionFromMimeOrFilename('image/jpeg', 'photo.exe')).toBe('jpg')
    expect(extensionFromMimeOrFilename('video/quicktime')).toBe('mov')
  })

  it('keeps a plain filename extension, lower-cased', () => {
    expect(extensionFromMimeOrFilename('application/octet-stream', 'Brand.OTF')).toBe('otf')
    expect(extensionFromMimeOrFilename('', 'clip.m4v')).toBe('m4v')
  })

  it.each([
    'x./../../etc',
    'evil.png/../../x',
    'a.p%2fng',
    'a.png ',
    'a.pn g',
    'a.ünï',
    'a.abcdefghi',
    'a.',
    'a.png\u0000',
    'a.PNG\n',
  ])('falls back to bin for %j', (filename) => {
    expect(extensionFromMimeOrFilename('application/octet-stream', filename)).toBe('bin')
  })

  it('falls back to bin without a usable name', () => {
    expect(extensionFromMimeOrFilename('application/x-unknown')).toBe('bin')
    expect(extensionFromMimeOrFilename('application/x-unknown', 'README')).toBe('bin')
  })

  it('only ever returns a safe extension', () => {
    const samples = ['a.b/c', 'a.tar.gz', 'a.‮gnp', 'a.ZIP', 'x.' + 'y'.repeat(20)]
    for (const name of samples) {
      expect(extensionFromMimeOrFilename('', name)).toMatch(/^[a-z0-9]{1,8}$/)
    }
  })
})
