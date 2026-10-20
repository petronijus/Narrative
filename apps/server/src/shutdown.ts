/**
 * shutdown.ts — the order the server stops in (index.ts, on SIGTERM/SIGINT).
 *
 * What must not be lost goes first: the documents Hocuspocus holds with
 * edits not stored yet (its debounce, 2 s). Docker gives a container its
 * `stop_grace_period` (infra compose: 30 s for the server) before SIGKILL,
 * so nothing that may take long stands before them:
 *
 *   1. background work stops taking new work (deck thumbnails);
 *   2. started, not awaited: the PDF export worker lets go of its jobs at
 *      once (a running export is retried by the next process,
 *      render/pdfExportQueue.ts), and Fastify stops taking requests and lets
 *      those in flight finish (a PDF status read may wait up to 25 s) — at
 *      most `HTTP_CLOSE_BUDGET_MS`;
 *   3. the agent host closes its runs and lets go of the documents it holds,
 *      so they store and unload cleanly;
 *   4. Hocuspocus stores every document and closes;
 *   5. once 2. is over: the Postgres pool, then the queue connections.
 *
 * Every step is logged and its failure does not stop the next.
 */

/** How long in-flight HTTP requests get to finish once the server stops. */
export const HTTP_CLOSE_BUDGET_MS = 8_000

export interface ShutdownParts {
  stopBackground(): void
  stopPdfExports(): Promise<void>
  closeHttp(): Promise<void>
  closeAgent(): Promise<void>
  closeHocuspocus(): Promise<void>
  closePostgres(): Promise<void>
  closeQueues(): Promise<void>
  log: {
    info(message: string): void
    error(message: string, err: unknown): void
  }
}

export async function shutdownServer(
  parts: ShutdownParts,
  opts: { httpBudgetMs?: number } = {},
): Promise<void> {
  const step = async (name: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run()
      parts.log.info(`${name} closed`)
    } catch (err) {
      parts.log.error(`Error closing ${name}:`, err)
    }
  }
  try {
    parts.stopBackground()
  } catch (err) {
    parts.log.error('Error stopping background work:', err)
  }
  const budget = opts.httpBudgetMs ?? HTTP_CLOSE_BUDGET_MS
  const pdf = step('PDF export worker', parts.stopPdfExports)
  const http = step('Fastify', () => bounded(parts.closeHttp(), budget, 'Fastify'))
  await step('Agent host', parts.closeAgent)
  await step('Hocuspocus', parts.closeHocuspocus)
  await Promise.all([pdf, http])
  await step('Postgres pool', parts.closePostgres)
  await step('BullMQ queue connections', parts.closeQueues)
}

async function bounded(p: Promise<void>, ms: number, what: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} did not close within ${ms} ms; moving on`)),
          ms,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
