/**
 * media/s3Client.ts
 *
 * Shared MinIO S3 client config — same shape used by the tus plugin and
 * by ad-hoc PUT operations (e.g. deck thumbnail uploads). Keeping it
 * here avoids a circular import on tus.ts and keeps `MEDIA_BUCKET`
 * resolution centralised.
 */

import type { S3ClientConfig } from '@aws-sdk/client-s3'
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

export { PutObjectCommand, DeleteObjectCommand }

export const MEDIA_BUCKET = process.env['MEDIA_BUCKET'] ?? 'narrative-media'

export function buildS3Config(): S3ClientConfig {
  const endpoint = process.env['MINIO_ENDPOINT']
  const base: S3ClientConfig = {
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env['MINIO_ROOT_USER'] ?? '',
      secretAccessKey: process.env['MINIO_ROOT_PASSWORD'] ?? '',
    },
  }
  if (endpoint !== undefined) {
    return { ...base, endpoint }
  }
  return base
}

export function buildS3Client(): S3Client {
  return new S3Client(buildS3Config())
}

/**
 * Generates a presigned GET URL for a MinIO object.
 * Valid for `expiresIn` seconds (default 3600 — 1 h).
 *
 * In dev (public bucket), the URL will work but also be accessible without
 * signing. In prod, bucket policy should be private and this URL is the
 * only way browsers can reach the file.
 *
 * TODO(M29): unify with the HLS manifest URL approach when bucket turns private.
 */
export async function presignGetUrl(key: string, expiresIn = 3600): Promise<string> {
  const s3 = buildS3Client()
  const cmd = new GetObjectCommand({ Bucket: MEDIA_BUCKET, Key: key })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return getSignedUrl(s3 as any, cmd, { expiresIn })
}
