/**
 * warmPages.ts — render pages kept open between jobs, one per render session.
 *
 * Loading the web app is most of a job (seconds on the production VM); the
 * slides themselves take a fraction of a second once it runs. The server
 * keeps one render token per person and deck for a few minutes (a render
 * session, apps/server/src/services/render.ts), so the worker keeps the page
 * it opened with that token and the next job for the deck switches slides in
 * place.
 *
 * Bounded: at most `max` pages (the oldest goes first), each closed after
 * `idleMs` without a job, and with the browser (a closed context drops out by
 * itself). A page is only kept after a job that succeeded — after a failure
 * its state is unknown, and it is closed.
 */

import type { BrowserContext, Page } from 'playwright-core'

export interface WarmPage {
  deckId: string
  context: BrowserContext
  page: Page
  /** The page's errors since the job that is using it started. */
  pageErrors: string[]
}

interface Entry extends WarmPage {
  idleTimer: ReturnType<typeof setTimeout> | null
}

export class WarmPages {
  private readonly pages = new Map<string, Entry>()
  /** Contexts that already drop out of the map when they close (one listener each, ever). */
  private readonly watched = new WeakSet<BrowserContext>()

  constructor(
    private readonly opts: { max: number; idleMs: number; log: (message: string) => void },
  ) {}

  /** The page kept for `token` (and `deckId`), taken out until it is kept again. */
  take(token: string, deckId: string): WarmPage | undefined {
    const entry = this.pages.get(token)
    if (entry === undefined) return undefined
    this.pages.delete(token)
    if (entry.idleTimer !== null) clearTimeout(entry.idleTimer)
    if (entry.deckId !== deckId || entry.page.isClosed()) {
      void entry.context.close().catch(() => undefined)
      return undefined
    }
    entry.pageErrors.length = 0
    return entry
  }

  /** Keep `page` for the next job of `token`; the oldest page goes past the limit. */
  keep(token: string, page: WarmPage): void {
    if (this.opts.max === 0 || page.page.isClosed()) {
      void page.context.close().catch(() => undefined)
      return
    }
    const idleTimer = setTimeout(() => this.drop(token, 'idle'), this.opts.idleMs)
    idleTimer.unref()
    this.pages.set(token, { ...page, idleTimer })
    if (!this.watched.has(page.context)) {
      this.watched.add(page.context)
      page.context.once('close', () => {
        for (const [key, entry] of this.pages) {
          if (entry.context !== page.context) continue
          if (entry.idleTimer !== null) clearTimeout(entry.idleTimer)
          this.pages.delete(key)
        }
      })
    }
    while (this.pages.size > this.opts.max) {
      const oldest = this.pages.keys().next().value as string
      this.drop(oldest, 'room for another session')
    }
  }

  get size(): number {
    return this.pages.size
  }

  private drop(token: string, why: string): void {
    const entry = this.pages.get(token)
    if (entry === undefined) return
    this.pages.delete(token)
    if (entry.idleTimer !== null) clearTimeout(entry.idleTimer)
    void entry.context.close().catch(() => undefined)
    this.opts.log(`page for deck ${entry.deckId} closed (${why})`)
  }

  /** Close every kept page (the browser is going). */
  closeAll(why: string): void {
    for (const token of [...this.pages.keys()]) this.drop(token, why)
  }
}
