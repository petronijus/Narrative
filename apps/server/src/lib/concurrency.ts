/**
 * lib/concurrency.ts — bounded parallelism for I/O-bound batches.
 *
 * `mapConcurrent` is `Promise.all(items.map(fn))` with at most `limit` calls
 * in flight: uploads to the object store, sharp jobs on libuv's thread pool,
 * inflating zip entries. Results come back in input order whatever order the
 * calls finish in, so a caller that numbers or registers results keeps the
 * order a serial loop had.
 *
 * Failure: the first rejection stops new calls from starting; the ones
 * already running are awaited (nothing is left writing behind the caller's
 * back), then the promise rejects with that first error. Callers that want
 * to skip a failed item catch inside `fn`, as the PowerPoint importer does.
 */

export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`mapConcurrent: limit must be a positive integer, got ${limit}`)
  }
  const results = new Array<R>(items.length)
  let next = 0
  let failure: { error: unknown } | null = null

  const worker = async (): Promise<void> => {
    while (failure === null && next < items.length) {
      const i = next++
      try {
        results[i] = await fn(items[i]!, i)
      } catch (error) {
        failure ??= { error }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  if (failure !== null) throw (failure as { error: unknown }).error
  return results
}

/**
 * A weighted semaphore: `run(weight, fn)` waits until `weight` fits in what
 * is left of `capacity`, then runs `fn`. A task heavier than the whole
 * capacity still runs — alone, once nothing else holds a share — so nothing
 * waits forever. Waiters are served first come, first served: a heavy task at
 * the head is not overtaken by light ones behind it.
 *
 * Bounds memory rather than calls: `media/storedImageLimits.ts` caps the
 * pixels of oversize pictures being decoded at once in the whole process,
 * while the importer's `mapConcurrent` keeps the light ones flowing.
 */
export class WeightedSemaphore {
  private inUse = 0
  private readonly queue: Array<{ weight: number; start: () => void }> = []

  constructor(readonly capacity: number) {
    if (!(capacity > 0)) {
      throw new RangeError(`WeightedSemaphore: capacity must be > 0, got ${capacity}`)
    }
  }

  async run<R>(weight: number, fn: () => Promise<R>): Promise<R> {
    await new Promise<void>((start) => {
      this.queue.push({ weight, start })
      this.drain()
    })
    try {
      return await fn()
    } finally {
      this.inUse -= weight
      this.drain()
    }
  }

  private drain(): void {
    while (this.queue.length > 0) {
      const head = this.queue[0]!
      if (this.inUse > 0 && this.inUse + head.weight > this.capacity) return
      this.queue.shift()
      this.inUse += head.weight
      head.start()
    }
  }
}
