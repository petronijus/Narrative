/**
 * media/bucketCleanup.integration.test.ts — a storage purge really removes
 * the files, against the MinIO the stack runs. Until 2026-10-02 every batch
 * delete was refused with `MissingContentMD5` (the SDK no longer sends an
 * MD5, this MinIO wants one — media/s3Client.ts) and only logged, so deleted
 * decks, components and folders left all their files behind. Excluded from
 * `pnpm test`; run with `just integration` (the docker services up).
 */

import { describe, expect, it } from 'vitest'
import { nanoid } from 'nanoid'
import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { buildS3Client, MEDIA_BUCKET } from './s3Client.js'
import { purgeExplicitKeys } from './bucketCleanup.js'

const s3 = buildS3Client()
const log = { info() {}, warn() {} }

async function stored(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: MEDIA_BUCKET, Key: key }))
    return true
  } catch {
    return false
  }
}

describe('purgeExplicitKeys against MinIO', () => {
  it('removes the files, and reports no errors', async () => {
    const keys = [0, 1].map((i) => `it-purge/${nanoid(10)}/file-${i}.bin`)
    for (const Key of keys) {
      await s3.send(new PutObjectCommand({ Bucket: MEDIA_BUCKET, Key, Body: Buffer.from('x') }))
    }
    expect(await stored(keys[0]!)).toBe(true)

    const result = await purgeExplicitKeys(keys, log)
    expect(result.errors).toBe(0)
    for (const key of keys) expect(await stored(key)).toBe(false)
  })
})
