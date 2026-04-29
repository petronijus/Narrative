/**
 * media/s3Client.ts
 *
 * Shared MinIO S3 client config — same shape used by the tus plugin and
 * by ad-hoc PUT operations (e.g. deck thumbnail uploads). Keeping it
 * here avoids a circular import on tus.ts and keeps `MEDIA_BUCKET`
 * resolution centralised.
 */

import type { S3ClientConfig } from '@aws-sdk/client-s3'
import { S3Client } from '@aws-sdk/client-s3'

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
