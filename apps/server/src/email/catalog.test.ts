/**
 * email/catalog.test.ts — every kind of email in the catalog renders in the
 * shared look: a subject, the tagline, one button with its link in the
 * plaintext too, nothing unescaped, no invented subline.
 */

import { describe, it, expect } from 'vitest'
import { EMAIL_CATALOG, EMAIL_KINDS, isEmailKind } from './catalog.js'
import { TAGLINE, renderEmail } from './layout.js'

describe('the email catalog', () => {
  it('lists every kind once', () => {
    expect(EMAIL_CATALOG.map((k) => k.kind)).toEqual([...EMAIL_KINDS])
    expect(isEmailKind('deleted')).toBe(true)
    expect(isEmailKind('spam')).toBe(false)
  })

  it.each(EMAIL_CATALOG.map((k) => [k.kind, k] as const))(
    '%s renders in the shared look',
    (_kind, info) => {
      const m = info.preview('https://narrative.example')
      expect(m.subject.length).toBeGreaterThan(10)
      expect(m.html).toContain(`Narrative</strong> &middot; ${TAGLINE}`)
      expect(m.text).toContain(`Narrative · ${TAGLINE}`)
      expect(m.html).toContain('https://narrative.example/apple-touch-icon.png')
      expect(m.html).not.toMatch(/made together/i)
      // The button's link is in the plaintext too.
      const href = /<a href="([^"]+)"/.exec(m.html)?.[1]
      expect(href).toBeDefined()
      expect(m.text).toContain(href!.replace(/&amp;/g, '&'))
    },
  )
})

describe('renderEmail', () => {
  it('escapes everything it is given', () => {
    const m = renderEmail({
      subject: '<x>',
      preheader: '<p>',
      actor: { name: '<b>Eve</b>', email: 'e@x.cz' },
      eyebrow: '<i>',
      headline: '"><script>alert(1)</script>',
      summary: { text: '<img src=x>', badge: { label: '<u>' } },
      cta: { label: '<s>', url: 'https://x.example/" onclick="alert(1)' },
      note: '**<b>bold</b>**',
      reason: '<em>',
      textIntro: 'intro',
      textLines: [],
    })
    expect(m.html).not.toContain('<script>')
    expect(m.html).not.toContain('<b>Eve</b>')
    expect(m.html).not.toContain('" onclick="')
    expect(m.html).not.toContain('<img src=x>')
    expect(m.html).toContain(
      '<strong style="color:#3f3d39;font-weight:600;">&lt;b&gt;bold&lt;/b&gt;</strong>',
    )
  })
})
