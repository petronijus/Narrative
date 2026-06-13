/**
 * shared/src/sanitize.test.ts
 *
 * Tests for sanitizeHref — the hyperlink-target trust boundary used by
 * Present mode (window.open) and PPTX import.
 */

import { describe, it, expect } from 'vitest'
import { sanitizeHref } from './sanitize.js'

describe('sanitizeHref', () => {
  it('passes http/https URLs through (parser-normalised)', () => {
    expect(sanitizeHref('https://example.com')).toBe('https://example.com/')
    expect(sanitizeHref('http://example.com/path?q=1')).toBe('http://example.com/path?q=1')
  })

  it('allows mailto:', () => {
    expect(sanitizeHref('mailto:a@b.com')).toBe('mailto:a@b.com')
  })

  it('prepends https:// to bare hosts/paths', () => {
    expect(sanitizeHref('example.com')).toBe('https://example.com/')
    expect(sanitizeHref('example.com/deck/x')).toBe('https://example.com/deck/x')
  })

  it('rejects javascript: in every casing/whitespace disguise', () => {
    expect(sanitizeHref('javascript:alert(1)')).toBeNull()
    expect(sanitizeHref('JavaScript:alert(1)')).toBeNull()
    expect(sanitizeHref('JAVASCRIPT:alert(1)')).toBeNull()
    expect(sanitizeHref('  javascript:alert(1)  ')).toBeNull()
    // Embedded tab/newline tricks that browsers strip before scheme parsing.
    expect(sanitizeHref('java\tscript:alert(1)')).toBeNull()
    expect(sanitizeHref('java\nscript:alert(1)')).toBeNull()
  })

  it('rejects data:, vbscript:, file: and other disallowed schemes', () => {
    expect(sanitizeHref('data:text/html,<script>alert(1)</script>')).toBeNull()
    expect(sanitizeHref('vbscript:msgbox(1)')).toBeNull()
    expect(sanitizeHref('file:///etc/passwd')).toBeNull()
  })

  it('rejects protocol-relative URLs', () => {
    expect(sanitizeHref('//evil.example.com')).toBeNull()
  })

  it('rejects empty/whitespace/garbage', () => {
    expect(sanitizeHref('')).toBeNull()
    expect(sanitizeHref('   ')).toBeNull()
    expect(sanitizeHref('http://')).toBeNull()
  })
})
