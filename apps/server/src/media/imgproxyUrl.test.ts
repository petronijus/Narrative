/**
 * media/imgproxyUrl.test.ts
 *
 * Tests for the imgproxy URL signing function.
 * Does not require a running imgproxy instance — purely unit tests.
 *
 * Key invariants verified:
 *   1. Deterministic: same input → same output
 *   2. storageKey change → different signature
 *   3. variant change → different URL path segment
 *   4. Signature uses URL-safe base64 without '=' padding
 *   5. Hex decode works for key + salt
 *   6. Invalid hex key/salt throws
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { signImgproxyUrl } from './imgproxyUrl.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// 32-byte key and salt as hex (deterministic, not secret — test-only)
const TEST_KEY = '0' + '1'.repeat(63) // 64 hex chars = 32 bytes (starts with 0 then 63 1s)
const TEST_SALT = 'deadbeef'.repeat(8) // 64 hex chars = 32 bytes

const STORAGE_KEY = 'decks/deck-abc/uploads/asset-xyz/original.jpg'
const BASE_URL = 'http://imgproxy.test'
const BUCKET = 'narrative-media'

// ---------------------------------------------------------------------------
// Env setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.stubEnv('IMGPROXY_KEY', TEST_KEY)
  vi.stubEnv('IMGPROXY_SALT', TEST_SALT)
  vi.stubEnv('IMGPROXY_ENDPOINT', BASE_URL)
  vi.stubEnv('MEDIA_BUCKET', BUCKET)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('signImgproxyUrl', () => {
  it('produces a URL string starting with the base URL', () => {
    const url = signImgproxyUrl({ storageKey: STORAGE_KEY })
    expect(url).toMatch(/^http:\/\/imgproxy\.test\//)
  })

  it('is deterministic: same input → same URL', () => {
    const a = signImgproxyUrl({ storageKey: STORAGE_KEY, variant: 'display' })
    const b = signImgproxyUrl({ storageKey: STORAGE_KEY, variant: 'display' })
    expect(a).toBe(b)
  })

  it('produces a different URL for a different storageKey', () => {
    const a = signImgproxyUrl({ storageKey: STORAGE_KEY })
    const b = signImgproxyUrl({ storageKey: 'decks/deck-abc/uploads/other/original.png' })
    expect(a).not.toBe(b)
  })

  it('includes the correct processing segment for thumb variant', () => {
    const url = signImgproxyUrl({ storageKey: STORAGE_KEY, variant: 'thumb' })
    expect(url).toContain('rs:fill:400:225:0/g:ce')
  })

  it('includes the correct processing segment for display variant', () => {
    const url = signImgproxyUrl({ storageKey: STORAGE_KEY, variant: 'display' })
    expect(url).toContain('rs:fit:1600:1600:0')
  })

  it('has no resize processing segment for original variant', () => {
    const url = signImgproxyUrl({ storageKey: STORAGE_KEY, variant: 'original' })
    expect(url).not.toContain('rs:')
    // Original variant URL is /{signature}/{base64_source}.{ext} — no processing.
    // Make sure no leftover /rs: or /g: style processing directive sneaks in.
    expect(url).not.toMatch(/\/(rs|g):/)
  })

  it('produces a different URL for different variants', () => {
    const thumb = signImgproxyUrl({ storageKey: STORAGE_KEY, variant: 'thumb' })
    const display = signImgproxyUrl({ storageKey: STORAGE_KEY, variant: 'display' })
    const original = signImgproxyUrl({ storageKey: STORAGE_KEY, variant: 'original' })
    expect(thumb).not.toBe(display)
    expect(display).not.toBe(original)
    expect(thumb).not.toBe(original)
  })

  it('defaults to display variant when variant is omitted', () => {
    const withDefault = signImgproxyUrl({ storageKey: STORAGE_KEY })
    const explicit = signImgproxyUrl({ storageKey: STORAGE_KEY, variant: 'display' })
    expect(withDefault).toBe(explicit)
  })

  it('defaults to webp extension when extension is omitted', () => {
    const url = signImgproxyUrl({ storageKey: STORAGE_KEY })
    expect(url).toMatch(/\.webp$/)
  })

  it('respects a custom extension', () => {
    const url = signImgproxyUrl({ storageKey: STORAGE_KEY, extension: 'jpg' })
    expect(url).toMatch(/\.jpg$/)
  })

  it('uses a custom baseUrl when provided', () => {
    const url = signImgproxyUrl({
      storageKey: STORAGE_KEY,
      baseUrl: 'https://custom.imgproxy.example.com',
    })
    expect(url).toMatch(/^https:\/\/custom\.imgproxy\.example\.com\//)
  })

  it('encodes the S3 source URL as URL-safe base64 in the path', () => {
    const url = signImgproxyUrl({ storageKey: STORAGE_KEY })
    const expectedSource = `s3://${BUCKET}/${STORAGE_KEY}`
    const encoded = Buffer.from(expectedSource, 'utf8').toString('base64url')
    expect(url).toContain(encoded)
    // The literal `s3://` form must not appear — browsers / proxies collapse
    // the double-slash and break the signature when it does.
    expect(url).not.toContain(`s3://${BUCKET}`)
  })

  it('signature segment is URL-safe base64 (no + / = characters)', () => {
    const url = signImgproxyUrl({ storageKey: STORAGE_KEY })
    // Extract the signature: second path segment after the base URL
    const withoutBase = url.slice(BASE_URL.length + 1) // remove "http://imgproxy.test/"
    const signature = withoutBase.split('/')[0]!
    expect(signature).toBeTruthy()
    // URL-safe base64 uses - and _ instead of + and / and has no = padding
    expect(signature).not.toMatch(/[+/=]/)
    expect(signature).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('throws when IMGPROXY_KEY is invalid hex', () => {
    vi.stubEnv('IMGPROXY_KEY', 'not-valid-hex!!')
    expect(() => signImgproxyUrl({ storageKey: STORAGE_KEY })).toThrow()
  })

  it('throws when IMGPROXY_SALT is invalid hex', () => {
    vi.stubEnv('IMGPROXY_SALT', 'xyz!!@@##')
    expect(() => signImgproxyUrl({ storageKey: STORAGE_KEY })).toThrow()
  })
})
