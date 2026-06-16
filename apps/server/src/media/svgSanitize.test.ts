/**
 * media/svgSanitize.test.ts
 *
 * Unit tests for the XSS-3 content-sanitization helpers. These are pure
 * functions (no S3), so they run without any mock storage.
 */

import { describe, it, expect } from 'vitest'
import { sanitizeSvg, sniffIsSvg, magicBytesMatch, MAGIC_CHECKED_MIMES } from './svgSanitize.js'

const buf = (s: string): Buffer => Buffer.from(s, 'utf8')

describe('sanitizeSvg — hostile content stripping', () => {
  it('strips <script>, on* handlers, <foreignObject>, and javascript: href', () => {
    const hostile = buf(`<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="100" height="100">
  <script>alert(document.cookie)</script>
  <rect width="100" height="100" onload="alert(1)" onclick="steal()" fill="red"/>
  <foreignObject width="100" height="100"><body xmlns="http://www.w3.org/1999/xhtml"><img src=x onerror="alert(2)"></body></foreignObject>
  <a href="javascript:alert(3)"><text x="10" y="20">click</text></a>
  <a xlink:href="javascript:alert(4)">x</a>
</svg>`)

    const out = sanitizeSvg(hostile)
    expect(out).not.toBeNull()
    const text = out!.toString('utf8').toLowerCase()

    // Active content must be gone.
    expect(text).not.toContain('<script')
    expect(text).not.toContain('alert(')
    expect(text).not.toContain('onload')
    expect(text).not.toContain('onclick')
    expect(text).not.toContain('onerror')
    expect(text).not.toContain('foreignobject')
    expect(text).not.toContain('javascript:')

    // The root <svg> survives.
    expect(text).toContain('<svg')
  })

  it('strips external-document href but keeps internal #fragment and data:image refs', () => {
    const svg =
      buf(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
  <image href="https://evil.example/track.png" width="10" height="10"/>
  <image href="data:image/png;base64,AAAA" width="10" height="10"/>
  <a href="#section">go</a>
</svg>`)

    const out = sanitizeSvg(svg)
    expect(out).not.toBeNull()
    const text = out!.toString('utf8')

    // External http(s) ref dropped by the afterSanitizeAttributes hook.
    expect(text).not.toContain('evil.example')
    expect(text).not.toContain('https://')
    // Safe internal #fragment + data:image refs preserved.
    expect(text).toContain('#section')
    expect(text).toContain('data:image/png')
  })

  it('rejects an SVG that is pure payload (nothing graphic survives)', () => {
    const payload = buf('<script>alert(1)</script>')
    expect(sanitizeSvg(payload)).toBeNull()
  })

  it('rejects empty / whitespace-only input', () => {
    expect(sanitizeSvg(buf(''))).toBeNull()
    expect(sanitizeSvg(buf('   \n\t '))).toBeNull()
  })
})

describe('sanitizeSvg — benign content preservation', () => {
  it('preserves paths, gradients, and <text>', () => {
    const benign = buf(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <defs>
    <linearGradient id="g1" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#ff0000"/>
      <stop offset="100%" stop-color="#0000ff"/>
    </linearGradient>
  </defs>
  <path d="M10 10 H 90 V 90 H 10 Z" fill="url(#g1)"/>
  <circle cx="100" cy="100" r="40" fill="green"/>
  <text x="20" y="180" font-size="14">Hello</text>
</svg>`)

    const out = sanitizeSvg(benign)
    expect(out).not.toBeNull()
    const text = out!.toString('utf8')

    expect(text).toContain('<path')
    // SVG is case-sensitive and DOMPurify preserves camelCase element names.
    expect(text).toContain('linearGradient')
    expect(text).toContain('<stop')
    expect(text).toContain('<text')
    expect(text).toContain('Hello')
    expect(text).toContain('url(#g1)')
  })
})

describe('sniffIsSvg', () => {
  it('detects a bare <svg> root', () => {
    expect(sniffIsSvg(buf('<svg xmlns="..."><rect/></svg>'))).toBe(true)
  })
  it('detects an xml prolog', () => {
    expect(sniffIsSvg(buf('<?xml version="1.0"?>\n<svg></svg>'))).toBe(true)
  })
  it('detects SVG after leading whitespace/comments', () => {
    expect(sniffIsSvg(buf('  <!-- hi -->\n<svg></svg>'))).toBe(true)
  })
  it('does not flag a PNG header', () => {
    expect(sniffIsSvg(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(false)
  })
})

describe('magicBytesMatch — raster signature validation', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
  const GIF89 = Buffer.from('GIF89a\x00\x00', 'latin1')
  const WEBP = Buffer.concat([
    Buffer.from('RIFF', 'latin1'),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from('WEBP', 'latin1'),
  ])
  // ISO-BMFF avif: size(4) + 'ftyp' + 'avif' brand
  const AVIF = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x20]),
    Buffer.from('ftypavif', 'latin1'),
    Buffer.alloc(8),
  ])
  // A Windows PE / shell-script-shaped blob masquerading as a png.
  const PE = Buffer.from('MZ\x90\x00\x03\x00\x00\x00', 'latin1')
  const SHELL = Buffer.from('#!/bin/sh\necho pwned\n', 'utf8')

  it('accepts real signatures matching declared MIME', () => {
    expect(magicBytesMatch('image/png', PNG)).toBe(true)
    expect(magicBytesMatch('image/jpeg', JPEG)).toBe(true)
    expect(magicBytesMatch('image/gif', GIF89)).toBe(true)
    expect(magicBytesMatch('image/webp', WEBP)).toBe(true)
    expect(magicBytesMatch('image/avif', AVIF)).toBe(true)
  })

  it('rejects a declared image/png whose bytes are a PE binary', () => {
    expect(magicBytesMatch('image/png', PE)).toBe(false)
  })

  it('rejects a declared image/png whose bytes are a shell script', () => {
    expect(magicBytesMatch('image/png', SHELL)).toBe(false)
  })

  it('rejects a JPEG masquerading as PNG', () => {
    expect(magicBytesMatch('image/png', JPEG)).toBe(false)
  })

  it('returns true (no opinion) for MIME types it does not magic-check', () => {
    expect(magicBytesMatch('image/svg+xml', SHELL)).toBe(true)
    expect(magicBytesMatch('image/tiff', SHELL)).toBe(true)
  })

  it('MAGIC_CHECKED_MIMES covers the raster set', () => {
    for (const m of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']) {
      expect(MAGIC_CHECKED_MIMES.has(m)).toBe(true)
    }
  })
})
