/**
 * media/multipartUpload.ts — a Writable that stores what is written into it
 * as one object of the media bucket, through a multipart upload.
 *
 * For outputs produced as a stream (the PowerPoint export, pptx/zipWriter.ts):
 * at most one part is buffered and one in flight, so memory stays at about
 * two part sizes whatever the object's size, and the writer upstream is held
 * back while a part uploads. Ended, the upload is completed (an object with
 * the type, disposition and caching given); destroyed with an error, it is
 * aborted, so no parts are left behind in the bucket — also when the destroy
 * comes while the upload is still being created, or while a part is on its
 * way (the abort waits for both). A process killed before it could abort
 * leaves the parts to MinIO's own clean-up of incomplete uploads (a day,
 * infra/docker-compose.yml `MINIO_API_STALE_UPLOADS_EXPIRY`, docs/storage.md).
 */

import { Writable } from 'node:stream'
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  type CompletedPart,
  type S3Client,
} from '@aws-sdk/client-s3'

/** S3's smallest part but the last one is 5 MiB; larger parts mean fewer round trips. */
export const MULTIPART_PART_BYTES = 8 * 1024 * 1024

export interface MultipartTarget {
  s3: Pick<S3Client, 'send'>
  bucket: string
  key: string
  contentType: string
  contentDisposition?: string
  cacheControl?: string
  /** Part size (tests); at least 5 MiB against a real S3. */
  partBytes?: number
}

export function multipartUploadStream(target: MultipartTarget): Writable {
  const partBytes = target.partBytes ?? MULTIPART_PART_BYTES
  /** The upload's creation, once asked for: kept so a destroy during it still aborts. */
  let beginning: Promise<string> | undefined
  /** The part upload or completion in flight: a destroy waits for it before it aborts. */
  let busy: Promise<unknown> | undefined
  let completed = false
  let destroyed = false
  const parts: CompletedPart[] = []
  let pending: Buffer[] = []
  let pendingBytes = 0

  const begin = (): Promise<string> => {
    beginning ??= target.s3
      .send(
        new CreateMultipartUploadCommand({
          Bucket: target.bucket,
          Key: target.key,
          ContentType: target.contentType,
          ...(target.contentDisposition !== undefined
            ? { ContentDisposition: target.contentDisposition }
            : {}),
          ...(target.cacheControl !== undefined ? { CacheControl: target.cacheControl } : {}),
        }),
      )
      .then((created) => {
        if (created.UploadId === undefined) throw new Error('multipart upload: no upload id')
        return created.UploadId
      })
    return beginning
  }

  const flush = async (): Promise<void> => {
    const body = Buffer.concat(pending, pendingBytes)
    pending = []
    pendingBytes = 0
    const id = await begin()
    if (destroyed) throw new Error('multipart upload: destroyed')
    const PartNumber = parts.length + 1
    const sent = await target.s3.send(
      new UploadPartCommand({
        Bucket: target.bucket,
        Key: target.key,
        UploadId: id,
        PartNumber,
        Body: body,
        ContentLength: body.byteLength,
      }),
    )
    parts.push({ PartNumber, ETag: sent.ETag })
  }

  /** Run `op` as the one operation in flight. */
  const track = (op: Promise<void>, done: (err?: Error | null) => void): void => {
    busy = op
    op.then(
      () => done(),
      (err: Error) => done(err),
    )
  }

  return new Writable({
    write(chunk: Buffer, _encoding, done) {
      pending.push(chunk)
      pendingBytes += chunk.byteLength
      if (pendingBytes < partBytes) {
        done()
        return
      }
      track(flush(), done)
    },
    final(done) {
      // The last part may be smaller than the rest (an empty object is one empty part).
      const finish = async (): Promise<void> => {
        if (pendingBytes > 0 || parts.length === 0) await flush()
        const id = await begin()
        if (destroyed) throw new Error('multipart upload: destroyed')
        await target.s3.send(
          new CompleteMultipartUploadCommand({
            Bucket: target.bucket,
            Key: target.key,
            UploadId: id,
            MultipartUpload: { Parts: parts },
          }),
        )
        completed = true
      }
      track(finish(), done)
    },
    destroy(err, done) {
      destroyed = true
      pending = []
      // Whatever is in flight ends first (a part sent after the abort would
      // be stored again); then an upload that was begun — or is being begun
      // — is aborted, so no parts are left behind in the bucket.
      const abort = async (): Promise<void> => {
        await busy?.catch(() => undefined)
        if (beginning === undefined || completed) return
        const id = await beginning.catch(() => undefined)
        if (id === undefined) return
        await target.s3
          .send(
            new AbortMultipartUploadCommand({
              Bucket: target.bucket,
              Key: target.key,
              UploadId: id,
            }),
          )
          .catch(() => undefined)
      }
      void abort().then(() => done(err))
    },
  })
}
