/**
 * pdf.test.ts — the picture PDF (A5.6): its JPEG header reading, and a file
 * that reads back — one page per picture, at the slide's size, every xref
 * offset at its object, the pictures embedded byte for byte — and that
 * `qpdf --check` accepts where qpdf is installed.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildImagePdf, jpegInfo } from './pdf.js'

/** 4 × 2 red, and 3 × 3 grey, made with sharp. */
const RED = Buffer.from(
  '/9j/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAACAAQDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABwj/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCWADpZb//Z',
  'base64',
)
const GREY = Buffer.from(
  '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAADAAMDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AAA//2Q==',
  'base64',
)

const latin1 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('latin1')

describe('jpegInfo', () => {
  it('reads the size and colour components from the frame header', () => {
    expect(jpegInfo(RED)).toEqual({ width: 4, height: 2, components: 3 })
    expect(jpegInfo(GREY)).toMatchObject({ width: 3, height: 3 })
  })

  it('refuses what is not a JPEG', () => {
    expect(() => jpegInfo(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toThrow(/not a JPEG/)
    expect(() => jpegInfo(RED.subarray(0, 20))).toThrow(/not a JPEG/)
  })
})

describe('buildImagePdf', () => {
  const pdf = buildImagePdf([{ jpeg: RED }, { jpeg: GREY }], { title: 'Q3 review – Board' })
  const text = latin1(pdf)

  it('has a page per picture at 16:9, the pictures embedded as they are', () => {
    expect(text.startsWith('%PDF-1.4\n')).toBe(true)
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true)
    expect(text.match(/\/Type \/Page /g)).toHaveLength(2)
    expect(text).toContain('/Count 2')
    expect(text).toContain('/MediaBox [0 0 960 540]')
    expect(text).toContain('/Width 4 /Height 2')
    expect(text).toContain('/Filter /DCTDecode')
    expect(text).toContain(latin1(RED))
    // A title outside ASCII is UTF-16 hex.
    expect(text).toMatch(/\/Title <FEFF[0-9A-F]+>/)
  })

  it('points every xref entry at its object, and startxref at the table', () => {
    const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(text)![1])
    expect(text.slice(startxref, startxref + 4)).toBe('xref')
    const entries = [...text.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) =>
      Number(m[1]),
    )
    expect(entries).toHaveLength(9)
    entries.forEach((offset, i) => expect(text.slice(offset, offset + 8)).toBe(`${i + 1} 0 obj\n`))
  })

  it('passes qpdf --check where qpdf is installed', () => {
    let hasQpdf = true
    try {
      execFileSync('qpdf', ['--version'], { stdio: 'ignore' })
    } catch {
      hasQpdf = false
    }
    if (!hasQpdf) return
    const dir = mkdtempSync(join(tmpdir(), 'narrative-pdf-'))
    try {
      const file = join(dir, 'deck.pdf')
      writeFileSync(file, pdf)
      expect(execFileSync('qpdf', ['--check', file]).toString()).toContain(
        'No syntax or stream encoding errors',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('escapes a title so it cannot leave its string', () => {
    const text = latin1(buildImagePdf([{ jpeg: RED }], { title: 'a) /JavaScript (x \\' }))
    expect(text).toContain('/Title (a\\) /JavaScript \\(x \\\\)')
    const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(text)![1])
    expect(text.slice(startxref, startxref + 4)).toBe('xref')
  })

  it('needs a page', () => {
    expect(() => buildImagePdf([])).toThrow(/at least one page/)
  })
})
