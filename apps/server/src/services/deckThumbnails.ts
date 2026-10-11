/**
 * services/deckThumbnails.ts — the card picture of a deck nobody has open
 * follows its changes (agentic A3.5, docs/plans/a3-render-worker.md).
 *
 * The editor keeps the card current while someone edits (SlidesPanel uploads
 * the first slide it rendered). A deck changed by an agent, an import or a
 * server-side write while no editor has it open kept a stale card, or none.
 * So after every stored snapshot of a deck (PostgresPersistence
 * `onDeckStored`), once the deck has been quiet for `THUMBNAIL_QUIET_MS`:
 *
 *   - a signed-in editor has it open → nothing (their browser uploads it);
 *   - otherwise the render worker draws the first slide as the card
 *     (services/render.ts `backgroundThumbnail`): as the deck's owner, in a
 *     render lane of its own (its own render session and request budget,
 *     and a page it does not keep warm), behind every person's job and
 *     outside anyone's in-flight share — unless the first slide is as it was
 *     when the card was last drawn (render/cardState.ts), and not stored if
 *     an editor opened the deck while it was being drawn.
 *
 * Kept from crowding the renderer: one card at a time; a deck is drawn at
 * most once per `MIN_INTERVAL_MS` (a deck edited every few seconds waits);
 * the decks waiting take turns by owner, so one account's flood of decks
 * cannot hold everyone else's cards back (`MAX_PENDING_PER_OWNER` bounds
 * only the memory a flood takes). A busy or unavailable renderer (RendererBusyError) is tried again
 * after `THUMBNAIL_RETRY_MS`, up to `MAX_ATTEMPTS`; a card that failed on its
 * page is logged and waits for the deck's next change.
 */

import { eq } from 'drizzle-orm'
import { decks } from '../db/schema.js'
import { deckHasSignedInEditor } from '../hocuspocus/connections.js'
import { createRenderService, RendererBusyError, type RenderServiceDeps } from './render.js'

export const THUMBNAIL_QUIET_MS = 10_000
export const THUMBNAIL_RETRY_MS = 60_000
export const MIN_INTERVAL_MS = 60_000
/** Only a memory bound: owners take turns, so a long line holds back no one else. */
export const MAX_PENDING_PER_OWNER = 500
const MAX_ATTEMPTS = 3
/** Decks whose last drawing time is remembered (oldest forgotten first). */
const MAX_REMEMBERED = 2_000

export interface DeckThumbnailScheduler {
  /** A snapshot of the deck was stored. */
  deckStored(deckId: string): void
  /** Forget every pending card (shutdown, tests). */
  stop(): void
  /** Test helper: until nothing is pending or drawing. */
  idle(): Promise<void>
}

export interface DeckThumbnailSchedulerDeps extends RenderServiceDeps {
  quietMs?: number
  retryMs?: number
  minIntervalMs?: number
  /** Defaults to the live sync server's connections. */
  hasSignedInEditor?: (deckId: string) => boolean
  /** Defaults to the render service built from these deps. */
  render?: Pick<ReturnType<typeof createRenderService>, 'backgroundThumbnail'>
  /** The deck's owner, or null for a deck that is gone (defaults to the deck row). */
  ownerOf?: (deckId: string) => Promise<string | null>
}

