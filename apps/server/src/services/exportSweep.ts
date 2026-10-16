/**
 * services/exportSweep.ts
 *
 * Periodic cleanup of export packages (`decks/<deckId>/exports/…` in the
 * media bucket, and `components/<componentId>/exports/…`, where a render of a
 * master's card waits to be read back). `deck.exportPptx` with `delivery: "url"` stores the .pptx
 * there and hands out a presigned link valid for 15 minutes; the object has
 * no use after that. services/pptx.ts already sweeps a deck's old exports
 * when the SAME deck is exported again, which leaves the last export of every
 * deck (and every export of a deck nobody exports again) in the bucket
 * forever. This sweep walks every deck prefix and deletes export objects
 * older than `EXPORT_MAX_AGE_MS` (1 day — far past the link lifetime, so a
 * download in progress is never cut off).
 *
 * How it walks: one delimited listing of `decks/` yields each deck prefix
 * (including prefixes of decks whose own purge on deletion failed), then one
 * listing of `<prefix>exports/` per deck. It never lists thumbnails or video
 * outputs, so its cost is one small request per deck per run.
 *
 * Scheduled by the agent runtime (agent/runtime.ts): a few minutes after
 * start, then every `EXPORT_SWEEP_INTERVAL_MS`. Loss-tolerant: a failed page
 * is logged and the sweep moves on; the next run retries.
 */

import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
  type ObjectIdentifier,
} from '@aws-sdk/client-s3'
import type { FastifyBaseLogger } from 'fastify'

/** Export objects older than this are deleted. */
export const EXPORT_MAX_AGE_MS = 24 * 60 * 60 * 1000
/** How often the sweep runs. */
export const EXPORT_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000
/** DeleteObjects accepts at most 1000 keys per request. */
const DELETE_BATCH = 1000
const OWNER_PREFIXES = ['decks/', 'components/'] as const

/** The one S3 client method the sweep uses (an `S3Client` satisfies it). */
export interface ExportSweepS3 {
  send(command: ListObjectsV2Command | DeleteObjectsCommand): Promise<unknown>
}

async function list(s3: ExportSweepS3, command: ListObjectsV2Command) {
  return (await s3.send(command)) as ListObjectsV2CommandOutput
}

export interface ExportSweepOptions {
  s3: ExportSweepS3
  bucket: string
  log: Pick<FastifyBaseLogger, 'warn' | 'info'>
  now?: () => Date
  maxAgeMs?: number
}

export interface ExportSweepResult {
  /** Deck prefixes whose exports folder was examined. */
  decks: number
  /** Component prefixes whose exports folder was examined. */
  components: number
  /** Export objects deleted. */
  deleted: number
  /** Listing or delete requests that failed (logged; retried next run). */
  failures: number
}

async function* ownerPrefixes(
  s3: ExportSweepS3,
  bucket: string,
  root: string,
): AsyncGenerator<string, void, undefined> {
  let token: string | undefined
  do {
    const page = await list(
      s3,
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: root,
        Delimiter: '/',
        ContinuationToken: token,
      }),
    )
    for (const p of page.CommonPrefixes ?? []) {
      if (p.Prefix !== undefined && p.Prefix.startsWith(root)) yield p.Prefix
    }
    token = page.IsTruncated === true ? page.NextContinuationToken : undefined
  } while (token !== undefined)
}

/** Delete one deck's or component's export objects older than `cutoffMs`. Returns how many were deleted. */
async function sweepDeck(
  s3: ExportSweepS3,
  bucket: string,
  deckPrefix: string,
  cutoffMs: number,
): Promise<number> {
  let deleted = 0
  let token: string | undefined
  do {
    const page = await list(
      s3,
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: `${deckPrefix}exports/`,
        ContinuationToken: token,
      }),
    )
    const stale: ObjectIdentifier[] = (page.Contents ?? [])
      .filter((o) => o.Key !== undefined && (o.LastModified?.getTime() ?? 0) < cutoffMs)
      .map((o) => ({ Key: o.Key! }))
    for (let i = 0; i < stale.length; i += DELETE_BATCH) {
      const objects = stale.slice(i, i + DELETE_BATCH)
      await s3.send(
        new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }),
      )
      deleted += objects.length
    }
    token = page.IsTruncated === true ? page.NextContinuationToken : undefined
  } while (token !== undefined)
  return deleted
}

/** One pass over every deck's and component's exports. Never throws. */
export async function sweepExpiredExports(opts: ExportSweepOptions): Promise<ExportSweepResult> {
  const now = (opts.now ?? (() => new Date()))().getTime()
  const cutoffMs = now - (opts.maxAgeMs ?? EXPORT_MAX_AGE_MS)
  const result: ExportSweepResult = { decks: 0, components: 0, deleted: 0, failures: 0 }
  for (const root of OWNER_PREFIXES) {
    try {
      for await (const prefix of ownerPrefixes(opts.s3, opts.bucket, root)) {
        if (root === 'decks/') result.decks++
        else result.components++
        try {
          result.deleted += await sweepDeck(opts.s3, opts.bucket, prefix, cutoffMs)
        } catch (err) {
          result.failures++
          opts.log.warn({ err, prefix }, 'export sweep: cleaning exports failed')
        }
      }
    } catch (err) {
      result.failures++
      opts.log.warn({ err, root }, 'export sweep: listing failed')
    }
  }
  if (result.deleted > 0 || result.failures > 0) {
    opts.log.info({ ...result }, 'export sweep finished')
  }
  return result
}
