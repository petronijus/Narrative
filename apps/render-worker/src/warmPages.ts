/**
 * warmPages.ts — render pages kept open between jobs.
 *
 * Loading the web app is most of a job (seconds on the production VM); the
 * slides themselves take a fraction of a second once it runs. Two ways a kept
 * page saves that:
 *
 *   - a render session's own page: the server keeps one render token per
 *     person and deck for a few minutes (apps/server/src/render/sessions.ts),
 *     and the next job of that token and deck switches slides in place on
 *     the page its last job left (`take`);
 *   - a spare: a job of any other session takes the oldest idle page instead
 *     (`takeSpare`) and render.ts recycles it — the old document unloaded,
 *     the origin's storage and cookies cleared, then the new deck's URL
 *     loaded in the same tab. The page keeps its renderer process (and the
 *     code it compiled), never anything of the deck or token before.
 *
 * Bounded: at most `max` pages (the oldest goes first), each closed after
 * `idleMs` without a job, and with the browser (a closed context drops out by
 * itself). A page is only kept after a job that succeeded — after a failure
 * its state is unknown, and it is closed. `closeAll` starts a new generation:
 * a page opened before it (one a running job holds while its browser is being
 * retired) is closed when that job ends instead of being kept.
 */

import type { BrowserContext, Page } from 'playwright-core'

export interface WarmPage {
  /** The page's document (`renderPageName`): a token's page serves no other. */
  name: string
  context: BrowserContext
  page: Page
  /** The page's errors since the job that is using it started. */
  pageErrors: string[]
  /** `WarmPages.generation` when the page was opened. */
  generation: number
}

interface Entry extends WarmPage {
  token: string
  idleTimer: ReturnType<typeof setTimeout> | null
}

export class WarmPages {
  /** Idle pages by token, oldest first (a Map keeps insertion order). */
  private readonly pages = new Map<string, Entry>()
  /** Contexts that already drop out of the map when they close (one listener each, ever). */
  private readonly watched = new WeakSet<BrowserContext>()
  private gen = 0

  constructor(
    private readonly opts: { max: number; idleMs: number; log: (message: string) => void },
  ) {}

  /** The generation a page opened now belongs to. */
  get generation(): number {
    return this.gen
  }

  /** The page kept for `token` (and its document `name`), taken out until it is kept again. */
  take(token: string, name: string): WarmPage | undefined {
    const entry = this.pages.get(token)
    if (entry === undefined) return undefined
    if (entry.name !== name) return undefined
    this.remove(token, entry)
    if (entry.page.isClosed()) {
      void entry.context.close().catch(() => undefined)
      return undefined
    }
    entry.pageErrors.length = 0
    return this.bare(entry)
  }

  /**
   * The oldest idle page of any session, taken out for a job of another
   * one: the caller recycles it before anything of its own job reaches it.
   */
  takeSpare(): WarmPage | undefined {
    for (const [token, entry] of this.pages) {
      this.remove(token, entry)
      if (entry.page.isClosed()) {
        void entry.context.close().catch(() => undefined)
        continue
      }
      entry.pageErrors.length = 0
      return this.bare(entry)
    }
    return undefined
  }

  /** Keep `page` for the next job of `token`; the oldest page goes past the limit. */
  keep(token: string, page: WarmPage): void {
    if (this.opts.max === 0 || page.page.isClosed() || page.generation !== this.gen) {
      void page.context.close().catch(() => undefined)
      return
    }
    const previous = this.pages.get(token)
    if (previous !== undefined) this.drop(token, 'replaced by a newer page of the session')
    const idleTimer = setTimeout(() => this.drop(token, 'idle'), this.opts.idleMs)
    idleTimer.unref()
    this.pages.set(token, { ...page, token, idleTimer })
    if (!this.watched.has(page.context)) {
      this.watched.add(page.context)
      page.context.once('close', () => {
        for (const [key, entry] of this.pages) {
          if (entry.context !== page.context) continue
          this.remove(key, entry)
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

  /** Close the oldest idle page (memory for a job); false when none is kept. */
  evictOldest(why: string): boolean {
    const oldest = this.pages.keys().next().value
    if (oldest === undefined) return false
    this.drop(oldest, why)
    return true
  }

  /** Close every kept page and start a new generation (the browser is going). */
  closeAll(why: string): void {
    this.gen += 1
    for (const token of [...this.pages.keys()]) this.drop(token, why)
  }

  private remove(token: string, entry: Entry): void {
    this.pages.delete(token)
    if (entry.idleTimer !== null) clearTimeout(entry.idleTimer)
  }

  private drop(token: string, why: string): void {
    const entry = this.pages.get(token)
    if (entry === undefined) return
    this.remove(token, entry)
    void entry.context.close().catch(() => undefined)
    this.opts.log(`page for ${entry.name} closed (${why})`)
  }

  /** The page without the pool's own fields: the token never travels with it. */
  private bare(entry: Entry): WarmPage {
    return {
      name: entry.name,
      context: entry.context,
      page: entry.page,
      pageErrors: entry.pageErrors,
      generation: entry.generation,
    }
  }
}