export function createDeckThumbnailScheduler(
  deps: DeckThumbnailSchedulerDeps,
): DeckThumbnailScheduler {
  const quietMs = deps.quietMs ?? THUMBNAIL_QUIET_MS
  const retryMs = deps.retryMs ?? THUMBNAIL_RETRY_MS
  const minIntervalMs = deps.minIntervalMs ?? MIN_INTERVAL_MS
  const now = deps.now ?? Date.now
  const hasSignedInEditor = deps.hasSignedInEditor ?? deckHasSignedInEditor
  const render = deps.render ?? createRenderService(deps)
  const ownerOf =
    deps.ownerOf ??
    (async (deckId: string) => {
      const [deck] = await deps.db
        .select({ ownerUserId: decks.ownerUserId })
        .from(decks)
        .where(eq(decks.id, deckId))
      return deck?.ownerUserId ?? null
    })

  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Decks waiting for their turn, by owner (owners in turn order), with their attempt. */
  const pending = new Map<string, Map<string, number>>()
  /** When each deck's card was last drawn. */
  const drawnAt = new Map<string, number>()
  let drawing: Promise<void> | null = null
  /** The deck being drawn now. */
  let drawingDeck: string | null = null
  /** Decks gone quiet whose owner is being looked up (queued once it is known). */
  const enqueuing = new Set<Promise<void>>()
  let stopped = false

  function arm(deckId: string, delayMs: number, attempt: number): void {
    const previous = timers.get(deckId)
    if (previous !== undefined) clearTimeout(previous)
    const timer = setTimeout(() => {
      timers.delete(deckId)
      const queued = enqueue(deckId, attempt).finally(() => enqueuing.delete(queued))
      enqueuing.add(queued)
    }, delayMs)
    timer.unref?.()
    timers.set(deckId, timer)
  }

  async function enqueue(deckId: string, attempt: number): Promise<void> {
    // Changed again while its card is being drawn: it waits its interval too.
    if (deckId === drawingDeck) {
      arm(deckId, minIntervalMs, attempt)
      return
    }
    const last = drawnAt.get(deckId)
    if (last !== undefined && now() - last < minIntervalMs) {
      arm(deckId, last + minIntervalMs - now(), attempt)
      return
    }
    let owner: string | null
    try {
      owner = await ownerOf(deckId)
    } catch (err) {
      deps.log.warn(
        { deckId, err: err instanceof Error ? err.message : String(err) },
        'deck card: owner lookup failed',
      )
      owner = null
    }
    if (owner === null || stopped) return
    const queue = pending.get(owner) ?? new Map<string, number>()
    if (!queue.has(deckId) && queue.size >= MAX_PENDING_PER_OWNER) {
      deps.log.warn({ deckId, owner }, 'deck card: too many waiting for this owner; skipped')
      return
    }
    queue.set(deckId, attempt)
    pending.set(owner, queue)
    pump()
  }

  /** The next deck: the first waiting of the owner whose turn it is (who then goes last). */
  function takeNext(): { owner: string; deckId: string; attempt: number } | null {
    const first = pending.entries().next()
    if (first.done === true) return null
    const [owner, queue] = first.value
    const [deckId, attempt] = queue.entries().next().value!
    queue.delete(deckId)
    pending.delete(owner)
    if (queue.size > 0) pending.set(owner, queue)
    return { owner, deckId, attempt }
  }

  async function draw(owner: string, deckId: string, attempt: number): Promise<void> {
    if (hasSignedInEditor(deckId)) return
    try {
      const outcome = await render.backgroundThumbnail({
        userId: owner,
        deckId,
        stillWanted: () => !hasSignedInEditor(deckId),
      })
      if (outcome.status === 'stored') {
        drawnAt.delete(deckId)
        drawnAt.set(deckId, now())
        if (drawnAt.size > MAX_REMEMBERED) drawnAt.delete(drawnAt.keys().next().value!)
      }
    } catch (err) {
      const retry = err instanceof RendererBusyError && attempt < MAX_ATTEMPTS
      deps.log.warn(
        { deckId, attempt, err: err instanceof Error ? err.message : String(err), retry },
        'deck card: drawing failed',
      )
      // A change meanwhile has armed its own timer; that one wins.
      if (retry && !stopped && !timers.has(deckId)) arm(deckId, retryMs, attempt + 1)
    }
  }

  function pump(): void {
    if (drawing !== null || stopped) return
    const next = takeNext()
    if (next === null) return
    drawingDeck = next.deckId
    drawing = draw(next.owner, next.deckId, next.attempt)
      .catch((err: unknown) => {
        deps.log.error(
          { deckId: next.deckId, err: err instanceof Error ? err.message : String(err) },
          'deck card: unexpected failure',
        )
      })
      .finally(() => {
        drawing = null
        drawingDeck = null
        pump()
      })
  }

  return {
    deckStored(deckId) {
      if (stopped) return
      arm(deckId, quietMs, 1)
    },
    stop() {
      stopped = true
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      pending.clear()
    },
    async idle() {
      // A queued deck starts drawing at once (pump), so nothing waits but these.
      while (drawing !== null || enqueuing.size > 0) {
        await Promise.all([drawing, ...enqueuing])
      }
    },
  }
}
