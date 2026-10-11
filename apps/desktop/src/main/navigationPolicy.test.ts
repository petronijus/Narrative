import { describe, expect, it } from 'vitest'
import { classifyNavigation, isExternalUrl, isPresenterPopup } from './navigationPolicy.js'

const SERVER = 'https://narrative.example.com'

describe('navigation policy', () => {
  it.each([
    [`${SERVER}/`, 'allow'],
    [`${SERVER}/deck/abc/render`, 'allow'],
    ['https://example.com/', 'external'],
    ['http://example.com/', 'external'],
    ['mailto:someone@example.com', 'external'],
    // Same host, other port or scheme: another origin.
    ['https://narrative.example.com:8443/', 'external'],
    ['http://narrative.example.com/', 'external'],
    ['file:///etc/passwd', 'block'],
    ['javascript:alert(1)', 'block'],
    ['data:text/html,<p>x</p>', 'block'],
    ['narrative://auth/complete?ticket=x', 'block'],
    ['not a url', 'block'],
  ])('%s → %s', (url, verdict) => {
    expect(classifyNavigation(url, SERVER)).toBe(verdict)
  })

  it('allows nothing in before a server is loaded', () => {
    expect(classifyNavigation(`${SERVER}/`, null)).toBe('external')
  })

  it('recognises the presenter popup only on the server', () => {
    expect(isPresenterPopup(`${SERVER}/deck/abc_123/present?presenter=1`, SERVER)).toBe(true)
    expect(isPresenterPopup(`${SERVER}/deck/abc/present`, SERVER)).toBe(false)
    expect(isPresenterPopup(`${SERVER}/deck/abc/present?presenter=0`, SERVER)).toBe(false)
    expect(isPresenterPopup(`${SERVER}/deck/a%2Fb/present?presenter=1`, SERVER)).toBe(false)
    expect(isPresenterPopup('https://evil.example/deck/abc/present?presenter=1', SERVER)).toBe(
      false,
    )
  })

  it('hands only web and mail links to the system', () => {
    expect(isExternalUrl('https://example.com')).toBe(true)
    expect(isExternalUrl('mailto:a@b.c')).toBe(true)
    expect(isExternalUrl('file:///etc/passwd')).toBe(false)
    expect(isExternalUrl('smb://host/share')).toBe(false)
  })
})
