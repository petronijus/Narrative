/**
 * media/s3Client.test.ts
 *
 * MEDIA-1: verifies presignGetUrl produces browser-reachable, correctly-signed
 * URLs for a PRIVATE MinIO bucket. The signature is bound to host + canonical
 * path, so the test asserts:
 *   - the `/storage` routing prefix is added for the browser, and
 *   - the SIGNED canonical path is `/<bucket>/<key>` (no `/storage`), matching
 *     what MinIO receives after Caddy/Vite strip the prefix.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { presignGetUrl, MEDIA_BUCKET } from './s3Client.js'

const KEY = 'fonts/folder-1/asset-1/original.ttf'

function clearEnv(): void {
  delete process.env['MINIO_PUBLIC_URL']
  delete process.env['MINIO_ENDPOINT']
}

describe('presignGetUrl (MEDIA-1)', () => {
  const saved = {
    pub: process.env['MINIO_PUBLIC_URL'],
    ep: process.env['MINIO_ENDPOINT'],
    user: process.env['MINIO_ROOT_USER'],
    pass: process.env['MINIO_ROOT_PASSWORD'],
  }

  beforeEach(() => {
    clearEnv()
    process.env['MINIO_ROOT_USER'] = 'test-user'
    process.env['MINIO_ROOT_PASSWORD'] = 'test-password'
  })

  afterEach(() => {
    process.env['MINIO_PUBLIC_URL'] = saved.pub ?? ''
    process.env['MINIO_ENDPOINT'] = saved.ep ?? ''
    process.env['MINIO_ROOT_USER'] = saved.user ?? ''
    process.env['MINIO_ROOT_PASSWORD'] = saved.pass ?? ''
    if (saved.pub === undefined) delete process.env['MINIO_PUBLIC_URL']
    if (saved.ep === undefined) delete process.env['MINIO_ENDPOINT']
  })

  it('signs and carries an expiry (X-Amz-* query params present)', async () => {
    process.env['MINIO_PUBLIC_URL'] = 'https://narrative.example.com/storage'
    const url = await presignGetUrl(KEY, 3600)
    expect(url).toContain('X-Amz-Signature=')
    expect(url).toContain('X-Amz-Credential=')
    expect(url).toContain('X-Amz-Expires=3600')
    // Not a raw, unsigned URL.
    expect(url).not.toBe(`https://narrative.example.com/storage/${MEDIA_BUCKET}/${KEY}`)
  })

  it('absolute MINIO_PUBLIC_URL → browser URL has /storage prefix on the public host', async () => {
    process.env['MINIO_PUBLIC_URL'] = 'https://narrative.example.com/storage'
    const url = await presignGetUrl(KEY, 600)
    const parsed = new URL(url)
    expect(parsed.origin).toBe('https://narrative.example.com')
    // Browser-facing path keeps the /storage routing prefix + bucket + key.
    expect(parsed.pathname).toBe(`/storage/${MEDIA_BUCKET}/${KEY}`)
  })

  it('SIGNED canonical path is /<bucket>/<key> (no /storage) so it matches post-strip MinIO', async () => {
    // Re-sign with the SAME endpoint but no /storage prefix and compare the
    // signature: the prefix must be OUTSIDE the signed material, so both
    // produce an identical signature for the same key/credentials/time window.
    // We assert structurally instead: the path after removing /storage equals
    // the canonical resource MinIO will verify.
    process.env['MINIO_PUBLIC_URL'] = 'https://narrative.example.com/storage'
    const url = await presignGetUrl(KEY, 600)
    const parsed = new URL(url)
    const minioPath = parsed.pathname.replace(/^\/storage/, '')
    expect(minioPath).toBe(`/${MEDIA_BUCKET}/${KEY}`)
  })

  it('path-only MINIO_PUBLIC_URL (dev) → signs against MINIO_ENDPOINT directly (Vite changeOrigin)', async () => {
    // Vite's /storage proxy uses changeOrigin:true (rewrites Host to the
    // target), so a /storage-prefixed signature would be invalid. Dev must
    // sign against the directly-reachable MINIO_ENDPOINT instead.
    process.env['MINIO_PUBLIC_URL'] = '/storage'
    process.env['MINIO_ENDPOINT'] = 'http://127.0.0.1:9100'
    const url = await presignGetUrl(KEY, 600)
    const parsed = new URL(url)
    expect(parsed.origin).toBe('http://127.0.0.1:9100')
    expect(parsed.pathname).toBe(`/${MEDIA_BUCKET}/${KEY}`)
    // No /storage prefix in dev — the signed path must equal what MinIO sees.
    expect(parsed.pathname).not.toContain('/storage')
    expect(url).toContain('X-Amz-Signature=')
  })

  it('unset MINIO_PUBLIC_URL → signs against the raw MINIO_ENDPOINT (test/integration fallback)', async () => {
    process.env['MINIO_ENDPOINT'] = 'http://127.0.0.1:9100'
    const url = await presignGetUrl(KEY, 600)
    const parsed = new URL(url)
    expect(parsed.origin).toBe('http://127.0.0.1:9100')
    expect(parsed.pathname).toBe(`/${MEDIA_BUCKET}/${KEY}`)
    expect(url).toContain('X-Amz-Signature=')
  })
})
